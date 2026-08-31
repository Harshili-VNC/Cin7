const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireActiveSubscription } = require('../middleware/authMiddleware');
const { enforceTenantIsolation } = require('../middleware/tenantMiddleware');
const cin7Engine = require('../services/cin7Engine');
const MicrosoftExcelAdapter = require('../services/microsoftExcelAdapter');
const clientStorageService = require('../services/clientStorageService');
const editorService = require('../services/editorService');

router.use(requireAuth);
router.use(enforceTenantIsolation);

/**
 * POST /api/sync/sales
 */
router.post('/sales', requireActiveSubscription, async (req, res) => {
  const clientId = req.tenantId;
  const startTime = Date.now();
  const runId = `run-sales-${uuidv4().substring(0, 8)}`;

  try {
    await db.query(
      `INSERT INTO sync_runs (id, client_id, user_id, run_id, sync_type, status)
       VALUES (?, ?, ?, ?, 'sales', 'RUNNING')`,
      [runId, clientId, req.user.id, runId]
    );

    const salesData = await cin7Engine.fetchSales(clientId);
    const adapter = new MicrosoftExcelAdapter(clientId, req.user);
    await adapter.syncSales(salesData);
    await adapter.updateSyncLog({ syncType: 'sales', status: 'Success', detail: `${salesData.rows.length} sales rows synced`, runId });

    const durationMs = Date.now() - startTime;
    await db.query(
      `UPDATE sync_runs 
       SET status = 'COMPLETED', records_processed = ?, duration_ms = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [salesData.rows.length, durationMs, runId]
    );

    res.json({
      success: true,
      syncType: 'sales',
      recordsProcessed: salesData.rows.length,
      durationMs,
      status: 'COMPLETED'
    });
  } catch (err) {
    console.error('Error in Sales sync:', err.message);
    const durationMs = Date.now() - startTime;
    await db.query(
      `UPDATE sync_runs 
       SET status = 'FAILED', error_message = ?, duration_ms = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [err.message, durationMs, runId]
    );

    res.status(500).json({
      success: false,
      syncType: 'sales',
      status: 'FAILED',
      errorMessage: err.message
    });
  }
});

/**
 * POST /api/sync/inventory
 */
router.post('/inventory', requireActiveSubscription, async (req, res) => {
  const clientId = req.tenantId;
  const startTime = Date.now();
  const runId = `run-inv-${uuidv4().substring(0, 8)}`;

  try {
    await db.query(
      `INSERT INTO sync_runs (id, client_id, user_id, run_id, sync_type, status)
       VALUES (?, ?, ?, ?, 'inventory', 'RUNNING')`,
      [runId, clientId, req.user.id, runId]
    );

    const invData = await cin7Engine.fetchInventory(clientId);
    const adapter = new MicrosoftExcelAdapter(clientId, req.user);
    await adapter.syncInventory(invData);
    await adapter.updateSyncLog({ syncType: 'inventory', status: 'Success', detail: `${invData.rows.length} inventory rows synced`, runId });

    const durationMs = Date.now() - startTime;
    await db.query(
      `UPDATE sync_runs 
       SET status = 'COMPLETED', records_processed = ?, duration_ms = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [invData.rows.length, durationMs, runId]
    );

    res.json({
      success: true,
      syncType: 'inventory',
      recordsProcessed: invData.rows.length,
      durationMs,
      status: 'COMPLETED'
    });
  } catch (err) {
    console.error('Error in Inventory sync:', err.message);
    const durationMs = Date.now() - startTime;
    await db.query(
      `UPDATE sync_runs 
       SET status = 'FAILED', error_message = ?, duration_ms = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [err.message, durationMs, runId]
    );

    res.status(500).json({
      success: false,
      syncType: 'inventory',
      status: 'FAILED',
      errorMessage: err.message
    });
  }
});

/**
 * POST /api/sync/purchase-orders
 */
router.post('/purchase-orders', requireActiveSubscription, async (req, res) => {
  const clientId = req.tenantId;
  const startTime = Date.now();
  const runId = `run-po-${uuidv4().substring(0, 8)}`;

  try {
    await db.query(
      `INSERT INTO sync_runs (id, client_id, user_id, run_id, sync_type, status)
       VALUES (?, ?, ?, ?, 'purchase_orders', 'RUNNING')`,
      [runId, clientId, req.user.id, runId]
    );

    const poData = await cin7Engine.fetchPurchaseOrders(clientId);
    const adapter = new MicrosoftExcelAdapter(clientId, req.user);
    await adapter.syncPurchaseOrders(poData);
    await adapter.updateSyncLog({ syncType: 'purchase_orders', status: 'Success', detail: `${poData.rows.length} PO rows synced`, runId });

    const durationMs = Date.now() - startTime;
    await db.query(
      `UPDATE sync_runs 
       SET status = 'COMPLETED', records_processed = ?, duration_ms = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [poData.rows.length, durationMs, runId]
    );

    res.json({
      success: true,
      syncType: 'purchase_orders',
      recordsProcessed: poData.rows.length,
      durationMs,
      status: 'COMPLETED'
    });
  } catch (err) {
    console.error('Error in Purchase Orders sync:', err.message);
    const durationMs = Date.now() - startTime;
    await db.query(
      `UPDATE sync_runs 
       SET status = 'FAILED', error_message = ?, duration_ms = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [err.message, durationMs, runId]
    );

    res.status(500).json({
      success: false,
      syncType: 'purchase_orders',
      status: 'FAILED',
      errorMessage: err.message
    });
  }
});

/**
 * POST /api/sync/all
 * Full sequential sync: Sales + Inventory + POs -> updates client's real server .xlsx -> creates next version snapshot
 */
router.post('/all', requireActiveSubscription, async (req, res) => {
  const clientId = req.tenantId;
  const startTime = Date.now();
  const runId = `run-all-${uuidv4().substring(0, 8)}`;

  try {
    await db.query(
      `INSERT INTO sync_runs (id, client_id, user_id, run_id, sync_type, status)
       VALUES (?, ?, ?, ?, 'all', 'RUNNING')`,
      [runId, clientId, req.user.id, runId]
    );

    // 1. Fetch live Cin7 datasets
    const [salesData, invData, poData] = await Promise.all([
      cin7Engine.fetchSales(clientId),
      cin7Engine.fetchInventory(clientId),
      cin7Engine.fetchPurchaseOrders(clientId)
    ]);

    const totalRecords = salesData.rows.length + invData.rows.length + poData.rows.length;

    // 2. Determine next version (e.g. v1.0 -> v2.0 -> v3.0)
    const clientRecord = await db.getOne('SELECT * FROM clients WHERE id = ?', [clientId]);
    const currentVersion = clientRecord?.current_version || 'v1.0';
    const nextVersion = clientStorageService.calculateNextVersion(currentVersion);

    // 3. Populate raw data sheets & save to reporting.xlsx and snapshot to history/vX.0.xlsx
    const adapter = new MicrosoftExcelAdapter(clientId, req.user);
    await adapter.syncSales(salesData);
    await adapter.syncInventory(invData);
    await adapter.syncPurchaseOrders(poData, nextVersion);
    await adapter.updateSyncLog({
      syncType: 'all',
      status: 'Success',
      detail: `Full Sync (${nextVersion}): ${totalRecords} records updated`,
      runId
    });

    const durationMs = Date.now() - startTime;
    const nowIso = new Date().toISOString();

    // 4. Update database records
    await db.query(
      `UPDATE sync_runs 
       SET status = 'COMPLETED', records_processed = ?, duration_ms = ?, excel_version_id = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [totalRecords, durationMs, nextVersion, runId]
    );

    await db.query(
      `UPDATE clients 
       SET current_version = ?, last_sync_at = ?, sync_status = 'SYNCED'
       WHERE id = ?`,
      [nextVersion, nowIso, clientId]
    );

    await db.query(
      `UPDATE client_workbooks 
       SET current_version = ?, updated_at = ?
       WHERE client_id = ?`,
      [nextVersion, nowIso, clientId]
    );

    console.log(`[SYNC COMPLETE] Client ${clientId} synced to ${nextVersion} (${totalRecords} records in ${durationMs}ms)`);

    res.json({
      success: true,
      syncType: 'all',
      status: 'COMPLETED',
      versionId: nextVersion,
      recordsProcessed: totalRecords,
      durationMs,
      lastSyncAt: nowIso,
      breakdown: {
        sales: salesData.rows.length,
        inventory: invData.rows.length,
        purchaseOrders: poData.rows.length
      }
    });
  } catch (err) {
    console.error('Error in Full Cin7 sync:', err.message);
    const durationMs = Date.now() - startTime;
    await db.query(
      `UPDATE sync_runs 
       SET status = 'FAILED', error_message = ?, duration_ms = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [err.message, durationMs, runId]
    );

    await db.query(
      `UPDATE clients 
       SET sync_status = 'FAILED'
       WHERE id = ?`,
      [clientId]
    );

    res.status(500).json({
      success: false,
      syncType: 'all',
      status: 'FAILED',
      errorMessage: err.message
    });
  }
});

/**
 * GET /api/sync/history
 * Returns paginated audit history for the authenticated client.
 * No direct download URLs are exposed.
 */
router.get('/history', async (req, res) => {
  const clientId = req.tenantId;
  const page = parseInt(req.query.page || 1, 10);
  const limit = parseInt(req.query.limit || 10, 10);

  const runs = await db.query(
    'SELECT * FROM sync_runs WHERE client_id = ? ORDER BY started_at DESC',
    [clientId]
  );

  const allRows = runs.rows || [];
  const totalRecords = allRows.length;
  const totalPages = Math.ceil(totalRecords / limit) || 1;

  const startIndex = (page - 1) * limit;
  const paginatedRows = allRows.slice(startIndex, startIndex + limit);

  const items = paginatedRows.map(r => ({
    id: r.id,
    runId: r.run_id || r.id,
    syncType: (r.sync_type || 'all').toUpperCase().replace('_', ' '),
    status: r.status,
    recordsProcessed: r.records_processed || 0,
    durationMs: r.duration_ms || 0,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    fileName: 'Controller_Reporting_Model_v5_Cin7_Actuals.xlsx',
    excelVersionId: r.excel_version_id || (r.status === 'COMPLETED' ? 'v1.0' : '—'),
    errorMessage: r.error_message || null
  }));

  res.json({
    success: true,
    items,
    page,
    totalPages,
    totalRecords,
    syncRuns: items
  });
});

/**
 * POST /api/sync/history/:historyId/session
 * Generates a read-only document editor session for a historical version snapshot.
 */
router.post('/history/:historyId/session', requireActiveSubscription, async (req, res) => {
  const clientId = req.tenantId;
  const historyId = req.params.historyId;

  let run = await db.getOne(
    'SELECT * FROM sync_runs WHERE id = ? AND client_id = ?',
    [historyId, clientId]
  );
  if (!run) {
    run = await db.getOne(
      'SELECT * FROM sync_runs WHERE run_id = ? AND client_id = ?',
      [historyId, clientId]
    );
  }

  const versionId = run?.excel_version_id || historyId;
  const historyPath = clientStorageService.getClientHistoryWorkbookPath(clientId, versionId);

  if (!fs.existsSync(historyPath)) {
    return res.status(404).json({
      success: false,
      error: 'VERSION_FILE_NOT_FOUND',
      message: `Historical workbook version ${versionId} is not available.`
    });
  }

  const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const host = req.get('host');
  const baseUrl = `${protocol}://${host}`;

  const config = editorService.buildOnlyOfficeConfig(
    clientId,
    req.user,
    req.client,
    baseUrl,
    versionId,
    true // Strictly read-only for historical versions
  );

  res.json({
    success: true,
    config
  });
});

module.exports = router;