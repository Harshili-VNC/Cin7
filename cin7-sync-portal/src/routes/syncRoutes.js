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
const snapshotService = require('../services/snapshotService');
const lockService = require('../services/lockService');

const activeSyncProgress = new Map();

/**
 * GET /api/sync/progress/:runId or GET /api/sync/progress/latest
 * Returns live progress of active sync execution for UI polling
 */
router.get(['/progress/:runId', '/progress'], (req, res) => {
  const runId = req.params.runId;
  if (runId && activeSyncProgress.has(runId)) {
    return res.json({ success: true, progress: activeSyncProgress.get(runId) });
  }

  // Fallback to most recent progress
  const entries = Array.from(activeSyncProgress.entries());
  if (entries.length > 0) {
    const latest = entries[entries.length - 1][1];
    return res.json({ success: true, progress: latest });
  }

  return res.json({
    success: true,
    progress: { stage: 'IDLE', current: 0, total: 0, percent: 100, message: 'Ready' }
  });
});

/**
 * POST /api/sync/sales
 */
router.post('/sales', requireAuth, enforceTenantIsolation, requireActiveSubscription, async (req, res) => {
  const clientId = req.tenantId;
  const startTime = Date.now();
  const runId = `run-sales-${uuidv4().substring(0, 8)}`;

  const lockRes = lockService.acquireLock(clientId, runId);
  if (!lockRes.acquired) {
    return res.status(409).json({
      success: false,
      error: 'SYNC_ALREADY_IN_PROGRESS',
      message: lockRes.reason,
      currentLock: lockRes.currentLock
    });
  }

  try {
    await db.query(
      `INSERT INTO sync_runs (id, client_id, user_id, run_id, sync_type, status)
       VALUES (?, ?, ?, ?, 'sales', 'RUNNING')`,
      [runId, clientId, req.user.id, runId]
    );

    const salesData = await cin7Engine.fetchSales(clientId);
    await snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'sales', periodLabel: 'Last 30 days', dataset: salesData, syncRunId: runId });
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
  } finally {
    lockService.releaseLock(clientId, runId);
  }
});

/**
 * POST /api/sync/inventory
 */
router.post('/inventory', requireAuth, enforceTenantIsolation, requireActiveSubscription, async (req, res) => {
  const clientId = req.tenantId;
  const startTime = Date.now();
  const runId = `run-inv-${uuidv4().substring(0, 8)}`;

  const lockRes = lockService.acquireLock(clientId, runId);
  if (!lockRes.acquired) {
    return res.status(409).json({
      success: false,
      error: 'SYNC_ALREADY_IN_PROGRESS',
      message: lockRes.reason,
      currentLock: lockRes.currentLock
    });
  }

  try {
    await db.query(
      `INSERT INTO sync_runs (id, client_id, user_id, run_id, sync_type, status)
       VALUES (?, ?, ?, ?, 'inventory', 'RUNNING')`,
      [runId, clientId, req.user.id, runId]
    );

    const invData = await cin7Engine.fetchInventory(clientId);
    await snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'inventory', periodLabel: 'Current', dataset: invData, syncRunId: runId });
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
  } finally {
    lockService.releaseLock(clientId, runId);
  }
});

/**
 * POST /api/sync/purchase-orders
 */
router.post('/purchase-orders', requireAuth, enforceTenantIsolation, requireActiveSubscription, async (req, res) => {
  const clientId = req.tenantId;
  const startTime = Date.now();
  const runId = `run-po-${uuidv4().substring(0, 8)}`;

  const lockRes = lockService.acquireLock(clientId, runId);
  if (!lockRes.acquired) {
    return res.status(409).json({
      success: false,
      error: 'SYNC_ALREADY_IN_PROGRESS',
      message: lockRes.reason,
      currentLock: lockRes.currentLock
    });
  }

  try {
    await db.query(
      `INSERT INTO sync_runs (id, client_id, user_id, run_id, sync_type, status)
       VALUES (?, ?, ?, ?, 'purchase_orders', 'RUNNING')`,
      [runId, clientId, req.user.id, runId]
    );

    const poData = await cin7Engine.fetchPurchaseOrders(clientId);
    await snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'purchase', periodLabel: 'Last 30 days', dataset: poData, syncRunId: runId });
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
  } finally {
    lockService.releaseLock(clientId, runId);
  }
});

/**
 * POST /api/sync/all & POST /api/sync/trigger
 * Full sequential sync: Sales + Inventory + POs -> updates client's real server .xlsx -> creates next version snapshot
 */
router.post(['/all', '/trigger'], async (req, res) => {
  const authenticatedUser = req.user || req.session?.user || null;
  const rawClientId = req.tenantId || authenticatedUser?.client_id || (process.env.NODE_ENV !== 'production' ? (req.headers['x-client-id'] || 'client-vnc-master') : null);

  if (!rawClientId) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED_TENANT', message: 'Tenant identification required.' });
  }

  let clientId;
  try {
    clientId = clientStorageService.validateClientId(rawClientId);
  } catch (e) {
    return res.status(400).json({ success: false, error: 'INVALID_TENANT_ID', message: e.message });
  }

  const startTime = Date.now();
  const runId = `run-all-${uuidv4().substring(0, 8)}`;
  const destination = req.body?.destination || 'google_sheets';
  const clientEmail = authenticatedUser?.email || null;
  const dateRange = req.body?.dateRange || req.body?.timelinePeriod || '30d';
  const isForceFull = Boolean(req.body?.forceFull || req.body?.mode === 'FORCE_FULL');

  // Per-Client Concurrency Mutex Lock
  const lockRes = lockService.acquireLock(clientId, runId);
  if (!lockRes.acquired) {
    return res.status(409).json({
      success: false,
      error: 'SYNC_ALREADY_IN_PROGRESS',
      message: lockRes.reason,
      currentLock: lockRes.currentLock
    });
  }

  // Helper to update live progress for UI polling
  function updateProgress(stage, current, total, percent, message) {
    activeSyncProgress.set(runId, {
      runId,
      stage,
      current,
      total,
      percent,
      message,
      timestamp: new Date().toISOString()
    });
  }

  try {
    updateProgress('CONNECTING', 0, 4, 10, 'Connecting to Cin7 Core API...');

    await db.query(
      `INSERT INTO sync_runs (id, client_id, user_id, run_id, sync_type, status)
       VALUES (?, ?, ?, ?, ?, 'RUNNING')`,
      [runId, clientId, authenticatedUser?.id || 'system', runId, destination === 'google_sheets' ? 'google_sheets' : 'all']
    );

    // 1. Evaluate Incremental Sync Safety
    const salesSafety = snapshotService.isIncrementalSafe(clientId, 'sales', dateRange);
    const poSafety = snapshotService.isIncrementalSafe(clientId, 'purchase', dateRange);

    const useIncrementalSales = !isForceFull && salesSafety.safe;
    const useIncrementalPO = !isForceFull && poSafety.safe;

    const salesUpdatedSince = useIncrementalSales ? salesSafety.updatedSince : null;
    const poUpdatedSince = useIncrementalPO ? poSafety.updatedSince : null;

    console.log(`\n[CIN7 SYNC START] Client: ${clientId}, Window: ${dateRange}, ForceFull: ${isForceFull}`);
    console.log(`  Sales Sync Strategy: ${useIncrementalSales ? `INCREMENTAL (${salesSafety.reason})` : `FULL FETCH (${salesSafety.reason})`}`);
    console.log(`  Purchase Sync Strategy: ${useIncrementalPO ? `INCREMENTAL (${poSafety.reason})` : `FULL FETCH (${poSafety.reason})`}`);
    console.log(`  Inventory Sync Strategy: CURRENT AVAILABILITY SNAPSHOT\n`);

    updateProgress('FETCHING', 1, 4, 25, useIncrementalSales ? 'Checking for new/modified records since last sync...' : 'Extracting Sales, Inventory & Purchases...');

    // 2. Fetch live Cin7 datasets with concurrency & caching
    const [fetchedSales, invData, fetchedPO] = await Promise.all([
      cin7Engine.fetchSales(clientId, {
        updatedSince: salesUpdatedSince,
        onProgress: (p) => {
          updateProgress('ENRICHING', p.current, p.total, Math.round(25 + (p.percent * 0.35)), p.message);
        }
      }),
      cin7Engine.fetchInventory(clientId),
      cin7Engine.fetchPurchaseOrders(clientId, { updatedSince: poUpdatedSince })
    ]);

    updateProgress('VALIDATING', 2, 4, 65, 'Upserting delta records & validating schemas...');

    // 3. Upsert / Merge & Rolling Window Filter for Sales
    let finalSalesRows = [];
    if (useIncrementalSales) {
      const existingSales = snapshotService.getCurrentReportRows(clientId, 'sales');
      const mergedSales = cin7Engine.mergeSalesData(existingSales.rows, fetchedSales.rows);
      finalSalesRows = cin7Engine.filterSalesByWindow(mergedSales, dateRange);
      console.log(`[SALES UPSERT] Existing: ${existingSales.rows.length}, Delta fetched: ${fetchedSales.rows.length}, Merged & Rolling Filter (${dateRange}): ${finalSalesRows.length}`);
    } else {
      finalSalesRows = cin7Engine.filterSalesByWindow(fetchedSales.rows, dateRange);
    }
    const salesData = { headers: fetchedSales.headers, rows: finalSalesRows };

    // 4. Upsert / Merge & Rolling Window Filter for Purchase
    let finalPORows = [];
    if (useIncrementalPO) {
      const existingPO = snapshotService.getCurrentReportRows(clientId, 'purchase');
      const mergedPO = cin7Engine.mergePurchaseData(existingPO.rows, fetchedPO.rows);
      finalPORows = cin7Engine.filterPurchaseByWindow(mergedPO, dateRange);
      console.log(`[PURCHASE UPSERT] Existing: ${existingPO.rows.length}, Delta fetched: ${fetchedPO.rows.length}, Merged & Rolling Filter (${dateRange}): ${finalPORows.length}`);
    } else {
      finalPORows = cin7Engine.filterPurchaseByWindow(fetchedPO.rows, dateRange);
    }
    const poData = { headers: fetchedPO.headers, rows: finalPORows };

    // 5. Format Period Label
    const periodLabel = (dateRange === '365d' || dateRange === 'Last 365 days' || dateRange === 'Last 365 Days') ? 'Last 365 Days'
      : (dateRange === '90d' || dateRange === 'Last 90 days' || dateRange === 'Last 90 Days' ? 'Last 90 Days'
      : (dateRange === '7d' || dateRange === 'Last 7 days' || dateRange === 'Last 7 Days' ? 'Last 7 Days'
      : (dateRange === 'ytd' || dateRange === 'Year to date' ? 'Year to date' : 'Last 30 Days')));

    // 6. Atomic save of current active reports & immutable snapshots
    await Promise.all([
      snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'sales', periodLabel, dataset: salesData, syncRunId: runId }),
      snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'inventory', periodLabel: 'Current Stock', dataset: invData, syncRunId: runId }),
      snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'purchase', periodLabel, dataset: poData, syncRunId: runId })
    ]);

    const totalRecords = salesData.rows.length + invData.rows.length + poData.rows.length;
    let sheetUrl = null;
    let fileId = null;
    let nextVersion = 'v1.0';

    updateProgress('POPULATING', 3, 4, 80, destination === 'google_sheets' ? 'Cloning & populating 17 Master Google Sheets tabs...' : 'Populating 17 Master Model Excel sheets...');

    if (destination === 'google_sheets') {
      const GoogleSheetsAdapter = require('../services/googleSheetsAdapter');
      const adapter = new GoogleSheetsAdapter(clientId, authenticatedUser);

      // Clone master template into brand new spreadsheet
      const dest = await adapter.createGoogleSheetFromTemplate(clientEmail);
      const newSpreadsheetId = dest.file_id;

      // Populate fresh data
      await adapter.syncSales(salesData, clientEmail, dest);
      await adapter.syncInventory(invData, clientEmail, dest);
      await adapter.syncPurchaseOrders(poData, clientEmail, dest);

      // Update dynamic report formulas
      await adapter.updateClonedReportFormulas(newSpreadsheetId, salesData, invData);

      await adapter.updateSyncLog({
        syncType: 'google_sheets',
        status: 'Success',
        detail: `Google Sheets Sync: ${totalRecords} records cloned & updated into ${newSpreadsheetId}`,
        runId
      }, clientEmail, dest);

      await adapter.verifyDataWritten(newSpreadsheetId);

      sheetUrl = dest.file_url;
      fileId = dest.file_id;
    } else {
      const clientRecord = await db.getOne('SELECT * FROM clients WHERE id = ?', [clientId]);
      const currentVersion = clientRecord?.current_version || 'v1.0';
      nextVersion = clientStorageService.calculateNextVersion(currentVersion);

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
    }

    const durationMs = Date.now() - startTime;
    // CRITICAL: Completion boundary timestamp recorded ONLY on full verified success
    const completionBoundaryIso = new Date().toISOString();

    // 7. Update database records
    await db.query(
      `UPDATE sync_runs 
       SET status = 'COMPLETED', records_processed = ?, duration_ms = ?, excel_version_id = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND client_id = ?`,
      [totalRecords, durationMs, destination === 'google_sheets' ? fileId : nextVersion, runId, clientId]
    );

    if (destination !== 'google_sheets') {
      await db.query(
        `UPDATE clients 
         SET current_version = ?, last_sync_at = ?, sync_status = 'SYNCED'
         WHERE id = ?`,
        [nextVersion, completionBoundaryIso, clientId]
      );

      await db.query(
        `UPDATE client_workbooks 
         SET current_version = ?, updated_at = ?
         WHERE client_id = ?`,
        [nextVersion, completionBoundaryIso, clientId]
      );
    }

    // 8. Update Persistent Sync State with Completion Boundary Timestamp
    snapshotService.updateSyncState(clientId, 'sales', {
      reportWindow: dateRange,
      lastSuccessfulSync: completionBoundaryIso,
      lastSyncRunId: runId,
      recordCount: salesData.rows.length
    });
    snapshotService.updateSyncState(clientId, 'purchase', {
      reportWindow: dateRange,
      lastSuccessfulSync: completionBoundaryIso,
      lastSyncRunId: runId,
      recordCount: poData.rows.length
    });
    snapshotService.updateSyncState(clientId, 'inventory', {
      reportWindow: 'current',
      lastSuccessfulSync: completionBoundaryIso,
      lastSyncRunId: runId,
      recordCount: invData.rows.length
    });

    updateProgress('FINALIZING', 4, 4, 100, 'Sync complete! All reports verified.');

    console.log(`[SYNC COMPLETE] ${destination} synced for client ${clientId} (${totalRecords} records in ${durationMs}ms)`);
    console.log(`[COMPLETION BOUNDARY] Recorded lastSuccessfulSync = ${completionBoundaryIso}\n`);

    res.json({
      success: true,
      syncType: destination,
      destination,
      status: 'COMPLETED',
      versionId: nextVersion,
      spreadsheetId: fileId,
      spreadsheetUrl: sheetUrl,
      sheetUrl,
      fileId,
      recordsProcessed: totalRecords,
      durationMs,
      lastSyncAt: completionBoundaryIso,
      strategy: {
        sales: useIncrementalSales ? 'INCREMENTAL' : 'FULL',
        purchase: useIncrementalPO ? 'INCREMENTAL' : 'FULL',
        inventory: 'CURRENT_AVAILABILITY'
      },
      breakdown: {
        sales: salesData.rows.length,
        inventory: invData.rows.length,
        purchaseOrders: poData.rows.length
      }
    });
  } catch (err) {
    console.error('Error in Cin7 sync:', err.message);
    const durationMs = Date.now() - startTime;
    updateProgress('FAILED', 0, 4, 0, `Sync failed: ${err.message}`);

    await db.query(
      `UPDATE sync_runs 
       SET status = 'FAILED', error_message = ?, duration_ms = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND client_id = ?`,
      [err.message, durationMs, runId, clientId]
    );

    res.status(500).json({
      success: false,
      status: 'FAILED',
      errorMessage: err.message,
      durationMs
    });
  } finally {
    lockService.releaseLock(clientId, runId);
  }
});

/**
 * GET /api/sync/history
 * Returns paginated audit history for the authenticated client.
 */
router.get('/history', enforceTenantIsolation, async (req, res) => {
  const clientId = req.tenantId;
  const page = parseInt(req.query.page || 1, 10);
  const pageSize = parseInt(req.query.pageSize || 20, 10);
  const offset = (page - 1) * pageSize;

  const totalRes = await db.query(
    'SELECT COUNT(*) as total FROM sync_runs WHERE client_id = ?',
    [clientId]
  );
  const total = totalRes.rows[0]?.total || 0;

  const runs = await db.query(
    `SELECT * FROM sync_runs 
     WHERE client_id = ? 
     ORDER BY created_at DESC 
     LIMIT ? OFFSET ?`,
    [clientId, pageSize, offset]
  );

  const items = (runs.rows || []).map(r => ({
    id: r.id,
    runId: r.run_id,
    syncType: r.sync_type,
    status: r.status,
    recordsProcessed: r.records_processed,
    durationMs: r.duration_ms,
    durationFormatted: r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '-',
    errorMessage: r.error_message,
    versionId: r.excel_version_id,
    createdAt: r.created_at,
    completedAt: r.completed_at
  }));

  res.json({
    success: true,
    page,
    pageSize,
    totalRecords: total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    syncRuns: items
  });
});

/**
 * POST /api/sync/history/:historyId/session
 * Generates a read-only document editor session for a historical version snapshot.
 */
router.post('/history/:historyId/session', requireActiveSubscription, enforceTenantIsolation, async (req, res) => {
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

/**
 * GET /api/sync/destination/google
 * Retrieves the client's live synced Google Sheet URL
 */
router.get('/destination/google', enforceTenantIsolation, async (req, res) => {
  const clientId = req.tenantId;
  try {
    let dest = await db.getOne(
      "SELECT * FROM destination_files WHERE client_id = ? AND provider = 'google' ORDER BY created_at DESC",
      [clientId]
    );

    if (!dest) {
      const GoogleSheetsAdapter = require('../services/googleSheetsAdapter');
      const adapter = new GoogleSheetsAdapter(clientId, req.user);
      dest = await adapter.getOrCreateDestination(req.user?.email);
    }

    res.json({
      success: true,
      spreadsheetId: dest.file_id,
      spreadsheetUrl: dest.file_url,
      fileUrl: dest.file_url,
      fileId: dest.file_id,
      fileName: dest.file_name
    });
  } catch (err) {
    console.error('Error fetching Google destination:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
