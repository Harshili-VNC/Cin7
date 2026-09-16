const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../db');
const cryptoService = require('../services/cryptoService');
const googleTokenStore = require('../services/googleTokenStore');
const clientStorageService = require('../services/clientStorageService');
const subscriptionService = require('../services/subscriptionService');
const { authLimiter, registerLimiter, sensitiveOpLimiter } = require('../middleware/rateLimitMiddleware');
const { validateLoginInput, validateRegisterInput, validateEmail } = require('../middleware/validationMiddleware');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { google } = require('googleapis');

const oauthStateCache = new Map();
const authTicketCache = new Map();

// Periodic cleanup of expired tokens
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of oauthStateCache.entries()) {
    if (now - val.createdAt > 10 * 60 * 1000) oauthStateCache.delete(key);
  }
  for (const [key, val] of authTicketCache.entries()) {
    if (now - val.createdAt > 5 * 60 * 1000) authTicketCache.delete(key);
  }
}, 60 * 1000);

/**
 * Validates and resolves allowed application origin for Google OAuth redirect
 */
function getSafeOAuthOrigin(req) {
  const defaultAllowedOrigins = [
    'http://localhost:2029',
    'http://127.0.0.1:2029',
    'http://localhost:2121',
    'http://127.0.0.1:2121',
    'http://localhost:2005',
    'http://127.0.0.1:2005',
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ];

  if (process.env.APP_URL) {
    try {
      defaultAllowedOrigins.push(new URL(process.env.APP_URL).origin.toLowerCase());
    } catch (_) {}
  }

  const reqHost = req.get('host');
  const reqProtocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const candidateOrigin = `${reqProtocol}://${reqHost}`.toLowerCase();

  // Validate candidate origin
  const isAllowed = defaultAllowedOrigins.includes(candidateOrigin) ||
    /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/.test(candidateOrigin) ||
    /^http:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/.test(candidateOrigin);

  if (isAllowed) {
    return { protocol: reqProtocol, host: reqHost, origin: `${reqProtocol}://${reqHost}` };
  }

  // Fallback to configured APP_URL or localhost
  const fallbackUrl = process.env.APP_URL || 'http://localhost:2121';
  try {
    const parsed = new URL(fallbackUrl);
    return { protocol: parsed.protocol.replace(':', ''), host: parsed.host, origin: parsed.origin };
  } catch (_) {
    return { protocol: 'http', host: 'localhost:2121', origin: 'http://localhost:2121' };
  }
}

function getGoogleOAuthConfig(req) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const safeOrigin = getSafeOAuthOrigin(req);
  const appUrl = (process.env.APP_URL || safeOrigin.origin).replace(/\/$/, '');
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${appUrl}/api/auth/google/callback`;

  if (!clientId || !clientSecret || /mock_|your_google_/i.test(`${clientId} ${clientSecret}`)) {
    throw new Error('Google OAuth is not configured. Add a real GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  }

  return { clientId, clientSecret, redirectUri, appUrl, safeOrigin };
}

function sessionUserFromGoogleProfile(user, profile) {
  const isPending = !user.client_id;
  return {
    id: user.id,
    client_id: user.client_id || null,
    organization_id: user.client_id || null,
    email: user.email,
    full_name: user.full_name || profile.name || profile.email.split('@')[0],
    fullName: user.full_name || profile.name || profile.email.split('@')[0],
    phone_number: user.phone_number || null,
    role: user.role || 'ADMIN',
    platform_role: user.platform_role || 'USER',
    platformRole: user.platform_role || 'USER',
    auth_provider: 'google',
    onboarding_status: isPending ? 'pending_client_selection' : (user.onboarding_status || 'completed'),
    onboardingStatus: isPending ? 'pending_client_selection' : (user.onboarding_status || 'completed')
  };
}

const GOOGLE_AUTH_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive'
];

/**
 * GET /api/auth/google/start & /api/auth/google/connect
 * Starts Google OAuth standard web redirect flow with hardened state ticket.
 * Automatically requests Google Drive & Google Sheets scopes for seamless integration.
 */
router.get(['/google', '/google/start', '/google/connect', '/google/connect-sheets', '/google/login'], async (req, res) => {
  try {
    const { clientId, clientSecret, redirectUri, safeOrigin } = getGoogleOAuthConfig(req);
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const state = crypto.randomBytes(32).toString('hex');
    
    // Store originating host in cache strictly if validated
    oauthStateCache.set(state, {
      returnHost: safeOrigin.host,
      returnProtocol: safeOrigin.protocol,
      createdAt: Date.now()
    });

    if (req.session) {
      req.session.googleOAuthState = state;
      req.session.returnToHost = safeOrigin.host;
      await new Promise(resolve => req.session.save(() => resolve()));
    }

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent select_account',
      include_granted_scopes: true,
      scope: GOOGLE_AUTH_SCOPES,
      state
    });
    res.redirect(authUrl);
  } catch (err) {
    console.error('[GOOGLE AUTH] Start error:', err.message);
    res.redirect(`/?google_auth=error&msg=${encodeURIComponent(err.message)}`);
  }
});

/**
 * GET /api/auth/google/callback
 * Validates OAuth state, reads verified Google profile, finds or creates user, and establishes session.
 */
router.get('/google/callback', async (req, res) => {
  try {
    const { clientId, clientSecret, redirectUri, safeOrigin } = getGoogleOAuthConfig(req);
    const state = req.query.state;
    const cachedState = state ? oauthStateCache.get(state) : null;
    if (state) oauthStateCache.delete(state); // One-time state consumption

    const expectedState = req.session?.googleOAuthState;
    if (req.session) delete req.session.googleOAuthState;

    const returnHost = cachedState?.returnHost || req.session?.returnToHost || safeOrigin.host;
    const returnProtocol = cachedState?.returnProtocol || safeOrigin.protocol;

    if (req.query.error) {
      return res.redirect(`${returnProtocol}://${returnHost}/?google_auth=error&msg=` + encodeURIComponent('Google login was cancelled.'));
    }
    if (!req.query.code || !state || (!cachedState && state !== expectedState)) {
      return res.redirect(`${returnProtocol}://${returnHost}/?google_auth=error&msg=` + encodeURIComponent('Google login security validation failed. Please try again.'));
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);

    // Set once the tenant's client_id is resolved below; the 'tokens' event can fire
    // later (on auto-refresh), by which point this closure variable will be populated.
    let boundClientId = null;

    oauth2Client.on('tokens', (refreshedTokens) => {
      if (boundClientId) {
        googleTokenStore.mergeAndSaveClientGoogleTokens(boundClientId, refreshedTokens)
          .catch(e => console.warn('[GOOGLE AUTH] DB token refresh save error:', e.message));
      }
      try {
        const credPathCandidate1 = path.resolve(__dirname, '../../', process.env.GOOGLE_CREDENTIALS_PATH || '../cin7-sheets/oauth-credentials.json');
        const credPathCandidate2 = path.resolve(__dirname, '../../../cin7-sheets/oauth-credentials.json');
        const baseDir = fs.existsSync(credPathCandidate1) ? path.dirname(credPathCandidate1) : (fs.existsSync(credPathCandidate2) ? path.dirname(credPathCandidate2) : path.resolve(__dirname, '../../../cin7-sheets'));
        const tokenPath = path.join(baseDir, 'token.json');
        let current = {};
        if (fs.existsSync(tokenPath)) {
          try {
            const raw = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
            if (raw && raw.encrypted) {
              const decrypted = cryptoService.decrypt(raw.encrypted);
              if (decrypted) current = JSON.parse(decrypted);
            } else {
              current = raw;
            }
          } catch (_) {}
        }
        const merged = { ...current, ...refreshedTokens };
        const encryptedTokens = cryptoService.encrypt(JSON.stringify(merged));
        fs.writeFileSync(tokenPath, JSON.stringify({ encrypted: encryptedTokens }, null, 2));
        console.log(`[GOOGLE AUTH] ✅ Refreshed Google tokens encrypted and saved to: ${tokenPath}`);
      } catch (refreshErr) {
        console.warn('[GOOGLE AUTH] Warning saving refreshed tokens:', refreshErr.message);
      }
    });

    const profileResponse = await google.oauth2({ version: 'v2', auth: oauth2Client }).userinfo.get();
    const profile = profileResponse.data || {};
    const email = String(profile.email || '').toLowerCase().trim();

    if (!email || profile.verified_email === false) {
      return res.redirect(`${returnProtocol}://${returnHost}/?google_auth=error&msg=` + encodeURIComponent('Google did not provide a verified email address.'));
    }

    // Automatically persist fresh Google OAuth tokens (with Drive & Sheets access) to token.json
    try {
      const credPathCandidate1 = path.resolve(__dirname, '../../', process.env.GOOGLE_CREDENTIALS_PATH || '../cin7-sheets/oauth-credentials.json');
      const credPathCandidate2 = path.resolve(__dirname, '../../../cin7-sheets/oauth-credentials.json');
      const baseDir = fs.existsSync(credPathCandidate1) ? path.dirname(credPathCandidate1) : (fs.existsSync(credPathCandidate2) ? path.dirname(credPathCandidate2) : path.resolve(__dirname, '../../../cin7-sheets'));
      
      if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
      }
      const tokenPath = path.join(baseDir, 'token.json');
      const encryptedTokens = cryptoService.encrypt(JSON.stringify(tokens));
      fs.writeFileSync(tokenPath, JSON.stringify({ encrypted: encryptedTokens }, null, 2));
      console.log(`[GOOGLE AUTH] ✅ Saved encrypted Google tokens to: ${tokenPath}`);
    } catch (saveTokenErr) {
      console.warn('[GOOGLE AUTH] Warning saving token.json:', saveTokenErr.message);
    }

    // 1. Get Google email & Find user by email
    let user = await db.getOne('SELECT * FROM users WHERE email = ?', [email]);
    
    // 2. If user does NOT exist, create with client_id = NULL and onboarding_status = 'pending_client_selection'
    if (!user) {
      const userId = `user-google-${uuidv4().substring(0, 8)}`;
      const fullName = profile.name || profile.given_name || email.split('@')[0];

      await db.query(
        `INSERT INTO users (id, client_id, full_name, email, phone_number, password_hash, role, platform_role, status, auth_provider, onboarding_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, null, fullName, email, null, null, 'ADMIN', 'USER', 'ACTIVE', 'google', 'pending_client_selection']
      );

      user = await db.getOne('SELECT * FROM users WHERE email = ?', [email]);
    }

    if (!user) throw new Error('Unable to create or load the Google user account.');

    // Persist tokens to the database, scoped to the tenant, so they survive
    // redeploys. Pending users (no client_id yet) fall back to the session-
    // carried token until they finish workspace setup (see /setup-workspace).
    boundClientId = user.client_id || null;
    if (boundClientId) {
      await googleTokenStore.saveClientGoogleTokens(boundClientId, tokens);
    }

    const sessionUserData = sessionUserFromGoogleProfile(user, profile);
    // Store only the encrypted token reference in session — never plaintext OAuth tokens
    sessionUserData.googleTokensEncrypted = cryptoService.encrypt(JSON.stringify(tokens));

    // Session regeneration for session fixation protection
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) return reject(err);
        req.session.user = sessionUserData;
        req.session.googleTokensEncrypted = sessionUserData.googleTokensEncrypted;
        req.session.save(saveErr => saveErr ? reject(saveErr) : resolve());
      });
    });

    if (returnHost && returnHost !== req.get('host')) {
      const ticket = crypto.randomBytes(32).toString('hex');
      authTicketCache.set(ticket, {
        user: sessionUserData,
        createdAt: Date.now()
      });
      return res.redirect(`${returnProtocol}://${returnHost}/api/auth/google/consume-ticket?ticket=${ticket}`);
    }

    res.redirect('/?google_auth=success');
  } catch (err) {
    console.error('[GOOGLE AUTH] Callback error:', err.message);
    res.redirect('/?google_auth=error&msg=' + encodeURIComponent('Google login failed: ' + err.message));
  }
});

/**
 * GET /api/auth/google/consume-ticket
 * Exchanges one-time ticket from cross-host OAuth callback into a local session cookie
 */
router.get('/google/consume-ticket', async (req, res) => {
  try {
    const { ticket } = req.query;
    if (!ticket || !authTicketCache.has(ticket)) {
      return res.redirect('/?google_auth=error&msg=' + encodeURIComponent('Login session expired. Please sign in again.'));
    }

    const ticketData = authTicketCache.get(ticket);
    authTicketCache.delete(ticket); // One-time use

    if (Date.now() - ticketData.createdAt > 2 * 60 * 1000) {
      return res.redirect('/?google_auth=error&msg=' + encodeURIComponent('Login session timed out. Please try again.'));
    }

    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) return reject(err);
        req.session.user = ticketData.user;
        req.session.save(saveErr => saveErr ? reject(saveErr) : resolve());
      });
    });

    res.redirect('/?google_auth=success');
  } catch (err) {
    console.error('[GOOGLE AUTH] Ticket consumption error:', err.message);
    res.redirect('/?google_auth=error&msg=' + encodeURIComponent('Failed to finalize login.'));
  }
});

/**
 * GET /api/auth/available-clients
 * Returns the list of active existing client workspaces for first-time onboarding.
 */
router.get('/available-clients', async (req, res) => {
  try {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const rows = await db.getAll("SELECT id, company_name, phone_number, status, current_version FROM clients WHERE status = 'ACTIVE'");
    const clients = (rows || []).map(c => ({
      id: c.id,
      companyName: c.company_name || c.name || c.id,
      name: c.company_name || c.name || c.id,
      status: c.status,
      phoneNumber: c.phone_number,
      currentVersion: c.current_version || 'v1.0'
    }));

    res.json({
      success: true,
      clients
    });
  } catch (err) {
    console.error('[AUTH] Error fetching available clients:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve available client workspaces.' });
  }
});

/**
 * POST /api/auth/setup-workspace
 * Creates new client organization for first-time Google user without pre-seeded credentials.
 */
router.post('/setup-workspace', async (req, res) => {
  try {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ success: false, message: 'Authentication required. Please sign in again.' });
    }

    const { companyName, fullName, phoneNumber, timezone, existingClientId } = req.body;
    const sessionUser = req.session.user;
    const userEmail = sessionUser.email;
    const userId = sessionUser.id;

    let clientId = existingClientId ? String(existingClientId).trim() : null;
    let client = null;

    if (clientId) {
      client = await db.getOne('SELECT * FROM clients WHERE id = ?', [clientId]);
      if (!client) {
        return res.status(400).json({ success: false, message: `No workspace found with ID "${clientId}".` });
      }
      if (client.status !== 'ACTIVE') {
        return res.status(400).json({ success: false, message: 'The specified workspace is inactive.' });
      }
    } else {
      if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
        return res.status(400).json({ success: false, message: 'Please enter your Company / Organization name.' });
      }

      const cleanCompanyName = companyName.trim();
      const cleanPhone = (phoneNumber && typeof phoneNumber === 'string') ? phoneNumber.trim() : null;
      const cleanTimezone = timezone || 'Asia/Kolkata';

      clientId = `client-${uuidv4().substring(0, 8)}`;

      // 1. Create client organization in database
      await db.query(
        `INSERT INTO clients (id, company_name, phone_number, status, onboarding_status, subscription_status, current_version, timezone)
         VALUES (?, ?, ?, 'ACTIVE', 'pending', 'ACTIVE', 'v1.0', ?)`,
        [clientId, cleanCompanyName, cleanPhone, cleanTimezone]
      );

      // 2. Initialize isolated client storage & reporting workbook
      try {
        await clientStorageService.initClientStorage(clientId);
      } catch (e) {
        console.warn('[AUTH] Storage init notice:', e.message);
      }

      // 3. Create trial subscription
      await subscriptionService.createTrialSubscription(clientId, 'PROFESSIONAL', 14);

      client = await db.getOne('SELECT * FROM clients WHERE id = ?', [clientId]);
    }

    // If this user signed in via Google before a client_id existed, their tokens were
    // only held in the session; persist them to the now-known tenant so they survive
    // redeploys and future background syncs can use them.
    if (sessionUser.googleTokensEncrypted) {
      try {
        const decrypted = cryptoService.decrypt(sessionUser.googleTokensEncrypted);
        if (decrypted) {
          await googleTokenStore.saveClientGoogleTokens(clientId, JSON.parse(decrypted));
        }
      } catch (e) {
        console.warn('[AUTH] Notice persisting Google tokens on workspace setup:', e.message);
      }
    }

    const cleanFullName = (fullName && typeof fullName === 'string' && fullName.trim()) ? fullName.trim() : (sessionUser.full_name || userEmail.split('@')[0]);
    const cleanPhone = (phoneNumber && typeof phoneNumber === 'string') ? phoneNumber.trim() : sessionUser.phone_number;

    // Update user in DB
    if (userId) {
      await db.query(
        `UPDATE users SET client_id = ?, full_name = ?, phone_number = ?, onboarding_status = ? WHERE id = ?`,
        [clientId, cleanFullName, cleanPhone, 'pending', userId]
      );
    }
    if (userEmail) {
      await db.query(
        `UPDATE users SET client_id = ?, full_name = ?, phone_number = ?, onboarding_status = ? WHERE email = ?`,
        [clientId, cleanFullName, cleanPhone, 'pending', userEmail]
      );
    }

    // Update session
    req.session.user.client_id = clientId;
    req.session.user.organization_id = clientId;
    req.session.user.full_name = cleanFullName;
    req.session.user.fullName = cleanFullName;
    req.session.user.phone_number = cleanPhone;
    req.session.user.onboarding_status = 'pending';
    req.session.user.onboardingStatus = 'pending';
    await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));

    res.json({
      success: true,
      message: `Workspace "${client?.company_name || cleanFullName + '\'s Workspace'}" setup successfully.`,
      client: {
        id: clientId,
        companyName: client?.company_name,
        status: client?.status || 'ACTIVE',
        subscriptionStatus: client?.subscription_status || 'ACTIVE'
      }
    });
  } catch (err) {
    console.error('[AUTH] Setup workspace error:', err);
    res.status(500).json({ success: false, message: 'Failed to set up workspace. Please try again.' });
  }
});

/**
 * POST /api/auth/switch-client
 * POST /api/auth/select-client
 * Authorized client switching: Strictly verifies user permission before switching active tenant context.
 */
router.post(['/switch-client', '/select-client'], async (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }

  const targetClientId = (req.body.targetClientId || req.body.clientId || '').toString().trim();
  if (!targetClientId) {
    return res.status(400).json({ success: false, message: 'Target client ID is required.' });
  }

  const sessionUser = req.session.user;

  try {
    const targetClient = await db.getOne('SELECT * FROM clients WHERE id = ?', [targetClientId]);
    if (!targetClient) {
      return res.status(404).json({ success: false, message: 'Target organization does not exist.' });
    }

    const platformRole = (sessionUser.platform_role || sessionUser.platformRole || 'USER').toUpperCase();
    const isSuperAdmin = platformRole === 'SUPER_ADMIN';

    // Authorization verification: SUPER_ADMIN can switch to any active client; regular users can only switch if they have a user record in that client
    if (!isSuperAdmin) {
      const membership = await db.getOne('SELECT id FROM users WHERE email = ? AND client_id = ? AND status = ?', [sessionUser.email.toLowerCase(), targetClientId, 'ACTIVE']);
      if (!membership && sessionUser.client_id !== targetClientId) {
        return res.status(403).json({ success: false, message: 'You are not authorized to access this organization.' });
      }
    }

    // Update server-side session context
    req.session.user.client_id = targetClientId;
    req.session.user.clientId = targetClientId;
    req.session.user.organization_id = targetClientId;
    await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));

    res.json({
      success: true,
      message: `Active organization switched to ${targetClient.company_name}`,
      clientId: targetClient.id,
      client: {
        id: targetClient.id,
        companyName: targetClient.company_name,
        status: targetClient.status
      }
    });
  } catch (err) {
    console.error('[AUTH SWITCH CLIENT ERROR]', err.message);
    res.status(500).json({ success: false, message: 'Failed to switch organization.' });
  }
});

/**
 * GET /api/auth/me
 * Returns current authenticated user state and client tenant info.
 */
router.get('/me', async (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ authenticated: false });
  }

  const sessionUser = req.session.user;
  const dbUser = (await db.getOne('SELECT * FROM users WHERE email = ?', [sessionUser.email])) || sessionUser;

  if (!dbUser.client_id) {
    const normalizedRole = (dbUser.role === 'CLIENT' || !dbUser.role) ? 'ADMIN' : dbUser.role.toUpperCase();
    const normalizedPlatformRole = (dbUser.platform_role || dbUser.platformRole || 'USER').toUpperCase();

    return res.json({
      authenticated: true,
      needsClientSelection: true,
      user: {
        id: dbUser.id,
        email: dbUser.email,
        fullName: dbUser.full_name || dbUser.name || dbUser.email.split('@')[0],
        full_name: dbUser.full_name || dbUser.name || dbUser.email.split('@')[0],
        client_id: null,
        clientId: null,
        organizationId: null,
        phoneNumber: dbUser.phone_number || null,
        role: normalizedRole,
        platformRole: normalizedPlatformRole,
        platform_role: normalizedPlatformRole,
        onboardingStatus: 'pending_client_selection',
        onboarding_status: 'pending_client_selection'
      }
    });
  }

  let client = await db.getOne('SELECT * FROM clients WHERE id = ?', [dbUser.client_id]);
  if (!client) {
    client = {
      id: dbUser.client_id,
      company_name: 'VNC Client Workspace',
      timezone: 'Asia/Kolkata',
      subscription_status: 'ACTIVE',
      current_version: 'v1.0',
      sync_status: 'IDLE',
      last_sync_at: null
    };
  }

  try {
    clientStorageService.ensureClientWorkbookExists(client.id);
  } catch (e) {
    console.warn('[AUTH] Storage notice in /me:', e.message);
  }

  const cin7Conn = await db.getOne('SELECT status, last_tested_at FROM cin7_connections WHERE client_id = ?', [dbUser.client_id]);
  const isCin7Connected = Boolean(cin7Conn && cin7Conn.status === 'CONNECTED');

  const latestSyncRun = await db.getOne(
    "SELECT records_processed, duration_ms, status, completed_at FROM sync_runs WHERE client_id = ? AND status = 'COMPLETED' ORDER BY created_at DESC",
    [dbUser.client_id]
  );

  const normalizedRole = (dbUser.role === 'CLIENT' || !dbUser.role) ? 'ADMIN' : dbUser.role.toUpperCase();
  const normalizedPlatformRole = (dbUser.platform_role || dbUser.platformRole || 'USER').toUpperCase();

  res.json({
    authenticated: true,
    needsClientSelection: false,
    user: {
      id: dbUser.id,
      email: dbUser.email,
      fullName: dbUser.full_name || dbUser.name || dbUser.email.split('@')[0],
      full_name: dbUser.full_name || dbUser.name || dbUser.email.split('@')[0],
      phoneNumber: dbUser.phone_number,
      role: normalizedRole,
      platformRole: normalizedPlatformRole,
      platform_role: normalizedPlatformRole,
      organizationId: dbUser.client_id,
      clientId: dbUser.client_id,
      client_id: dbUser.client_id,
      onboardingStatus: isCin7Connected ? 'completed' : 'pending',
      onboarding_status: isCin7Connected ? 'completed' : 'pending'
    },
    organization: {
      id: client.id,
      companyName: client.company_name,
      name: client.company_name,
      timezone: client.timezone || 'Asia/Kolkata',
      subscriptionStatus: client.subscription_status || 'ACTIVE',
      currentVersion: client.current_version || 'v1.0',
      lastSyncAt: client.last_sync_at || latestSyncRun?.completed_at,
      recordsSynced: latestSyncRun ? (Number(latestSyncRun.records_processed) || 0) : 0,
      syncStatus: client.sync_status || 'IDLE',
      onboardingStatus: isCin7Connected ? 'completed' : 'pending'
    },
    client: {
      id: client.id,
      companyName: client.company_name,
      phoneNumber: client.phone_number,
      subscriptionStatus: client.subscription_status || 'ACTIVE',
      currentVersion: client.current_version || 'v1.0',
      lastSyncAt: client.last_sync_at || latestSyncRun?.completed_at,
      recordsSynced: latestSyncRun ? (Number(latestSyncRun.records_processed) || 0) : 0,
      syncStatus: client.sync_status || 'IDLE',
      onboardingStatus: isCin7Connected ? 'completed' : 'pending'
    },
    cin7: {
      connected: isCin7Connected,
      status: isCin7Connected ? 'CONNECTED' : 'DISCONNECTED',
      lastVerified: cin7Conn ? cin7Conn.last_tested_at : null
    }
  });
});

/**
 * POST /api/auth/register
 * First-time Email/Password registration flow with tenant creation & isolated XLSX initialization.
 * Zero hardcoded Cin7 credentials.
 */
router.post('/register', registerLimiter, validateRegisterInput, async (req, res) => {
  const { fullName, companyName, phoneNumber, email, password, confirmPassword } = req.body;

  if (confirmPassword !== undefined && password !== confirmPassword) {
    return res.status(400).json({ success: false, message: 'Passwords do not match.' });
  }

  const cleanEmail = email.toLowerCase().trim();

  try {
    const existingUser = await db.getOne('SELECT * FROM users WHERE email = ?', [cleanEmail]);
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'An account with this email address already exists.' });
    }

    const clientId = `client-${uuidv4().substring(0, 8)}`;
    const userId = `user-${uuidv4().substring(0, 8)}`;
    const passwordHash = cryptoService.hashPassword(password);

    // 1. Create client organization in DB
    await db.query(
      `INSERT INTO clients (id, company_name, phone_number, status, onboarding_status, subscription_status, current_version)
       VALUES (?, ?, ?, 'ACTIVE', 'pending', 'ACTIVE', 'v1.0')`,
      [clientId, companyName, phoneNumber || null]
    );

    // 2. Create primary user with ADMIN role and USER platform_role
    await db.query(
      `INSERT INTO users (id, client_id, full_name, email, phone_number, password_hash, role, platform_role, status, auth_provider, onboarding_status)
       VALUES (?, ?, ?, ?, ?, ?, 'ADMIN', 'USER', 'ACTIVE', 'local', 'pending')`,
      [userId, clientId, fullName, cleanEmail, phoneNumber || null, passwordHash]
    );

    // 3. Initialize isolated client storage & copy master template
    const storageInit = await clientStorageService.initClientStorage(clientId);

    // 4. Create trial subscription for the organization
    await subscriptionService.createTrialSubscription(clientId, 'PROFESSIONAL', 14);

    // 5. Store workbook record in DB
    await db.query(
      `INSERT INTO client_workbooks (id, client_id, workbook_path, current_version, file_name)
       VALUES (?, ?, ?, 'v1.0', 'Controller_Reporting_Model_v5_Cin7_Actuals.xlsx')`,
      [`wb-${uuidv4().substring(0, 8)}`, clientId, storageInit.currentPath]
    );

    // 6. Establish secure session with session regeneration
    const sessionData = {
      id: userId,
      client_id: clientId,
      organization_id: clientId,
      email: cleanEmail,
      full_name: fullName,
      fullName: fullName,
      phone_number: phoneNumber || null,
      role: 'ADMIN',
      platform_role: 'USER',
      platformRole: 'USER',
      auth_provider: 'local',
      onboarding_status: 'pending',
      onboardingStatus: 'pending'
    };

    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) return reject(err);
        req.session.user = sessionData;
        req.session.save(saveErr => saveErr ? reject(saveErr) : resolve());
      });
    });

    res.json({
      success: true,
      message: 'Account created and reporting workbook initialized.',
      user: sessionData,
      organization: {
        id: clientId,
        companyName,
        name: companyName,
        subscriptionStatus: 'ACTIVE',
        currentVersion: 'v1.0'
      },
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
 * Standard email & password login. Strictly requires valid PBKDF2-HMAC-SHA512 password verification.
 * Zero demo account auto-provisioning and zero password bypasses.
 */
router.post('/login', authLimiter, validateLoginInput, async (req, res) => {
  const { email, password } = req.body;
  const cleanEmail = email.toLowerCase().trim();

  try {
    const user = await db.getOne('SELECT * FROM users WHERE email = ?', [cleanEmail]);

    if (!user) {
      // Return identical error message to prevent account enumeration
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    if (user.status === 'DISABLED') {
      return res.status(403).json({ success: false, message: 'Your account has been deactivated. Please contact your administrator.' });
    }

    // Cryptographic PBKDF2 verification strictly required
    const isValid = cryptoService.verifyPassword(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    // Ensure client storage is initialized
    if (user.client_id) {
      await clientStorageService.initClientStorage(user.client_id);
    }

    const normalizedRole = (user.role || 'VIEWER').toUpperCase();
    const normalizedPlatformRole = (user.platform_role || 'USER').toUpperCase();

    const sessionUserData = {
      id: user.id,
      client_id: user.client_id,
      organization_id: user.client_id,
      email: user.email,
      full_name: user.full_name || user.email.split('@')[0],
      fullName: user.full_name || user.email.split('@')[0],
      phone_number: user.phone_number,
      role: normalizedRole,
      platform_role: normalizedPlatformRole,
      platformRole: normalizedPlatformRole,
      auth_provider: user.auth_provider || 'local',
      onboarding_status: user.onboarding_status || 'completed'
    };

    // Session regeneration against session fixation (SEC-17)
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) return reject(err);
        req.session.user = sessionUserData;
        req.session.save(saveErr => saveErr ? reject(saveErr) : resolve());
      });
    });

    const client = user.client_id ? await db.getOne('SELECT * FROM clients WHERE id = ?', [user.client_id]) : null;
    const cin7Conn = user.client_id ? await db.getOne('SELECT status, last_tested_at FROM cin7_connections WHERE client_id = ?', [user.client_id]) : null;
    const isCin7Connected = Boolean(cin7Conn && cin7Conn.status === 'CONNECTED');
    const isOnboarded = (user.onboarding_status === 'completed' || client?.onboarding_status === 'completed') && isCin7Connected;

    res.json({
      success: true,
      message: 'Login successful.',
      user: {
        id: user.id,
        clientId: user.client_id,
        organizationId: user.client_id,
        email: user.email,
        fullName: sessionUserData.full_name,
        full_name: sessionUserData.full_name,
        role: normalizedRole,
        platformRole: normalizedPlatformRole,
        platform_role: normalizedPlatformRole,
        onboardingStatus: isOnboarded ? 'completed' : 'pending'
      },
      organization: client ? {
        id: client.id,
        companyName: client.company_name,
        name: client.company_name,
        timezone: client.timezone || 'Asia/Kolkata',
        subscriptionStatus: client.subscription_status || 'ACTIVE',
        currentVersion: client.current_version || 'v1.0',
        onboardingStatus: isOnboarded ? 'completed' : 'pending'
      } : null,
      client: client ? {
        id: client.id,
        companyName: client.company_name,
        subscriptionStatus: client.subscription_status || 'ACTIVE',
        currentVersion: client.current_version || 'v1.0',
        onboardingStatus: isOnboarded ? 'completed' : 'pending'
      } : null,
      cin7: {
        connected: isCin7Connected,
        status: isCin7Connected ? 'CONNECTED' : 'DISCONNECTED',
        lastVerified: cin7Conn ? cin7Conn.last_tested_at : null
      }
    });
  } catch (err) {
    console.error('Login Error:', err.message);
    res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
  }
});


/**
 * POST /api/auth/logout
 * Strictly destroys session and clears cookie.
 */
router.post('/logout', (req, res) => {
  if (req.session) {
    req.session.destroy(err => {
      res.clearCookie('__vnc_portal_sid');
      res.clearCookie('connect.sid');
      if (err) return res.status(500).json({ error: 'Could not log out' });
      res.json({ success: true, message: 'Logged out successfully' });
    });
  } else {
    res.clearCookie('__vnc_portal_sid');
    res.clearCookie('connect.sid');
    res.json({ success: true, message: 'Logged out successfully' });
  }
});

module.exports = router;
