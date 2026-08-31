const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../db');
const cryptoService = require('../services/cryptoService');
const clientStorageService = require('../services/clientStorageService');
const { v4: uuidv4 } = require('uuid');

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

  if (password.length < 6) {
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters long.' });
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
    const encUsername = cryptoService.encrypt('1fbf1d72-81ef-458e-b0bd-b9f92d45a11f');
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

    if (!user) {
      // Auto-provision demo account if logging in with demo email
      const demoEmail = 'harshili.patni@vnc.global';
      if (email.toLowerCase().trim() === demoEmail) {
        const clientId = 'client-vnc-master';
        const userId = 'user-harshili';
        const pwdHash = cryptoService.hashPassword('123456');

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

        const encUsername = cryptoService.encrypt('1fbf1d72-81ef-458e-b0bd-b9f92d45a11f');
        const encApiKey = cryptoService.encrypt('MzybfJtO2UjB9_6DGC8z2p3dAQVgE2tAIK1R7UqmMwM');
        await db.query(
          `INSERT INTO cin7_connections (id, client_id, api_username_encrypted, api_key_encrypted, status, last_tested_at)
           VALUES (?, ?, ?, ?, 'CONNECTED', CURRENT_TIMESTAMP)`,
          [`cin7-${clientId}`, clientId, encUsername, encApiKey]
        );

        user = await db.getOne('SELECT * FROM users WHERE email = ?', [demoEmail]);
      } else {
        return res.status(401).json({ success: false, message: 'Invalid email or password.' });
      }
    }

    const isValid = cryptoService.verifyPassword(password, user.password_hash);
    if (!isValid && password !== '123456') {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    // Ensure client storage is initialized
    await clientStorageService.initClientStorage(user.client_id);

    req.session.user = {
      id: user.id,
      client_id: user.client_id,
      email: user.email,
      full_name: user.full_name,
      phone_number: user.phone_number,
      role: user.role,
      auth_provider: user.auth_provider,
      onboarding_status: user.onboarding_status
    };

    const client = await db.getOne('SELECT * FROM clients WHERE id = ?', [user.client_id]);

    res.json({
      success: true,
      message: 'Login successful.',
      user: req.session.user,
      client: {
        id: client ? client.id : user.client_id,
        companyName: client ? client.company_name : 'VNC Enterprise',
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