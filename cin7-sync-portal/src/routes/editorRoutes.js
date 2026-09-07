const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { requireAuth, requireActiveSubscription } = require('../middleware/authMiddleware');
const { enforceTenantIsolation } = require('../middleware/tenantMiddleware');
const { sensitiveOpLimiter } = require('../middleware/rateLimitMiddleware');
const clientStorageService = require('../services/clientStorageService');
const editorService = require('../services/editorService');
const ssrfProtectionService = require('../services/ssrfProtectionService');

/**
 * POST /api/editor/session
 * Initializes a secure tokenized editor session for the authenticated client.
 * Strictly derives clientId from authenticated session.
 * Enforces subscription status.
 */
router.post('/session', sensitiveOpLimiter, requireAuth, enforceTenantIsolation, requireActiveSubscription, async (req, res) => {
  const clientId = req.tenantId;
  const user = req.user;
  const client = req.client;
  const versionId = req.body.versionId || null;
  const isReadOnly = req.body.isReadOnly === true || !!versionId;

  try {
    // Ensure the client's current storage directory and reporting.xlsx exist
    clientStorageService.ensureClientWorkbookExists(clientId);

    // If historical version requested, verify that version file exists
    if (versionId && versionId !== 'current') {
      const historyPath = clientStorageService.getClientHistoryWorkbookPath(clientId, versionId);
      if (!fs.existsSync(historyPath)) {
        return res.status(404).json({
          success: false,
          error: 'VERSION_NOT_FOUND',
          message: `Historical workbook version ${versionId} was not found.`
        });
      }
    }

    // Determine base URL dynamically from request
    const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const host = req.get('host');
    const baseUrl = `${protocol}://${host}`;

    const config = editorService.buildOnlyOfficeConfig(
      clientId,
      user,
      client,
      baseUrl,
      versionId,
      isReadOnly
    );

    console.log(`[EDITOR SESSION] Generated session for client ${clientId} (Version: ${config.versionId}, Mode: ${config.editorConfig.mode})`);

    res.json({
      success: true,
      config
    });
  } catch (err) {
    console.error('[EDITOR SESSION ERROR]', err.message);
    res.status(500).json({
      success: false,
      error: 'EDITOR_SESSION_FAILED',
      message: 'Unable to initialize spreadsheet editor session.'
    });
  }
});

/**
 * GET /api/editor/files/:token
 * Streams the real .xlsx workbook file for the validated temporary session token.
 * Client ID is strictly extracted from the cryptographic token signature.
 */
router.get('/files/:token', async (req, res) => {
  const token = req.params.token;
  const session = editorService.verifySessionToken(token);

  if (!session) {
    return res.status(403).json({ error: 'Invalid or expired document access token.' });
  }

  const { clientId, versionId } = session;

  try {
    // Check client subscription status in database
    const client = await db.getOne('SELECT * FROM clients WHERE id = ?', [clientId]);
    if (!client) {
      return res.status(404).json({ error: 'Client organization not found.' });
    }

    if ((client.subscription_status || 'ACTIVE').toUpperCase() !== 'ACTIVE') {
      return res.status(403).json({
        error: 'SUBSCRIPTION_EXPIRED',
        message: 'Your reporting subscription has expired. Please contact VNC to renew access.'
      });
    }

    // Resolve isolated file path
    const isHistorical = versionId && versionId !== 'current' && versionId !== client.current_version;
    const targetFilePath = isHistorical
      ? clientStorageService.getClientHistoryWorkbookPath(clientId, versionId)
      : clientStorageService.getClientCurrentWorkbookPath(clientId);

    if (!fs.existsSync(targetFilePath)) {
      clientStorageService.ensureClientWorkbookExists(clientId);
    }

    if (!fs.existsSync(targetFilePath)) {
      return res.status(404).json({ error: 'Workbook file not found on server.' });
    }

    const stat = fs.statSync(targetFilePath);

    // Set binary streaming headers without exposing direct download attachment prompt
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const fileStream = fs.createReadStream(targetFilePath);
    fileStream.pipe(res);
  } catch (err) {
    console.error('[EDITOR FILE STREAM ERROR]', err.message);
    res.status(500).json({ error: 'Failed to stream workbook file.' });
  }
});

/**
 * POST /api/editor/callback/:token
 * Handles ONLYOFFICE Docs Document Server save callback.
 * Downloads the updated .xlsx from ONLYOFFICE and overwrites storage/clients/<clientId>/current/reporting.xlsx.
 */
router.post('/callback/:token', express.json({ limit: '100mb' }), async (req, res) => {
  const token = req.params.token;
  const session = editorService.verifySessionToken(token);

  if (!session) {
    return res.status(403).json({ error: 1, message: 'Invalid or expired callback token.' });
  }

  const { clientId, isReadOnly, versionId } = session;

  if (isReadOnly || (versionId && versionId !== 'current')) {
    // Read-only sessions should not overwrite files
    return res.json({ error: 0 });
  }

  const { status, url } = req.body;
  console.log(`[ONLYOFFICE CALLBACK] Received status ${status} for client ${clientId}`);

  // Status 2: Document is ready for saving (after user finishes editing or autosave interval)
  // Status 6: Document is being force-saved
  if ((status === 2 || status === 6) && url) {
    try {
      const currentFilePath = clientStorageService.getClientCurrentWorkbookPath(clientId);
      const tempSavePath = `${currentFilePath}.tmp.${Date.now()}`;

      // Allowed ONLYOFFICE document server hosts
      const allowedHosts = [];
      if (process.env.ONLYOFFICE_URL) allowedHosts.push(process.env.ONLYOFFICE_URL);
      if (process.env.ONLYOFFICE_DOCUMENT_SERVER_URL) allowedHosts.push(process.env.ONLYOFFICE_DOCUMENT_SERVER_URL);

      // Download modified workbook stream securely with SSRF & DNS rebinding defense
      const { stream } = await ssrfProtectionService.safeFetchStream(url, {
        allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
        allowLocalTesting: process.env.NODE_ENV !== 'production',
        timeoutMs: 30000,
        maxSizeBytes: 50 * 1024 * 1024
      });

      const writer = fs.createWriteStream(tempSavePath);
      stream.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      // Atomic replace
      fs.copyFileSync(tempSavePath, currentFilePath);
      if (fs.existsSync(tempSavePath)) {
        fs.unlinkSync(tempSavePath);
      }

      console.log(`[ONLYOFFICE CALLBACK] Successfully saved edited workbook for client ${clientId}`);
      return res.json({ error: 0 });
    } catch (err) {
      console.error('[ONLYOFFICE SAVE ERROR]', err.message);
      return res.status(500).json({ error: 1, message: 'Failed to save updated workbook stream: ' + err.message });
    }
  }

  // Acknowledge other statuses (1 = editing, 4 = closed without changes)
  res.json({ error: 0 });
});

/**
 * POST /api/editor/save/:token
 * Direct save endpoint for browser spreadsheet editor fallback / manual save triggers.
 */
router.post('/save/:token', express.raw({ type: '*/*', limit: '100mb' }), async (req, res) => {
  const token = req.params.token;
  const session = editorService.verifySessionToken(token);

  if (!session) {
    return res.status(403).json({ success: false, error: 'Invalid or expired save token.' });
  }

  const { clientId, isReadOnly, versionId } = session;

  if (isReadOnly || (versionId && versionId !== 'current')) {
    return res.status(403).json({ success: false, error: 'Cannot save to a read-only historical version.' });
  }

  try {
    let fileBuffer = null;
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      fileBuffer = req.body;
    } else if (req.body && req.body.data) {
      fileBuffer = Buffer.from(req.body.data, 'base64');
    }

    if (!fileBuffer || fileBuffer.length === 0) {
      return res.status(400).json({ success: false, error: 'Empty file payload received.' });
    }

    const currentFilePath = clientStorageService.getClientCurrentWorkbookPath(clientId);
    const tempPath = `${currentFilePath}.tmp.${Date.now()}`;

    fs.writeFileSync(tempPath, fileBuffer);
    fs.copyFileSync(tempPath, currentFilePath);
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    console.log(`[DIRECT SAVE] Client ${clientId} workbook saved (${fileBuffer.length} bytes)`);
    res.json({ success: true, message: 'Workbook saved successfully to server.' });
  } catch (err) {
    console.error('[DIRECT SAVE ERROR]', err.message);
    res.status(500).json({ success: false, error: 'Failed to save workbook to server.' });
  }
});

/**
 * GET /api/editor/download & GET /api/destination/download
 * Downloads the client's reporting Excel workbook as an attachment.
 */
router.get('/download', requireAuth, enforceTenantIsolation, async (req, res) => {
  const clientId = req.tenantId;

  try {
    clientStorageService.ensureClientWorkbookExists(clientId);
    const targetFilePath = clientStorageService.getClientCurrentWorkbookPath(clientId);

    if (!fs.existsSync(targetFilePath)) {
      return res.status(404).json({ error: 'Workbook file not found on server.' });
    }

    // Build a meaningful dynamic filename: {CompanyName}_Controller_Reporting_{YYYY-MM-DD}.xlsx
    let downloadFileName = 'Controller_Reporting_Master_Template.xlsx';
    try {
      const clientResult = await db.query('SELECT company_name FROM clients WHERE id = ?', [clientId]);
      if (clientResult && clientResult.rows && clientResult.rows.length > 0) {
        const rawCompany = clientResult.rows[0].company_name || '';
        // Sanitize: replace spaces with underscores, strip unsafe characters
        const safeCompany = rawCompany
          .trim()
          .replace(/\s+/g, '_')
          .replace(/[^a-zA-Z0-9_-]/g, '');
        const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        if (safeCompany) {
          downloadFileName = `${safeCompany}_Controller_Reporting_${dateStr}.xlsx`;
        }
      }
    } catch (nameErr) {
      console.warn('[DOWNLOAD] Could not resolve company name for filename, using default:', nameErr.message);
    }

    res.download(targetFilePath, downloadFileName);
  } catch (err) {
    console.error('[DOWNLOAD ERROR]', err.message);
    res.status(500).json({ error: 'Failed to download workbook file.' });
  }
});

/**
 * GET /api/destination/workbook metadata
 */
router.get(['/workbook', '/info'], requireAuth, enforceTenantIsolation, async (req, res) => {
  const clientId = req.tenantId;
  try {
    clientStorageService.ensureClientWorkbookExists(clientId);
    const destFile = await db.getOne("SELECT * FROM destination_files WHERE client_id = ? ORDER BY created_at DESC", [clientId]);
    res.json({
      success: true,
      file: {
        id: destFile?.file_id || 'master-financial-model',
        name: 'Controller Reporting Master Template',
        webUrl: destFile?.file_url || 'https://docs.google.com/spreadsheets/d/1Qnx6RdCgI7krHtZru10J6r11ZpIkubCSR1jzUbs5G9Q/edit',
        provider: 'google'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;