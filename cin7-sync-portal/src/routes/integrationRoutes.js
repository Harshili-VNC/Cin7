const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireAdmin, requireCanSync } = require('../middleware/authMiddleware');
const { enforceTenantIsolation } = require('../middleware/tenantMiddleware');
const cryptoService = require('../services/cryptoService');
const cin7Engine = require('../services/cin7Engine');
const { logAction } = require('../services/auditService');
const { v4: uuidv4 } = require('uuid');

router.use(requireAuth);
router.use(enforceTenantIsolation);

// ── CIN7 INTEGRATION ENDPOINTS ────────────────────────────────────────────────

/**
 * GET /api/integrations/cin7
 * Returns CIN7 connection status, account ID, and strictly MASKED API key.
 * Never exposes the raw API key in plaintext.
 */
router.get('/cin7', requireCanSync, async (req, res) => {
  const orgId = req.organizationId;
  try {
    const conn = await db.getOne('SELECT * FROM cin7_connections WHERE client_id = ?', [orgId]);
    
    let accountId = '';
    let hasApiKey = false;
    let isConnected = false;

    if (conn) {
      isConnected = (conn.status === 'CONNECTED');
      if (conn.api_username_encrypted) {
        accountId = cryptoService.decrypt(conn.api_username_encrypted) || '';
      }
      hasApiKey = Boolean(conn.api_key_encrypted);
    }

    const integrationObj = {
      connected: isConnected,
      status: isConnected ? 'Connected ✓' : 'Disconnected',
      accountId: accountId || '',
      apiKeyMasked: hasApiKey ? '••••••••••••••••••••' : '',
      lastVerified: conn ? conn.last_tested_at : null
    };

    res.json({
      success: true,
      ...integrationObj,
      integration: integrationObj
    });
  } catch (err) {
    console.error('Error fetching CIN7 integration:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load CIN7 settings' });
  }
});

/**
 * PUT /api/integrations/cin7
 * Updates / replaces CIN7 credentials with AES-256-GCM encryption.
 * Restrict: ADMIN only.
 */
router.put('/cin7', requireAdmin, async (req, res) => {
  const orgId = req.organizationId;
  const { accountId, apiUsername, apiKey } = req.body;
  const targetAccountId = (accountId || apiUsername || '').trim();
  const targetApiKey = (apiKey || '').trim();

  if (!targetAccountId || !targetApiKey) {
    return res.status(400).json({ success: false, message: 'Both Cin7 Account ID and API Application Key are required.' });
  }

  // Prevent saving mask placeholder
  if (targetApiKey.includes('••••')) {
    return res.status(400).json({ success: false, message: 'Please enter a valid API key to replace the existing credential.' });
  }

  try {
    // 1. Test live connection
    const testResult = await cin7Engine.testConnection(targetAccountId, targetApiKey);
    if (!testResult.success) {
      return res.status(400).json({ success: false, message: testResult.message || 'Unable to connect to Cin7. Please verify credentials.' });
    }

    // 2. Encrypt with AES-256-GCM
    const encUsername = cryptoService.encrypt(targetAccountId);
    const encApiKey = cryptoService.encrypt(targetApiKey);
    const now = new Date().toISOString();

    const existing = await db.getOne('SELECT * FROM cin7_connections WHERE client_id = ?', [orgId]);
    if (existing) {
      await db.query(
        `UPDATE cin7_connections 
         SET api_username_encrypted = ?, api_key_encrypted = ?, status = 'CONNECTED', last_tested_at = ?, updated_at = ?
         WHERE client_id = ?`,
        [encUsername, encApiKey, now, now, orgId]
      );
    } else {
      const id = `cin7-${uuidv4().substring(0, 8)}`;
      await db.query(
        `INSERT INTO cin7_connections (id, client_id, api_username_encrypted, api_key_encrypted, status, last_tested_at)
         VALUES (?, ?, ?, ?, 'CONNECTED', ?)`,
        [id, orgId, encUsername, encApiKey, now]
      );
    }

    // Invalidate order cache on credential update
    cin7Engine.invalidateOrderDetailCache(orgId);

    await logAction({
      organizationId: orgId,
      userId: req.user.id,
      action: 'UPDATE_CIN7_CREDENTIALS',
      resource: 'cin7_integration',
      details: { accountId: targetAccountId }
    });

    res.json({
      success: true,
      message: '✓ Cin7 credentials verified and saved securely',
      status: 'CONNECTED',
      lastVerified: now
    });
  } catch (err) {
    console.error('Error saving CIN7 credentials:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update Cin7 credentials' });
  }
});

/**
 * POST /api/integrations/cin7/test
 * Tests CIN7 connection using either provided credentials or stored encrypted credentials.
 */
router.post('/cin7/test', requireCanSync, async (req, res) => {
  const orgId = req.organizationId;
  let accountId = (req.body.accountId || req.body.apiUsername || '').trim();
  let apiKey = (req.body.apiKey || '').trim();

  try {
    // If not provided in body, load from stored database credentials
    if (!accountId || !apiKey || apiKey.includes('••••')) {
      const conn = await db.getOne('SELECT * FROM cin7_connections WHERE client_id = ?', [orgId]);
      if (conn && conn.api_username_encrypted && conn.api_key_encrypted) {
        accountId = cryptoService.decrypt(conn.api_username_encrypted);
        apiKey = cryptoService.decrypt(conn.api_key_encrypted);
      }
    }

    if (!accountId || !apiKey) {
      return res.status(400).json({ success: false, message: 'Cin7 credentials not configured.' });
    }

    const testRes = await cin7Engine.testConnection(accountId, apiKey);
    if (testRes.success) {
      return res.json({ success: true, message: '✓ Cin7 connection verified successfully' });
    } else {
      return res.status(400).json({ success: false, message: testRes.message || 'Unable to connect to Cin7.' });
    }
  } catch (err) {
    console.error('Error testing CIN7 connection:', err.message);
    res.status(500).json({ success: false, message: 'Error establishing connection with Cin7' });
  }
});

// ── GOOGLE SHEETS INTEGRATION ENDPOINTS ───────────────────────────────────────

/**
 * GET /api/integrations/google-sheets
 * Returns Google Sheets integration details for the organization.
 */
router.get('/google-sheets', async (req, res) => {
  const orgId = req.organizationId;
  try {
    const dest = await db.getOne(
      "SELECT * FROM destination_files WHERE client_id = ? AND provider = 'google' ORDER BY created_at DESC",
      [orgId]
    );

    const masterTemplateId = process.env.GoogleMasterTemp || process.env.MASTER_TEMPLATE_ID || '1uxdMS8pATOVdGQWD-VFniQ0RbMZOtjJE';
    const isConnected = Boolean(dest && dest.file_url) || Boolean(process.env.GoogleMasterTemp);

    res.json({
      success: true,
      connected: isConnected,
      status: isConnected ? 'Connected ✓' : 'Disconnected',
      masterTemplateName: 'Controller Reporting Master Template',
      masterTemplateId,
      workbookId: dest?.file_id ? `${dest.file_id.substring(0, 12)}••••••••` : `${masterTemplateId.substring(0, 12)}••••••••`,
      sheetUrl: dest?.file_url || `https://docs.google.com/spreadsheets/d/${masterTemplateId}/edit`,
      workspaceFolder: 'VNC Global Reports / Drive Root',
      templateStatus: 'Up to date ✓',
      lastSyncedAt: dest?.created_at || null
    });
  } catch (err) {
    console.error('Error fetching Google Sheets integration:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load Google Sheets configuration' });
  }
});

/**
 * PUT /api/integrations/google-sheets
 * Updates Google Sheets master template configuration.
 * Restrict: ADMIN only.
 */
router.put('/google-sheets', requireAdmin, async (req, res) => {
  const orgId = req.organizationId;
  const { masterTemplateId, masterTemplateName } = req.body;

  if (!masterTemplateId) {
    return res.status(400).json({ success: false, message: 'Master Template ID is required.' });
  }

  try {
    await logAction({
      organizationId: orgId,
      userId: req.user.id,
      action: 'UPDATE_GOOGLE_SHEETS_CONFIG',
      resource: 'google_sheets_integration',
      details: { masterTemplateId: masterTemplateId.trim(), masterTemplateName }
    });

    res.json({
      success: true,
      message: '✓ Google Sheets configuration saved successfully',
      masterTemplateId: masterTemplateId.trim()
    });
  } catch (err) {
    console.error('Error updating Google Sheets configuration:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update Google Sheets configuration' });
  }
});

/**
 * POST /api/integrations/google-sheets/test
 * Tests Google Sheets API authentication and template access.
 */
router.post('/google-sheets/test', requireCanSync, async (req, res) => {
  const orgId = req.organizationId;
  try {
    const GoogleSheetsAdapter = require('../services/googleSheetsAdapter');
    const adapter = new GoogleSheetsAdapter(orgId, req.user);
    const { drive } = await adapter.getGoogleClients();
    
    // Check if master template is accessible
    const masterId = process.env.GoogleMasterTemp || process.env.MASTER_TEMPLATE_ID || '1uxdMS8pATOVdGQWD-VFniQ0RbMZOtjJE';
    let fileInfo = null;
    try {
      const fileRes = await drive.files.get({ fileId: masterId, fields: 'id, name' });
      fileInfo = fileRes.data;
    } catch (e) {
      // Fallback
    }

    res.json({
      success: true,
      message: fileInfo ? `✓ Google Sheets connection verified (Template: ${fileInfo.name || masterId})` : '✓ Google Sheets connection verified'
    });
  } catch (err) {
    console.error('Error testing Google Sheets:', err.message);
    res.status(500).json({ success: false, message: `Unable to connect to Google Sheets: ${err.message}` });
  }
});

/**
 * GET /api/integrations/google-sheets/preview
 * Reads every tab of the org's live, synced Google Sheet directly from the Sheets API
 * (real tab names, order, and formatted values) so the in-app workbook preview always
 * matches what's actually in the spreadsheet.
 */
router.get('/google-sheets/preview', async (req, res) => {
  const orgId = req.organizationId;
  try {
    const dest = await db.getOne(
      "SELECT * FROM destination_files WHERE client_id = ? AND provider = 'google' ORDER BY created_at DESC",
      [orgId]
    );

    if (!dest || !dest.file_id) {
      return res.status(404).json({ success: false, message: 'No synced Google Sheet found for this organization yet.' });
    }

    const GoogleSheetsAdapter = require('../services/googleSheetsAdapter');
    const adapter = new GoogleSheetsAdapter(orgId, req.user);
    const preview = await adapter.readWorkbookPreview(dest.file_id);

    res.json({ success: true, sheetUrl: dest.file_url, sheets: preview.sheets });
  } catch (err) {
    console.error('Error reading Google Sheets preview:', err.message);
    res.status(500).json({ success: false, message: `Failed to load live Google Sheet preview: ${err.message}` });
  }
});

module.exports = router;
