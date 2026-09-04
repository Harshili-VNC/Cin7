const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { enforceTenantIsolation } = require('../middleware/tenantMiddleware');
const cryptoService = require('../services/cryptoService');
const cin7Engine = require('../services/cin7Engine');
const { v4: uuidv4 } = require('uuid');

router.use(requireAuth);
router.use(enforceTenantIsolation);

/**
 * POST /api/cin7/test-connection
 * Tests Cin7 credentials without saving
 */
router.post('/test-connection', async (req, res) => {
  const apiUsername = (req.body.apiUsername || req.body.accountId || process.env.CIN7_ACCOUNT_ID || '1fbf1d72-81ef-458e-b0bd-b9f92d45a11f').trim();
  const apiKey = (req.body.apiKey || process.env.CIN7_API_KEY || 'd3f297e6-5290-8c3e-69fb-cde4f865fab7').trim();

  if (!apiUsername || !apiKey) {
    return res.status(400).json({ success: false, message: 'Cin7 API Account ID and Key are required.' });
  }

  try {
    const result = await cin7Engine.testConnection(apiUsername.trim(), apiKey.trim());
    if (result.success) {
      return res.json({ success: true, message: result.message || '✓ Cin7 Connected Successfully' });
    } else {
      return res.status(400).json({ success: false, message: result.message || 'Unable to connect to Cin7. Please verify your credentials.' });
    }
  } catch (err) {
    return res.status(400).json({ success: false, message: 'Unable to connect to Cin7. Please check your credentials.' });
  }
});

/**
 * POST /api/cin7/connect & POST /api/cin7/save-credentials
 * Validates, encrypts with AES-256-GCM, stores Cin7 credentials, and MARKS ONBOARDING COMPLETED (Section 3)
 */
router.post(['/connect', '/save-credentials'], async (req, res) => {
  const apiUsername = (req.body.apiUsername || req.body.accountId || '').trim();
  const apiKey = (req.body.apiKey || '').trim();
  const clientId = req.tenantId;

  if (!apiUsername || !apiKey) {
    return res.status(400).json({ success: false, message: 'Cin7 API Account ID and Key are required.' });
  }

  try {
    // 1. Test credentials first
    const testResult = await cin7Engine.testConnection(apiUsername.trim(), apiKey.trim());
    if (!testResult.success) {
      return res.status(400).json({ success: false, message: 'Unable to connect to Cin7. Please check your credentials.' });
    }

    // 2. Encrypt credentials with AES-256-GCM
    const usernameEncrypted = cryptoService.encrypt(apiUsername.trim());
    const keyEncrypted = cryptoService.encrypt(apiKey.trim());

    // 3. Upsert into cin7_connections database table
    const existing = await db.getOne('SELECT * FROM cin7_connections WHERE client_id = ?', [clientId]);
    const now = new Date().toISOString();

    if (existing) {
      await db.query(
        `UPDATE cin7_connections 
         SET api_username_encrypted = ?, api_key_encrypted = ?, status = ?, last_tested_at = ?, updated_at = ?
         WHERE client_id = ?`,
        [usernameEncrypted, keyEncrypted, 'CONNECTED', now, now, clientId]
      );
    } else {
      const id = `cin7-${uuidv4().substring(0, 8)}`;
      await db.query(
        `INSERT INTO cin7_connections (id, client_id, api_username_encrypted, api_key_encrypted, status, last_tested_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, clientId, usernameEncrypted, keyEncrypted, 'CONNECTED', now]
      );
    }

    // 4. Update Onboarding Status in Users & Clients Database Tables (Section 3)
    await db.query(
      `UPDATE users SET onboarding_status = 'completed', onboarding_completed_at = ?, updated_at = ? WHERE client_id = ?`,
      [now, now, clientId]
    );

    await db.query(
      `UPDATE clients SET onboarding_status = 'completed', onboarding_completed_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, clientId]
    );

    // 5. Refresh Session User (Section 3)
    if (req.session && req.session.user) {
      req.session.user.onboarding_status = 'completed';
      req.session.user.onboarding_completed_at = now;
    }

    res.json({
      success: true,
      message: '✓ Cin7 Connected Successfully',
      status: 'CONNECTED',
      onboardingStatus: 'completed',
      lastVerified: now
    });
  } catch (err) {
    console.error('Error saving Cin7 connection:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save Cin7 credentials securely.' });
  }
});

/**
 * GET /api/cin7/status
 */
router.get('/status', async (req, res) => {
  const clientId = req.tenantId;
  const conn = await db.getOne('SELECT status, last_tested_at, created_at FROM cin7_connections WHERE client_id = ?', [clientId]);

  res.json({
    connected: conn && conn.status === 'CONNECTED',
    status: conn ? conn.status : 'DISCONNECTED',
    lastVerified: conn ? conn.last_tested_at : null
  });
});

module.exports = router;
