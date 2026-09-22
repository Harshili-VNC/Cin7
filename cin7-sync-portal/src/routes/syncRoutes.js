const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireActiveSubscription, requireCanSync, requireSuperAdmin } = require('../middleware/authMiddleware');
const { enforceTenantIsolation } = require('../middleware/tenantMiddleware');
const { syncLimiter } = require('../middleware/rateLimitMiddleware');
const cin7Engine = require('../services/cin7Engine');
const MicrosoftExcelAdapter = require('../services/microsoftExcelAdapter');
const clientStorageService = require('../services/clientStorageService');
const editorService = require('../services/editorService');
const snapshotService = require('../services/snapshotService');
const lockService = require('../services/lockService');

// Global authentication & tenant isolation on all sync routes
router.use(requireAuth);
router.use(enforceTenantIsolation);

const activeSyncProgress = new Map();
const activeSyncControllers = new Map(); // clientId -> { runId, cancelRequested: boolean }

/**
 * Helper to update live progress for UI polling
 */
function setLiveProgress(runId, stage, current, total, percent, message, clientId = null, extra = {}) {
  const existing = activeSyncProgress.get(runId) || {};
  const updated = {
    ...existing,
    runId,
    clientId: clientId || existing.clientId,
    stage,
    current,
    total,
    percent,
    message,
    timestamp: new Date().toISOString(),
    ...extra
  };
  activeSyncProgress.set(runId, updated);

  if (clientId) {
    lockService.touchLock(clientId, runId);
  }
}

/**
 * GET /api/sync/progress/:runId or GET /api/sync/progress/latest
 * Returns live progress of active sync execution for UI polling (strictly scoped to tenant)
 */
router.get(['/progress/:runId', '/progress'], async (req, res) => {
  const clientId = req.tenantId;
  const runId = req.params.runId;
  if (runId && activeSyncProgress.has(runId)) {
    const progress = activeSyncProgress.get(runId);
    if (progress.clientId === clientId) {
      return res.json({ success: true, progress });
    }
  }

  // Fallback to most recent progress for this specific tenant
  const entries = Array.from(activeSyncProgress.entries());
  const tenantEntries = entries.filter(([_, p]) => p.clientId === clientId);
  if (tenantEntries.length > 0) {
    const latest = tenantEntries[tenantEntries.length - 1][1];
    return res.json({ success: true, progress: latest });
  }

  // Fallback to DB sync_runs for historical or recent runs
  try {
    const latestDbRun = await db.getOne(
      'SELECT * FROM sync_runs WHERE client_id = ? ORDER BY created_at DESC LIMIT 1',
      [clientId]
    );
    if (latestDbRun) {
      return res.json({
        success: true,
        progress: {
          runId: latestDbRun.run_id || latestDbRun.id,
          stage: latestDbRun.status === 'RUNNING' ? 'FETCHING' : (latestDbRun.status === 'COMPLETED' ? 'COMPLETED' : 'IDLE'),
          status: latestDbRun.status,
          current: latestDbRun.records_processed || 0,
          total: latestDbRun.records_processed || 0,
          percent: latestDbRun.status === 'COMPLETED' ? 100 : (latestDbRun.status === 'RUNNING' ? 50 : 0),
          message: latestDbRun.status === 'COMPLETED' ? 'Sync complete' : (latestDbRun.status === 'RUNNING' ? 'Sync in progress...' : 'Ready'),
          sheetUrl: null
        }
      });
    }
  } catch (e) {}

  return res.json({
    success: true,
    progress: { stage: 'IDLE', current: 0, total: 0, percent: 100, message: 'Ready' }
  });
});

/**
 * GET /api/sync/status
 * Returns sync lock and background execution status for active tenant.
 */
router.get('/status', enforceTenantIsolation, async (req, res) => {
  const clientId = req.tenantId;
  const isLocked = lockService.isLocked(clientId);
  const activeCtrl = activeSyncControllers.get(clientId);

  let activeProgress = null;
  if (activeCtrl && activeSyncProgress.has(activeCtrl.runId)) {
    activeProgress = activeSyncProgress.get(activeCtrl.runId);
  }

  const lastRun = await db.getOne(
    'SELECT * FROM sync_runs WHERE client_id = ? ORDER BY created_at DESC LIMIT 1',
    [clientId]
  );

  return res.json({
    success: true,
    isSyncing: isLocked,
    activeRunId: activeCtrl?.runId || null,
    activeProgress,
    lastRun: lastRun ? {
      id: lastRun.id,
      runId: lastRun.run_id,
      status: lastRun.status,
      recordsProcessed: lastRun.records_processed,
      durationMs: lastRun.duration_ms,
      completedAt: lastRun.completed_at
    } : null
  });
});

/**
 * POST /api/sync/temp-fix-formulas
 * TEMPORARY one-off admin utility: strips the Family="Finished Goods" filter out of
 * KPI Dashboard (and related tabs) SUMIFS/COUNTIFS formulas on the master template and
 * a given spreadsheet, since that field is not currently populated by the Cin7 sync.
 * Remove this route once no longer needed.
 *
 * SUPER_ADMIN only: this utility can rewrite formulas on any client's live spreadsheet,
 * so it must not be reachable by a regular (single-tenant) authenticated user. The target
 * spreadsheetIds are also restricted to the shared master template plus IDs already on
 * record as a provisioned client destination — arbitrary/unknown IDs are rejected so the
 * endpoint can't be pointed at a spreadsheet outside the platform's own tenants.
 */
router.post('/temp-fix-formulas', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const MASTER_TEMPLATE_ID = process.env.GoogleMasterTemp || '1Qnx6RdCgI7krHtZru10J6r11ZpIkubCSR1jzUbs5G9Q';
    const requestedIds = Array.isArray(req.body?.spreadsheetIds) && req.body.spreadsheetIds.length
      ? req.body.spreadsheetIds
      : [MASTER_TEMPLATE_ID];

    const knownDestRes = await db.query("SELECT DISTINCT file_id FROM destination_files WHERE provider = 'google'");
    const knownIds = new Set((knownDestRes.rows || []).map(r => r.file_id));
    knownIds.add(MASTER_TEMPLATE_ID);

    const targetIds = requestedIds.filter(id => knownIds.has(id));
    const rejectedIds = requestedIds.filter(id => !knownIds.has(id));
    if (rejectedIds.length) {
      console.warn('[TEMP FIX FORMULAS] Rejected unknown spreadsheetId(s) not on record for any tenant:', rejectedIds);
    }
    if (!targetIds.length) {
      return res.status(400).json({ success: false, error: 'No valid spreadsheetIds. Each ID must be the master template or a spreadsheet already provisioned for a client.', rejectedIds });
    }

    const GoogleSheetsAdapter = require('../services/googleSheetsAdapter');
    const adapter = new GoogleSheetsAdapter(req.tenantId, req.user || req.session?.user || null);
    const { sheets } = await adapter.getGoogleClients();

    const FAMILY_FILTER_RE = /,\s*'Sales Transactions Raw Data'!J:J\s*,\s*"Finished Goods"/g;
    const results = {};

    for (const spreadsheetId of targetIds) {
      const changed = [];
      const meta = await sheets.spreadsheets.get({ spreadsheetId, includeGridData: false });
      const sheetNames = meta.data.sheets.map(s => s.properties.title);

      const dataRes = await sheets.spreadsheets.get({
        spreadsheetId,
        includeGridData: true,
        ranges: sheetNames.map(n => `'${n}'`)
      });

      const requests = [];
      for (const sheet of dataRes.data.sheets) {
        const sheetId = sheet.properties.sheetId;
        const sheetName = sheet.properties.title;
        for (const grid of (sheet.data || [])) {
          const startRow = grid.startRow || 0;
          const startCol = grid.startColumn || 0;
          (grid.rowData || []).forEach((row, rIdx) => {
            (row.values || []).forEach((cell, cIdx) => {
              const formula = cell.userEnteredValue && cell.userEnteredValue.formulaValue;
              if (formula && FAMILY_FILTER_RE.test(formula)) {
                const newFormula = formula.replace(FAMILY_FILTER_RE, '');
                requests.push({
                  updateCells: {
                    range: {
                      sheetId,
                      startRowIndex: startRow + rIdx,
                      endRowIndex: startRow + rIdx + 1,
                      startColumnIndex: startCol + cIdx,
                      endColumnIndex: startCol + cIdx + 1
                    },
                    rows: [{ values: [{ userEnteredValue: { formulaValue: newFormula } }] }],
                    fields: 'userEnteredValue.formulaValue'
                  }
                });
                changed.push({ sheet: sheetName, row: startRow + rIdx + 1, col: startCol + cIdx + 1, from: formula, to: newFormula });
              }
            });
          });
        }
      }

      for (let i = 0; i < requests.length; i += 100) {
        const chunk = requests.slice(i, i + 100);
        await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: chunk } });
      }

      results[spreadsheetId] = { changedCount: changed.length, changed };
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error('[TEMP FIX FORMULAS ERROR]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/sync/cancel
 * Cancels an in-progress background sync job and releases the tenant mutex lock.
 */
router.post('/cancel', requireAuth, enforceTenantIsolation, async (req, res) => {
  const clientId = req.tenantId;
  const ctrl = activeSyncControllers.get(clientId);

  if (!ctrl) {
    lockService.releaseLock(clientId);
    return res.json({ success: true, message: 'No active sync running to cancel.' });
  }

  ctrl.cancelRequested = true;
  const runId = ctrl.runId;

  setLiveProgress(runId, 'CANCELLED', 0, 5, 0, 'Sync was cancelled by user.', clientId, {
    status: 'CANCELLED',
    message: 'Sync was cancelled by user.'
  });

  try {
    await db.query(
      `UPDATE sync_runs SET status = 'CANCELLED', error_message = 'Sync cancelled by user.', completed_at = CURRENT_TIMESTAMP WHERE id = ? AND client_id = ?`,
      [runId, clientId]
    );
  } catch (e) {}

  lockService.releaseLock(clientId, runId);
  activeSyncControllers.delete(clientId);

  return res.json({ success: true, message: 'Sync cancellation requested.', runId });
});

/**
 * Background Execution Worker Function for Full Sync
 */
async function executeFullSyncBackground({
  runId,
  clientId,
  user,
  destination,
  dateRange,
  startDate,
  endDate,
  isForceFull,
  clientEmail,
  startTime
}) {
  const isCancelled = () => {
    const ctrl = activeSyncControllers.get(clientId);
    return ctrl?.runId === runId && ctrl.cancelRequested;
  };

  const updateProgress = (stage, current, total, percent, message, extra = {}) => {
    setLiveProgress(runId, stage, current, total, percent, message, clientId, extra);
  };

  try {
    updateProgress('CONNECTING', 0, 5, 10, 'Connecting to Cin7 Core API...');

    // 1. Resolve & verify credentials exist for tenant
    console.log(`[CIN7 CREDENTIALS] Loading tenant Cin7 credentials for '${clientId}'...`);
    const creds = await cin7Engine.getClientCin7Credentials(clientId);
    console.log(`[CIN7 CREDENTIALS] Credentials loaded successfully from ${creds.source} (Account ID: ${creds.username.substring(0, 8)}...)`);

    if (isCancelled()) throw Object.assign(new Error('Sync was cancelled by user.'), { code: 'SYNC_CANCELLED' });

    // 2. Evaluate Incremental Sync Safety
    const salesSafety = dateRange === 'custom' ? { safe: false, reason: 'Custom date range requires full fetch' } : await snapshotService.isIncrementalSafe(clientId, 'sales', dateRange);
    const poSafety = dateRange === 'custom' ? { safe: false, reason: 'Custom date range requires full fetch' } : await snapshotService.isIncrementalSafe(clientId, 'purchase', dateRange);

    const useIncrementalSales = !isForceFull && salesSafety.safe;
    const useIncrementalPO = !isForceFull && poSafety.safe;

    const windowCutoff = cin7Engine.getWindowCutoffDate(dateRange, startDate);
    const windowCutoffIso = windowCutoff ? windowCutoff.toISOString() : null;

    const salesUpdatedSince = useIncrementalSales ? salesSafety.updatedSince : windowCutoffIso;
    const poUpdatedSince = useIncrementalPO ? poSafety.updatedSince : windowCutoffIso;

    console.log(`  Date Range Selected: ${dateRange} ${startDate ? `[${startDate} to ${endDate || 'now'}]` : ''} (Window Cutoff: ${windowCutoffIso || 'All Time'})`);
    console.log(`  Sales Strategy: ${useIncrementalSales ? `INCREMENTAL (${salesSafety.reason})` : `FULL WINDOW FETCH (${salesSafety.reason})`}`);
    console.log(`  Purchase Strategy: ${useIncrementalPO ? `INCREMENTAL (${poSafety.reason})` : `FULL WINDOW FETCH (${poSafety.reason})`}`);
    console.log(`  Inventory Strategy: CURRENT AVAILABILITY SNAPSHOT\n`);

    updateProgress('FETCHING', 1, 5, 20, useIncrementalSales ? 'Checking for new/modified records since last sync...' : 'Extracting Sales, Inventory & Purchases...');

    // 3. Fetch real Cin7 datasets sequentially
    const fetchedSales = await cin7Engine.fetchSales(clientId, {
      updatedSince: salesUpdatedSince,
      isCancelled,
      onProgress: (p) => {
        if (p.stage === 'PRODUCT_MASTER') {
          const pct = Math.round(52 + ((p.percent || 0) * 0.08));
          updateProgress('ENRICHING', p.current, p.total, pct, p.message || 'Loading Product Master catalog...');
        } else {
          const pct = Math.round(20 + ((p.percent || 0) * 0.32));
          updateProgress('ENRICHING', p.current, p.total, pct, p.message, {
            cachedCount: p.cachedCount,
            uncachedCount: p.uncachedCount,
            etaSeconds: p.etaSeconds
          });
        }
      }
    });

    if (isCancelled()) throw Object.assign(new Error('Sync was cancelled by user.'), { code: 'SYNC_CANCELLED' });

    updateProgress('ENRICHING', 0, 0, 60, 'Processing Inventory stock from Cin7...');
    const invData = await cin7Engine.fetchInventory(clientId, {
      isCancelled,
      onProgress: (p) => {
        updateProgress('ENRICHING', p.current, p.total, 62, p.message);
      }
    });

    if (isCancelled()) throw Object.assign(new Error('Sync was cancelled by user.'), { code: 'SYNC_CANCELLED' });

    updateProgress('ENRICHING', 0, 0, 65, 'Fetching Purchase Orders from Cin7...');
    const fetchedPO = await cin7Engine.fetchPurchaseOrders(clientId, {
      updatedSince: poUpdatedSince,
      isCancelled,
      onProgress: (p) => {
        const pct = Math.round(65 + ((p.percent || 0) * 0.05));
        updateProgress('ENRICHING', p.current, p.total, pct, p.message);
      }
    });

    if (isCancelled()) throw Object.assign(new Error('Sync was cancelled by user.'), { code: 'SYNC_CANCELLED' });

    updateProgress('VALIDATING', 2, 5, 70, 'Validating schemas and filtering rolling window...');

    // 4. Upsert / Merge & Rolling Window Filter for Sales
    let finalSalesRows = [];
    if (useIncrementalSales) {
      const existingSales = await snapshotService.getCurrentReportRows(clientId, 'sales');
      const mergedSales = cin7Engine.mergeSalesData(existingSales.rows, fetchedSales.rows);
      finalSalesRows = cin7Engine.filterSalesByWindow(mergedSales, dateRange, { startDate, endDate });
      console.log(`[SALES UPSERT] Existing: ${existingSales.rows.length}, Delta fetched: ${fetchedSales.rows.length}, Merged & Rolling Filter (${dateRange}): ${finalSalesRows.length}`);
    } else {
      finalSalesRows = cin7Engine.filterSalesByWindow(fetchedSales.rows, dateRange, { startDate, endDate });
    }
    const salesData = { headers: fetchedSales.headers, rows: finalSalesRows };

    // 5. Upsert / Merge & Rolling Window Filter for Purchase
    let finalPORows = [];
    if (useIncrementalPO) {
      const existingPO = await snapshotService.getCurrentReportRows(clientId, 'purchase');
      const mergedPO = cin7Engine.mergePurchaseData(existingPO.rows, fetchedPO.rows);
      finalPORows = cin7Engine.filterPurchaseByWindow(mergedPO, dateRange, { startDate, endDate });
      console.log(`[PURCHASE UPSERT] Existing: ${existingPO.rows.length}, Delta fetched: ${fetchedPO.rows.length}, Merged & Rolling Filter (${dateRange}): ${finalPORows.length}`);
    } else {
      finalPORows = cin7Engine.filterPurchaseByWindow(fetchedPO.rows, dateRange, { startDate, endDate });
    }
    const poData = { headers: fetchedPO.headers, rows: finalPORows };

    // 6. Strict Data Validation across all three datasets BEFORE destination write
    console.log('[DATA VALIDATION] Running pre-write schema and type validation...');
    const salesVal = cin7Engine.validateSalesData(salesData, { allowEmpty: true });
    const invVal = cin7Engine.validateInventoryData(invData, { allowEmpty: true });
    const poVal = cin7Engine.validatePurchaseData(poData, { allowEmpty: true });
    console.log(`  - Sales: PASS (${salesVal.rowCount} rows)`);
    console.log(`  - Inventory: PASS (${invVal.rowCount} rows)`);
    console.log(`  - Purchase: PASS (${poVal.rowCount} rows)\n`);

    const totalRecords = salesData.rows.length + invData.rows.length + poData.rows.length;
    let sheetUrl = null;
    let fileId = null;
    let dest = null;
    let nextVersion = 'v1.0';

    // salesData/poData rows carry an internal, trailing "true Order Date" field (used above by
    // filterSalesByWindow/filterPurchaseByWindow) that isn't part of the documented sheet schema.
    // Strip it before writing to the client-facing spreadsheet so no stray, unlabeled column
    // appears — the untouched salesData/poData (with the field) still gets persisted to the
    // snapshot below, so the next incremental sync can keep filtering by real order date.
    const stripInternalFields = (dataset) => ({
      headers: dataset.headers,
      rows: dataset.rows.map(r => r.slice(0, dataset.headers.length))
    });
    const salesDataOut = stripInternalFields(salesData);
    const poDataOut = stripInternalFields(poData);

    const clientRecord = await db.getOne('SELECT * FROM clients WHERE id = ?', [clientId]);
    const currentVersion = clientRecord?.current_version || 'v1.0';
    nextVersion = clientStorageService.calculateNextVersion(currentVersion);

    updateProgress('POPULATING', 3, 5, 80, destination === 'google_sheets' ? 'Cloning & populating Master Google Sheets raw data...' : 'Populating Master Model Excel sheets...');

    // 7. Write to Destination (Google Sheets or Excel)
    if (destination === 'google_sheets') {
      const GoogleSheetsAdapter = require('../services/googleSheetsAdapter');
      const adapter = new GoogleSheetsAdapter(clientId, user);

      // Clone master template into brand-new spreadsheet with client and user info
      dest = await adapter.createGoogleSheetFromTemplate(clientEmail, {
        clientName: clientRecord?.company_name,
        syncedBy: user?.full_name || user?.fullName || user?.email
      });
      const newSpreadsheetId = dest.file_id;

      // Populate raw data sheets starting at row A7
      await adapter.syncSales(salesDataOut, clientEmail, dest);
      await adapter.syncInventory(invData, clientEmail, dest);
      await adapter.syncPurchaseOrders(poDataOut, clientEmail, dest);

      // Update dynamic report formulas
      updateProgress('CALCULATING', 4, 5, 90, 'Updating dynamic dashboard and KPI formulas...');
      await adapter.updateClonedReportFormulas(newSpreadsheetId, salesDataOut, invData, { dateRange, startDate, endDate });

      await adapter.updateSyncLog({
        syncType: 'google_sheets',
        status: 'Success',
        detail: `Google Sheets Sync: ${totalRecords} records cloned & updated into ${newSpreadsheetId}`,
        runId
      }, clientEmail, dest);

      // 8. Read-back Verification
      updateProgress('VERIFYING', 4, 5, 95, 'Verifying written Google Sheets data on read-back...');
      await adapter.verifyDataWritten(newSpreadsheetId, {
        sales: salesData.rows.length,
        inventory: invData.rows.length,
        purchase: poData.rows.length
      });

      sheetUrl = dest.file_url;
      fileId = dest.file_id;
    } else {
      const adapter = new MicrosoftExcelAdapter(clientId, user);
      await adapter.syncSales(salesDataOut);
      await adapter.syncInventory(invData);
      await adapter.syncPurchaseOrders(poDataOut, nextVersion);
      await adapter.updateSyncLog({
        syncType: 'all',
        status: 'Success',
        detail: `Full Sync (${nextVersion}): ${totalRecords} records updated`,
        runId
      });
    }

    if (isCancelled()) throw Object.assign(new Error('Sync was cancelled by user.'), { code: 'SYNC_CANCELLED' });

    // 9. STAGING/COMMIT: PROMOTE SNAPSHOTS ONLY ON COMPLETE VERIFIED SUCCESS
    console.log('[SNAPSHOT COMMIT] Committing active current reports and immutable snapshots...');
    let periodLabel = 'Last 90 Days';
    if (dateRange === 'custom') {
      periodLabel = `Custom (${startDate || 'Start'} to ${endDate || 'Today'})`;
    } else if (dateRange === '30d' || /30/i.test(String(dateRange))) {
      periodLabel = 'Last 30 Days';
    } else if (dateRange === '60d' || /60/i.test(String(dateRange))) {
      periodLabel = 'Last 60 Days';
    } else if (dateRange === '90d' || /90/i.test(String(dateRange))) {
      periodLabel = 'Last 90 Days';
    } else if (dateRange === 'last_year' || dateRange === '365d' || dateRange === '1y' || /last.*year|365/i.test(String(dateRange))) {
      periodLabel = 'Last Year (365 Days)';
    } else if (dateRange === 'ytd' || /ytd|year to date/i.test(String(dateRange))) {
      periodLabel = 'Year to Date (YTD)';
    } else if (dateRange === '2y' || /2\s*y|24\s*m/i.test(String(dateRange))) {
      periodLabel = 'Last 2 Years (24 Months)';
    } else if (dateRange === '5y' || /5\s*y/i.test(String(dateRange))) {
      periodLabel = 'Last 5 Years';
    }

    await Promise.all([
      snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'sales', periodLabel, dataset: salesData, syncRunId: runId }),
      snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'inventory', periodLabel: 'Current Stock', dataset: invData, syncRunId: runId }),
      snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'purchase', periodLabel, dataset: poData, syncRunId: runId })
    ]);

    const durationMs = Date.now() - startTime;
    const completionBoundaryIso = new Date().toISOString();

    // 10. Update database records
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
    } else {
      await db.query(
        `UPDATE clients 
         SET last_sync_at = ?, sync_status = 'SYNCED'
         WHERE id = ?`,
        [completionBoundaryIso, clientId]
      );
    }

    // 11. Update Persistent Sync State with Completion Boundary Timestamp
    await snapshotService.updateSyncState(clientId, 'sales', {
      reportWindow: dateRange,
      lastSuccessfulSync: completionBoundaryIso,
      lastSyncRunId: runId,
      recordCount: salesData.rows.length
    });
    await snapshotService.updateSyncState(clientId, 'purchase', {
      reportWindow: dateRange,
      lastSuccessfulSync: completionBoundaryIso,
      lastSyncRunId: runId,
      recordCount: poData.rows.length
    });
    await snapshotService.updateSyncState(clientId, 'inventory', {
      reportWindow: 'current',
      lastSuccessfulSync: completionBoundaryIso,
      lastSyncRunId: runId,
      recordCount: invData.rows.length
    });

    const completionPayload = {
      success: true,
      syncType: destination,
      destination,
      status: 'COMPLETED',
      versionId: nextVersion,
      spreadsheetId: fileId,
      spreadsheetUrl: sheetUrl,
      sheetUrl,
      fileId,
      fileName: dest?.file_name || null,
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
    };

    updateProgress('COMPLETED', 5, 5, 100, 'Sync complete! All reports verified.', {
      status: 'COMPLETED',
      result: completionPayload,
      sheetUrl,
      spreadsheetUrl: sheetUrl,
      fileId,
      recordsProcessed: totalRecords,
      breakdown: completionPayload.breakdown
    });

    console.log(`[SYNC COMPLETE] ${destination} synced for client ${clientId} (${totalRecords} records in ${durationMs}ms)`);
    console.log(`[COMPLETION BOUNDARY] Recorded lastSuccessfulSync = ${completionBoundaryIso}\n======================================================================\n`);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const isCancel = err.code === 'SYNC_CANCELLED';
    let safeError = err.message || 'Cin7 synchronization failed.';
    let isGoogleAuthError = false;
    if (/invalid_grant|No access, refresh token|Invalid Credentials|unauthorized_client/i.test(safeError)) {
      safeError = 'Google Sheets authorization has expired. Please click "Authorize Google" to reconnect.';
      isGoogleAuthError = true;
    }
    console.error(`\n[SYNC ${isCancel ? 'CANCELLED' : 'FAILED'}] Run: ${runId} for client ${clientId}: ${safeError}`);

    const finalStatus = isCancel ? 'CANCELLED' : 'FAILED';

    updateProgress(finalStatus, 0, 5, 0, safeError, {
      status: finalStatus,
      error: safeError,
      isGoogleAuthError
    });

    await db.query(
      `UPDATE sync_runs 
       SET status = ?, error_message = ?, duration_ms = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND client_id = ?`,
      [finalStatus, safeError, durationMs, runId, clientId]
    );
  } finally {
    activeSyncControllers.delete(clientId);
    lockService.releaseLock(clientId, runId);
  }
}

/**
 * POST /api/sync/sales
 */
router.post('/sales', requireAuth, enforceTenantIsolation, requireCanSync, requireActiveSubscription, async (req, res) => {
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

    // 1. Fetch live sales
    const salesData = await cin7Engine.fetchSales(clientId);

    // 2. Validate
    cin7Engine.validateSalesData(salesData);

    // 3. Write to destination
    const adapter = new MicrosoftExcelAdapter(clientId, req.user);
    await adapter.syncSales(salesData);
    await adapter.updateSyncLog({ syncType: 'sales', status: 'Success', detail: `${salesData.rows.length} sales rows synced`, runId });

    // 4. Save snapshot on verified success
    await snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'sales', periodLabel: 'Last 30 days', dataset: salesData, syncRunId: runId });

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
    console.error(`[SYNC ERROR] Sales sync failed for ${clientId}:`, err.message);
    const durationMs = Date.now() - startTime;
    const safeError = err.message || 'Sales synchronization failed.';

    await db.query(
      `UPDATE sync_runs 
       SET status = 'FAILED', error_message = ?, duration_ms = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [safeError, durationMs, runId]
    );

    res.status(500).json({
      success: false,
      syncType: 'sales',
      status: 'FAILED',
      errorMessage: safeError
    });
  } finally {
    lockService.releaseLock(clientId, runId);
  }
});

/**
 * POST /api/sync/inventory
 */
router.post('/inventory', requireAuth, enforceTenantIsolation, requireCanSync, requireActiveSubscription, async (req, res) => {
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

    // 1. Fetch live inventory
    const invData = await cin7Engine.fetchInventory(clientId);

    // 2. Validate
    cin7Engine.validateInventoryData(invData);

    // 3. Write to destination
    const adapter = new MicrosoftExcelAdapter(clientId, req.user);
    await adapter.syncInventory(invData);
    await adapter.updateSyncLog({ syncType: 'inventory', status: 'Success', detail: `${invData.rows.length} inventory rows synced`, runId });

    // 4. Save snapshot on verified success
    await snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'inventory', periodLabel: 'Current', dataset: invData, syncRunId: runId });

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
    console.error(`[SYNC ERROR] Inventory sync failed for ${clientId}:`, err.message);
    const durationMs = Date.now() - startTime;
    const safeError = err.message || 'Inventory synchronization failed.';

    await db.query(
      `UPDATE sync_runs 
       SET status = 'FAILED', error_message = ?, duration_ms = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [safeError, durationMs, runId]
    );

    res.status(500).json({
      success: false,
      syncType: 'inventory',
      status: 'FAILED',
      errorMessage: safeError
    });
  } finally {
    lockService.releaseLock(clientId, runId);
  }
});

/**
 * POST /api/sync/purchase-orders
 */
router.post('/purchase-orders', requireAuth, enforceTenantIsolation, requireCanSync, requireActiveSubscription, async (req, res) => {
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

    // 1. Fetch live POs
    const poData = await cin7Engine.fetchPurchaseOrders(clientId);

    // 2. Validate
    cin7Engine.validatePurchaseData(poData);

    // 3. Write to destination
    const adapter = new MicrosoftExcelAdapter(clientId, req.user);
    await adapter.syncPurchaseOrders(poData);
    await adapter.updateSyncLog({ syncType: 'purchase_orders', status: 'Success', detail: `${poData.rows.length} PO rows synced`, runId });

    // 4. Save snapshot on verified success
    await snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'purchase', periodLabel: 'Last 30 days', dataset: poData, syncRunId: runId });

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
    console.error(`[SYNC ERROR] PO sync failed for ${clientId}:`, err.message);
    const durationMs = Date.now() - startTime;
    const safeError = err.message || 'Purchase Orders synchronization failed.';

    await db.query(
      `UPDATE sync_runs 
       SET status = 'FAILED', error_message = ?, duration_ms = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [safeError, durationMs, runId]
    );

    res.status(500).json({
      success: false,
      syncType: 'purchase_orders',
      status: 'FAILED',
      errorMessage: safeError
    });
  } finally {
    lockService.releaseLock(clientId, runId);
  }
});

/**
 * POST /api/sync/all & POST /api/sync/trigger
 * Full sync: Initiates asynchronous background execution (202 Accepted) with non-blocking live polling.
 */
router.post(['/all', '/trigger'], syncLimiter, requireCanSync, async (req, res) => {
  const authenticatedUser = req.user || req.session?.user || null;
  const clientId = req.tenantId;

  const startTime = Date.now();
  const runId = `run-all-${uuidv4().substring(0, 8)}`;
  const destination = req.body?.destination || 'google_sheets';
  const clientEmail = authenticatedUser?.email || null;
  const dateRange = req.body?.dateRange || req.body?.timelinePeriod || '90d';
  const startDate = req.body?.startDate || null;
  const endDate = req.body?.endDate || null;
  const isForceFull = Boolean(req.body?.forceFull || req.body?.mode === 'FORCE_FULL');

  // Per-Client Concurrency Mutex Lock
  const lockRes = lockService.acquireLock(clientId, runId);
  if (!lockRes.acquired) {
    const activeCtrl = activeSyncControllers.get(clientId);
    return res.status(409).json({
      success: false,
      error: 'SYNC_ALREADY_IN_PROGRESS',
      message: lockRes.reason,
      currentLock: lockRes.currentLock,
      activeRunId: activeCtrl?.runId || lockRes.currentLock?.runId
    });
  }

  // Register active controller for graceful cancellation
  activeSyncControllers.set(clientId, { runId, cancelRequested: false });

  // Initial live progress
  setLiveProgress(runId, 'CONNECTING', 0, 5, 10, 'Connecting to Cin7 Core API...', clientId, {
    status: 'RUNNING',
    destination,
    dateRange,
    startDate,
    endDate
  });

  console.log(`\n======================================================================`);
  console.log(`[SYNC TRIGGER] Run: ${runId} | Tenant: ${clientId} | Window: ${dateRange} ${startDate ? `[${startDate} to ${endDate || 'now'}]` : ''} | ForceFull: ${isForceFull} | Destination: ${destination}`);
  console.log(`======================================================================`);

  try {
    await db.query(
      `INSERT INTO sync_runs (id, client_id, user_id, run_id, sync_type, status)
       VALUES (?, ?, ?, ?, ?, 'RUNNING')`,
      [runId, clientId, authenticatedUser?.id || 'system', runId, destination === 'google_sheets' ? 'google_sheets' : 'all']
    );

    // Spawn non-blocking background job
    setImmediate(() => {
      executeFullSyncBackground({
        runId,
        clientId,
        user: authenticatedUser,
        destination,
        dateRange,
        startDate,
        endDate,
        isForceFull,
        clientEmail,
        startTime
      }).catch(err => {
        console.error(`[BACKGROUND SYNC UNCAUGHT ERROR] Run: ${runId}:`, err);
      });
    });

    // Return immediate 202 Accepted
    return res.status(202).json({
      success: true,
      status: 'RUNNING',
      runId,
      message: 'Cin7 background sync initiated.',
      destination,
      dateRange
    });
  } catch (err) {
    lockService.releaseLock(clientId, runId);
    activeSyncControllers.delete(clientId);
    console.error(`[SYNC TRIGGER ERROR] Failed to start run ${runId}:`, err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to start sync run.',
      message: err.message || 'Failed to start sync run.'
    });
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

  const items = (runs.rows || []).map(r => {
    let cleanType = r.sync_type || 'google_sheets';
    if (cleanType.startsWith('user-')) cleanType = 'google_sheets';
    let cleanStatus = (r.status || 'COMPLETED').toUpperCase();
    if (cleanStatus === r.run_id || cleanStatus === r.id) {
      cleanStatus = (r.records_processed > 0 || r.completed_at) ? 'COMPLETED' : 'COMPLETED';
    }
    // If status in DB is RUNNING but not currently active in memory, mark as INTERRUPTED
    if (cleanStatus === 'RUNNING') {
      const active = activeSyncProgress.get(r.run_id || r.id);
      if (!active || active.stage === 'COMPLETED' || active.stage === 'ERROR' || active.stage === 'IDLE') {
        cleanStatus = 'INTERRUPTED';
      }
    }
    return {
      id: r.id,
      runId: r.run_id,
      syncType: cleanType,
      status: cleanStatus,
      recordsProcessed: r.records_processed || 0,
      durationMs: r.duration_ms,
      durationFormatted: r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '-',
      errorMessage: r.error_message,
      versionId: r.excel_version_id,
      startedAt: r.started_at || r.created_at,
      createdAt: r.created_at,
      completedAt: r.completed_at
    };
  });

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
    let errMsg = err.message || 'Failed to fetch Google destination';
    let isGoogleAuthError = false;
    if (/invalid_grant|No access, refresh token|Invalid Credentials/i.test(errMsg)) {
      errMsg = 'Google Sheets authorization has expired. Please re-authorize Google.';
      isGoogleAuthError = true;
    }
    res.status(500).json({ success: false, error: errMsg, isGoogleAuthError, authUrl: '/api/auth/google/connect' });
  }
});

/**
 * POST /api/sync/pull-sheets
 * Pulls latest edits/data from the client's Google Sheet into the dashboard and snapshot store.
 */
router.post('/pull-sheets', requireAuth, enforceTenantIsolation, requireCanSync, requireActiveSubscription, async (req, res) => {
  const clientId = req.tenantId;
  const user = req.user;
  const startTime = Date.now();
  const runId = `run-pull-${uuidv4().substring(0, 8)}`;

  // Acquire mutex lock to prevent concurrent sync operations
  const lockRes = lockService.acquireLock(clientId, runId);
  if (!lockRes.acquired) {
    return res.status(409).json({
      success: false,
      error: 'SYNC_ALREADY_IN_PROGRESS',
      message: lockRes.reason || 'A sync operation is already in progress for this workspace.'
    });
  }

  try {
    // 1. Resolve spreadsheet ID strictly from this tenant's own destination_files row.
    //    A client-supplied spreadsheetId is never trusted here: every generated sheet is
    //    shared "anyone with the link", so honoring an arbitrary ID would let one tenant
    //    pull another tenant's live Cin7 data into their own dashboard.
    let spreadsheetId = null;
    let spreadsheetUrl = null;
    let fileName = null;

    const dest = await db.getOne(
      "SELECT file_id, file_name, file_url FROM destination_files WHERE client_id = ? AND provider = 'google' ORDER BY created_at DESC LIMIT 1",
      [clientId]
    );
    if (dest) {
      spreadsheetId = dest.file_id;
      spreadsheetUrl = dest.file_url;
      fileName = dest.file_name;
    }

    if (!spreadsheetId) {
      return res.status(404).json({
        success: false,
        error: 'NO_GOOGLE_SHEET_FOUND',
        message: 'No Google Sheet destination found for this workspace. Please run a sync to Google Sheets first.'
      });
    }

    // 2. Read spreadsheet data using GoogleSheetsAdapter
    const GoogleSheetsAdapter = require('../services/googleSheetsAdapter');
    const adapter = new GoogleSheetsAdapter(clientId, user);
    
    console.log(`[PULL GOOGLE SHEETS] Reading latest data from spreadsheet ${spreadsheetId} for tenant ${clientId}...`);
    const sheetData = await adapter.readSpreadsheetData(spreadsheetId);

    const salesCount = sheetData.sales.rows.length;
    const invCount = sheetData.inventory.rows.length;
    const poCount = sheetData.purchase.rows.length;
    const totalRecords = salesCount + invCount + poCount;

    // 3. Reject completely empty sheets to avoid replacing valid snapshots with 0 records
    if (totalRecords === 0) {
      return res.status(422).json({
        success: false,
        error: 'EMPTY_SHEET_DATA',
        message: 'The Google Sheet contains no data rows in the Raw Data worksheets.'
      });
    }

    // 4. Strict schema & data validation before modifying any snapshots
    console.log('[PULL GOOGLE SHEETS] Validating extracted data against schema rules...');
    const salesVal = cin7Engine.validateSalesData(sheetData.sales, { allowEmpty: true });
    const invVal = cin7Engine.validateInventoryData(sheetData.inventory, { allowEmpty: true });
    const poVal = cin7Engine.validatePurchaseData(sheetData.purchase, { allowEmpty: true });

    console.log(`  - Sales validated: ${salesVal.rowCount} rows`);
    console.log(`  - Inventory validated: ${invVal.rowCount} rows`);
    console.log(`  - Purchase validated: ${poVal.rowCount} rows`);

    // 5. Atomic snapshot and current report updates (Only when validation completely passes)
    const periodLabel = 'Google Sheet Sync';
    await Promise.all([
      snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'sales', periodLabel, dataset: sheetData.sales, syncRunId: runId }),
      snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'inventory', periodLabel: 'Current Stock', dataset: sheetData.inventory, syncRunId: runId }),
      snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'purchase', periodLabel, dataset: sheetData.purchase, syncRunId: runId })
    ]);

    const durationMs = Date.now() - startTime;
    const completionBoundaryIso = new Date().toISOString();

    // 6. Record audit sync run and update client last_sync_at
    await db.query(
      `INSERT INTO sync_runs (id, client_id, user_id, run_id, sync_type, status, records_processed, duration_ms, excel_version_id, created_at, completed_at)
       VALUES (?, ?, ?, ?, 'google_sheet_pull', 'COMPLETED', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [runId, clientId, user?.id || 'system', runId, totalRecords, durationMs, spreadsheetId]
    );

    await db.query(
      `UPDATE clients SET last_sync_at = ?, sync_status = 'SYNCED' WHERE id = ?`,
      [completionBoundaryIso, clientId]
    );

    console.log(`[PULL GOOGLE SHEETS COMPLETE] ${totalRecords} records pulled and committed into dashboard snapshot (${durationMs}ms)`);

    return res.json({
      success: true,
      message: 'Successfully pulled latest data from Google Sheet into dashboard',
      runId,
      spreadsheetId,
      spreadsheetUrl,
      fileName,
      recordsProcessed: totalRecords,
      durationMs,
      breakdown: {
        sales: salesCount,
        inventory: invCount,
        purchaseOrders: poCount
      },
      lastSyncAt: completionBoundaryIso
    });
  } catch (err) {
    console.error(`[PULL GOOGLE SHEETS ERROR] Tenant ${clientId}:`, err.message);
    const durationMs = Date.now() - startTime;
    let safeError = err.message || 'Failed to pull data from Google Sheet.';
    let isGoogleAuthError = false;
    if (/invalid_grant|No access, refresh token|Invalid Credentials|unauthorized_client/i.test(safeError)) {
      safeError = 'Google Sheets authorization has expired. Please re-authorize Google.';
      isGoogleAuthError = true;
    }

    try {
      await db.query(
        `INSERT INTO sync_runs (id, client_id, user_id, run_id, sync_type, status, error_message, duration_ms, created_at, completed_at)
         VALUES (?, ?, ?, ?, 'google_sheet_pull', 'FAILED', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [runId, clientId, user?.id || 'system', runId, safeError, durationMs]
      );
    } catch (_) {}

    return res.status(500).json({
      success: false,
      error: safeError,
      message: safeError,
      isGoogleAuthError
    });
  } finally {
    lockService.releaseLock(clientId, runId);
  }
});

module.exports = router;
