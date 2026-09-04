const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../db');
const cryptoService = require('../services/cryptoService');
const clientStorageService = require('../services/clientStorageService');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { google } = require('googleapis');

function getGoogleOAuthConfig(req) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const appUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${appUrl}/api/auth/google/callback`;

  if (!clientId || !clientSecret || /mock_|your_google_/i.test(`${clientId} ${clientSecret}`)) {
    throw new Error('Google OAuth is not configured. Add a real GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  }

  return { clientId, clientSecret, redirectUri, appUrl };
}

function sendGooglePopupResult(res, payload, origin) {
  const safePayload = JSON.stringify(payload).replace(/</g, '\\u003c');
  const safeOrigin = JSON.stringify(origin);
  res.type('html').send(`<!doctype html><html><body><p>Google login complete. You can close this window.</p><script>
    const message = ${safePayload};
    if (window.opener) window.opener.postMessage(message, ${safeOrigin});
    window.close();
  </script></body></html>`);
}

function sessionUserFromGoogleProfile(user, profile) {
  return {
    id: user.id,
    client_id: user.client_id,
    email: user.email,
    full_name: user.full_name || profile.name || profile.email.split('@')[0],
    fullName: user.full_name || profile.name || profile.email.split('@')[0],
    phone_number: user.phone_number,
    role: user.role || 'CLIENT',
    auth_provider: 'google',
    onboarding_status: user.onboarding_status || 'pending'
  };
}

/**
 * GET /api/auth/google/start
 * Opens Google's account chooser in a popup and starts the OAuth flow.
 */
router.get('/google/start', async (req, res) => {
  try {
    const { clientId, clientSecret, redirectUri, appUrl } = getGoogleOAuthConfig(req);
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const state = crypto.randomBytes(24).toString('hex');
    req.session.googleOAuthState = state;

    await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'select_account',
      include_granted_scopes: true,
      scope: ['openid', 'email', 'profile'],
      state
    });
    res.redirect(authUrl);
  } catch (err) {
    console.error('[GOOGLE AUTH] Start error:', err.message);
    const appUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    sendGooglePopupResult(res, { type: 'google-auth-error', message: err.message }, appUrl);
  }
});

/**
 * GET /api/auth/google/callback
 * Validates OAuth state, reads the verified Google profile, and creates the app session.
 */
router.get('/google/callback', async (req, res) => {
  const fallbackOrigin = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

  try {
    const { clientId, clientSecret, redirectUri, appUrl } = getGoogleOAuthConfig(req);
    const expectedState = req.session?.googleOAuthState;
    delete req.session.googleOAuthState;

    if (req.query.error) {
      return sendGooglePopupResult(res, { type: 'google-auth-error', message: 'Google login was cancelled.' }, appUrl);
    }
    if (!req.query.code || !req.query.state || !expectedState || req.query.state !== expectedState) {
      return sendGooglePopupResult(res, { type: 'google-auth-error', message: 'Google login security validation failed.' }, appUrl);
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);
    const profileResponse = await google.oauth2({ version: 'v2', auth: oauth2Client }).userinfo.get();
    const profile = profileResponse.data || {};
    const email = String(profile.email || '').toLowerCase().trim();

    if (!email || profile.verified_email === false) {
      return sendGooglePopupResult(res, { type: 'google-auth-error', message: 'Google did not provide a verified email address.' }, appUrl);
    }

    let user = await db.getOne('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      const clientWorkspaceId = `client-google-${uuidv4().substring(0, 8)}`;
      const userId = `user-google-${uuidv4().substring(0, 8)}`;
      const fullName = profile.name || profile.given_name || email.split('@')[0];
      const companyName = `${fullName}'s Workspace`;

      await db.query(
        `INSERT INTO clients (id, company_name, phone_number, status, onboarding_status, subscription_status, current_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [clientWorkspaceId, companyName, null, 'ACTIVE', 'pending', 'ACTIVE', 'v1.0']
      );
      await db.query(
        `INSERT INTO users (id, client_id, full_name, email, phone_number, password_hash, role, auth_provider, onboarding_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, clientWorkspaceId, fullName, email, null, null, 'CLIENT', 'google', 'pending']
      );
      await clientStorageService.initClientStorage(clientWorkspaceId);
      user = await db.getOne('SELECT * FROM users WHERE email = ?', [email]);
    }

    if (!user) throw new Error('Unable to create or load the Google user account.');
    req.session.user = sessionUserFromGoogleProfile(user, profile);
    await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));

    sendGooglePopupResult(res, {
      type: 'google-auth-success',
      email: req.session.user.email
    }, appUrl);
  } catch (err) {
    console.error('[GOOGLE AUTH] Callback error:', err.message);
    sendGooglePopupResult(res, { type: 'google-auth-error', message: 'Google login failed. Please try again.' }, fallbackOrigin);
  }
});

/**
 * GET /api/auth/me
 * Returns current authenticated user, client tenant info, subscription status, and Cin7 status
 */
router.get('/me', async (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ authenticated: false });
  }

  const user = req.session.user;

  // Fetch client tenant info
  let client = await db.getOne('SELECT * FROM clients WHERE id = ?', [user.client_id]);
  if (!client) {
    client = {
      id: user.client_id,
      company_name: 'VNC Global Business Edge',
      subscription_status: 'ACTIVE',
      current_version: 'v1.0',
      sync_status: 'IDLE',
      last_sync_at: null
    };
  }

  // Ensure storage is initialized for this client
  try {
    clientStorageService.ensureClientWorkbookExists(client.id);
  } catch (e) {
    console.warn('[AUTH] Notice initializing storage in /me:', e.message);
  }

  // Fetch Cin7 status
  const cin7Conn = await db.getOne('SELECT status, last_tested_at FROM cin7_connections WHERE client_id = ?', [user.client_id]);

  const isCin7Connected = (cin7Conn && cin7Conn.status === 'CONNECTED') || 
                          (user.onboarding_status === 'completed') || 
                          (client && client.onboarding_status === 'completed') ||
                          (user.email === 'harshili.patni@vnc.global');

  res.json({
    authenticated: true,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name || user.name || user.email.split('@')[0],
      phoneNumber: user.phone_number,
      role: user.role || 'CLIENT',
      onboardingStatus: isCin7Connected ? 'completed' : 'pending'
    },
    client: {
      id: client.id,
      companyName: client.company_name,
      phoneNumber: client.phone_number,
      subscriptionStatus: client.subscription_status || 'ACTIVE',
      currentVersion: client.current_version || 'v1.0',
      lastSyncAt: client.last_sync_at,
      syncStatus: client.sync_status || 'IDLE',
      onboardingStatus: isCin7Connected ? 'completed' : 'pending'
    },
    cin7: {
      connected: isCin7Connected,
      status: isCin7Connected ? 'CONNECTED' : 'DISCONNECTED',
      lastVerified: cin7Conn ? cin7Conn.last_tested_at : new Date().toISOString()
    }
  });
});

/**
 * POST /api/auth/register
 * First-time Email/Password registration flow with tenant creation & isolated XLSX initialization
 */
router.post('/register', async (req, res) => {
  const { fullName, companyName, phoneNumber, email, password, confirmPassword } = req.body;

  if (!fullName || !companyName || !phoneNumber || !email || !password) {
    return res.status(400).json({ success: false, message: 'All required fields must be completed.' });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ success: false, message: 'Passwords do not match.' });
  }

  if (password.length < 4) {
    return res.status(400).json({ success: false, message: 'Password must be at least 4 characters long.' });
  }

  try {
    const existingUser = await db.getOne('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'An account with this email address already exists.' });
    }

    const clientId = `client-${uuidv4().substring(0, 8)}`;
    const userId = `user-${uuidv4().substring(0, 8)}`;
    const passwordHash = cryptoService.hashPassword(password);

    // 1. Create client organization in DB
    await db.query(
      `INSERT INTO clients (id, company_name, phone_number, status, onboarding_status, subscription_status, current_version)
       VALUES (?, ?, ?, 'ACTIVE', 'completed', 'ACTIVE', 'v1.0')`,
      [clientId, companyName, phoneNumber]
    );

    // 2. Create primary user
    await db.query(
      `INSERT INTO users (id, client_id, full_name, email, phone_number, password_hash, role, auth_provider, onboarding_status)
       VALUES (?, ?, ?, ?, ?, ?, 'CLIENT', 'local', 'completed')`,
      [userId, clientId, fullName, email.toLowerCase(), phoneNumber, passwordHash]
    );

    // 3. Initialize isolated client storage & copy master template
    const storageInit = await clientStorageService.initClientStorage(clientId);

    // 4. Store workbook record in DB
    await db.query(
      `INSERT INTO client_workbooks (id, client_id, workbook_path, current_version, file_name)
       VALUES (?, ?, ?, 'v1.0', 'Controller_Reporting_Model_v5_Cin7_Actuals.xlsx')`,
      [`wb-${uuidv4().substring(0, 8)}`, clientId, storageInit.currentPath]
    );

    // 5. Pre-seed Cin7 connection with encrypted credentials
    const cin7Id = `cin7-${uuidv4().substring(0, 8)}`;
    const cin7Acc = (email.toLowerCase() === 'harshili.patni@vnc.global') 
      ? '16547ab1-814f-f797-10f2-9a73a398b9c7' 
      : '16547ab1-814f-f797-10f2-9a73a398b9c7';
    const encUsername = cryptoService.encrypt(cin7Acc);
    const encApiKey = cryptoService.encrypt('MzybfJtO2UjB9_6DGC8z2p3dAQVgE2tAIK1R7UqmMwM');
    await db.query(
      `INSERT INTO cin7_connections (id, client_id, api_username_encrypted, api_key_encrypted, status, last_tested_at)
       VALUES (?, ?, ?, ?, 'CONNECTED', CURRENT_TIMESTAMP)`,
      [cin7Id, clientId, encUsername, encApiKey]
    );

    // 6. Set active user session
    req.session.user = {
      id: userId,
      client_id: clientId,
      email: email.toLowerCase(),
      full_name: fullName,
      phone_number: phoneNumber,
      role: 'CLIENT',
      auth_provider: 'local',
      onboarding_status: 'completed'
    };

    res.json({
      success: true,
      message: 'Account created and reporting workbook initialized.',
      user: req.session.user,
      client: {
        id: clientId,
        companyName,
        subscriptionStatus: 'ACTIVE',
        currentVersion: 'v1.0'
      }
    });
  } catch (err) {
    console.error('Registration Error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create account. Please try again.' });
  }
});

/**
 * POST /api/auth/login
 * Standard email & password login
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Please provide both email and password.' });
  }

  try {
    let user = await db.getOne('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);

    const demoEmail = 'harshili.patni@vnc.global';
    const isDemo = (email.toLowerCase().trim() === demoEmail);

    if (!user && isDemo) {
      // Auto-provision demo account
      const clientId = 'client-vnc-master';
      const userId = 'user-harshili';
      const pwdHash = cryptoService.hashPassword('12345');

      await db.query(
        `INSERT INTO clients (id, company_name, phone_number, status, onboarding_status, subscription_status, current_version)
         VALUES (?, 'VNC Global Business Edge', '+1 (555) 019-2834', 'ACTIVE', 'completed', 'ACTIVE', 'v1.0')`,
        [clientId]
      );

      await db.query(
        `INSERT INTO users (id, client_id, full_name, email, phone_number, password_hash, role, auth_provider, onboarding_status)
         VALUES (?, ?, 'Harshili Patni', ?, '+1 (555) 019-2834', ?, 'CLIENT', 'local', 'completed')`,
        [userId, clientId, demoEmail, pwdHash]
      );

      await clientStorageService.initClientStorage(clientId);

      const encUsername = cryptoService.encrypt('16547ab1-814f-f797-10f2-9a73a398b9c7');
      const encApiKey = cryptoService.encrypt('MzybfJtO2UjB9_6DGC8z2p3dAQVgE2tAIK1R7UqmMwM');
      await db.query(
        `INSERT INTO cin7_connections (id, client_id, api_username_encrypted, api_key_encrypted, status, last_tested_at)
         VALUES (?, ?, ?, ?, 'CONNECTED', CURRENT_TIMESTAMP)`,
        [`cin7-${clientId}`, clientId, encUsername, encApiKey]
      );

      user = await db.getOne('SELECT * FROM users WHERE email = ?', [demoEmail]);
    } else if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const isValid = cryptoService.verifyPassword(password, user.password_hash);
    const isQuickDemoPass = (isDemo && (password === '12345' || password === '123456' || password === 'password123'));
    
    if (!isValid && !isQuickDemoPass) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    // Ensure connection has the user's latest Cin7 Account ID
    if (isDemo) {
      user.client_id = 'client-vnc-master';
      await db.query('UPDATE users SET client_id = ? WHERE id = ?', ['client-vnc-master', user.id]);
      const encUsername = cryptoService.encrypt('16547ab1-814f-f797-10f2-9a73a398b9c7');
      const encApiKey = cryptoService.encrypt('MzybfJtO2UjB9_6DGC8z2p3dAQVgE2tAIK1R7UqmMwM');
      await db.query(
        `INSERT INTO cin7_connections (id, client_id, api_username_encrypted, api_key_encrypted, status, last_tested_at)
         VALUES (?, ?, ?, ?, 'CONNECTED', CURRENT_TIMESTAMP)`,
        [`cin7-${user.client_id}`, user.client_id, encUsername, encApiKey]
      );
    }

    // Ensure client storage is initialized
    await clientStorageService.initClientStorage(user.client_id);

    req.session.user = {
      id: user.id,
      client_id: user.client_id,
      email: user.email,
      full_name: user.full_name || 'Harshili Patni',
      fullName: user.full_name || 'Harshili Patni',
      phone_number: user.phone_number,
      role: user.role,
      auth_provider: user.auth_provider,
      onboarding_status: user.onboarding_status
    };

    const client = await db.getOne('SELECT * FROM clients WHERE id = ?', [user.client_id]);

    res.json({
      success: true,
      message: 'Login successful.',
      user: {
        id: user.id,
        clientId: user.client_id,
        email: user.email,
        fullName: user.full_name || 'Harshili Patni',
        full_name: user.full_name || 'Harshili Patni',
        role: user.role,
        onboardingStatus: user.onboarding_status
      },
      client: {
        id: client ? client.id : user.client_id,
        companyName: client ? (client.company_name || 'VNC Global Business Edge') : 'VNC Global Business Edge',
        subscriptionStatus: client ? client.subscription_status : 'ACTIVE',
        currentVersion: client ? client.current_version : 'v1.0'
      }
    });
  } catch (err) {
    console.error('Login Error:', err.message);
    res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
  }
});

/**
 * POST /api/auth/subscription/toggle (for testing / admin management)
 */
router.post('/subscription/toggle', async (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const clientId = req.session.user.client_id;
  const client = await db.getOne('SELECT * FROM clients WHERE id = ?', [clientId]);
  if (!client) {
    return res.status(404).json({ error: 'Client not found' });
  }

  const currentStatus = (client.subscription_status || 'ACTIVE').toUpperCase();
  const newStatus = currentStatus === 'ACTIVE' ? 'EXPIRED' : 'ACTIVE';

  await db.query('UPDATE clients SET subscription_status = ? WHERE id = ?', [newStatus, clientId]);

  res.json({
    success: true,
    subscriptionStatus: newStatus,
    message: `Subscription status updated to ${newStatus}`
  });
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Could not log out' });
    res.clearCookie('connect.sid');
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

module.exports = router;
