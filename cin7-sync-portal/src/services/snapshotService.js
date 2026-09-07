const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const clientStorageService = require('./clientStorageService');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 6)}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

const REPORT_CONFIG = {
  sales: {
    id: 'sales',
    name: 'Sales by Product Details',
    category: 'Sales',
    defaultSheet: 'Sales Transactions Raw Data',
    getKey: (row, idx) => {
      const orderNo = String(row[2] || row[4] || `ORD-${idx}`).trim();
      const sku = String(row[5] || row[6] || `SKU-${idx}`).trim();
      return `${orderNo}__${sku}`;
    },
    metrics: [
      { key: 'quantity', index: 19, label: 'Quantity', type: 'number' },
      { key: 'revenue', index: 20, label: 'Revenue', type: 'currency' },
      { key: 'cogs', index: 22, label: 'COGS', type: 'currency' },
      { key: 'profit', index: 24, label: 'Gross Profit', type: 'currency' }
    ],
    displayCols: [
      { index: 2, label: 'Order #' },
      { index: 3, label: 'Date' },
      { index: 5, label: 'SKU' },
      { index: 6, label: 'Product' },
      { index: 11, label: 'Customer' },
      { index: 17, label: 'Channel' },
      { index: 19, label: 'Quantity', type: 'number' },
      { index: 20, label: 'Revenue ($)', type: 'currency' },
      { index: 22, label: 'COGS ($)', type: 'currency' },
      { index: 24, label: 'Profit ($)', type: 'currency' }
    ]
  },
  purchase: {
    id: 'purchase',
    name: 'Purchase Cost Analysis',
    category: 'Purchase',
    defaultSheet: 'Purchase Transactions Raw data',
    getKey: (row, idx) => {
      const poNo = String(row[4] || row[5] || `PO-${idx}`).trim();
      const sku = String(row[9] || `SKU-${idx}`).trim();
      const loc = String(row[12] || 'Main').trim();
      return `${poNo}__${sku}__${loc}`;
    },
    metrics: [
      { key: 'quantity', index: 15, label: 'Quantity', type: 'number' },
      { key: 'mainCost', index: 16, label: 'Main Cost', type: 'currency' },
      { key: 'additionalCost', index: 17, label: 'Additional Cost', type: 'currency' },
      { key: 'tax', index: 19, label: 'Tax', type: 'currency' }
    ],
    displayCols: [
      { index: 4, label: 'PO #' },
      { index: 2, label: 'Supplier' },
      { index: 9, label: 'SKU' },
      { index: 10, label: 'Product' },
      { index: 12, label: 'Location' },
      { index: 14, label: 'Status' },
      { index: 15, label: 'Quantity', type: 'number' },
      { index: 16, label: 'Main Cost ($)', type: 'currency' },
      { index: 17, label: 'Additional Cost ($)', type: 'currency' },
      { index: 19, label: 'Tax ($)', type: 'currency' }
    ]
  },
  inventory: {
    id: 'inventory',
    name: 'Product Availability',
    category: 'Inventory',
    defaultSheet: 'Inventory On Hand Raw Data',
    getKey: (row, idx) => {
      const loc = String(row[0] || 'Main Warehouse').trim();
      const sku = String(row[1] || `SKU-${idx}`).trim();
      return `${loc}__${sku}`;
    },
    metrics: [
      { key: 'quantityOnHand', index: 4, label: 'On Hand', type: 'number' },
      { key: 'allocated', index: 5, label: 'Allocated', type: 'number' },
      { key: 'onOrder', index: 6, label: 'On Order', type: 'number' },
      { key: 'available', index: 10, label: 'Available', type: 'number' },
      { key: 'unitCost', index: 8, label: 'Unit Cost', type: 'currency' }
    ],
    displayCols: [
      { index: 0, label: 'Location' },
      { index: 1, label: 'SKU' },
      { index: 2, label: 'Product' },
      { index: 3, label: 'Unit' },
      { index: 4, label: 'On Hand', type: 'number' },
      { index: 5, label: 'Allocated', type: 'number' },
      { index: 6, label: 'On Order', type: 'number' },
      { index: 7, label: 'In Transit', type: 'number' },
      { index: 8, label: 'Unit Cost ($)', type: 'currency' },
      { index: 10, label: 'Available', type: 'number' }
    ]
  }
};

class SnapshotService {
  constructor() {}

  getSafeClientId(clientId) {
    return clientStorageService.validateClientId(clientId);
  }

  getSyncStateFilePath(clientId) {
    const safeClientId = this.getSafeClientId(clientId);
    return clientStorageService.getClientSyncStatePath(safeClientId);
  }

  getSyncState(clientId) {
    const safeClientId = this.getSafeClientId(clientId);
    clientStorageService.safeMigrateLegacyClientData(safeClientId);

    const filePath = this.getSyncStateFilePath(safeClientId);
    if (fs.existsSync(filePath)) {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {}
    }
    return {
      clientId: safeClientId,
      reports: {
        sales: null,
        purchase: null,
        inventory: null
      }
    };
  }

  updateSyncState(clientId, reportType, stateData) {
    const safeClientId = this.getSafeClientId(clientId);
    const state = this.getSyncState(safeClientId);
    const config = this.getReportConfig(reportType);

    if (!state.reports) state.reports = {};
    state.reports[config.id] = {
      reportType: config.id,
      reportWindow: stateData.reportWindow || '30d',
      lastSuccessfulSync: stateData.lastSuccessfulSync || new Date().toISOString(),
      lastSyncRunId: stateData.lastSyncRunId || null,
      recordCount: stateData.recordCount || 0,
      updatedAt: new Date().toISOString()
    };

    atomicWriteJson(this.getSyncStateFilePath(safeClientId), state);
    return state;
  }

  getWindowDays(windowCode) {
    const code = String(windowCode || '30d').toLowerCase().trim();
    if (code.includes('7')) return 7;
    if (code.includes('30')) return 30;
    if (code.includes('90')) return 90;
    if (code.includes('180')) return 180;
    if (code.includes('365')) return 365;
    if (code.includes('ytd')) return 365;
    if (code.includes('all')) return 99999;
    return 30;
  }

  /**
   * Evaluates whether an incremental delta sync is safe for the requested client, report, and window.
   */
  isIncrementalSafe(clientId, reportType, requestedWindow = '30d') {
    const config = this.getReportConfig(reportType);
    const state = this.getSyncState(clientId);
    const repState = state.reports?.[config.id];

    if (!repState || !repState.lastSuccessfulSync) {
      return {
        safe: false,
        reason: 'Initial sync (no previous successful sync recorded)',
        lastSuccessfulSync: null,
        updatedSince: null
      };
    }

    const prevDays = this.getWindowDays(repState.reportWindow);
    const reqDays = this.getWindowDays(requestedWindow);

    if (reqDays > prevDays) {
      return {
        safe: false,
        reason: `Report window expanded from ${repState.reportWindow} to ${requestedWindow} (full historical fetch required)`,
        lastSuccessfulSync: repState.lastSuccessfulSync,
        updatedSince: null
      };
    }

    // 15-minute safety overlap buffer before last successful completion boundary
    const lastSuccessMs = new Date(repState.lastSuccessfulSync).getTime();
    const overlapMs = 15 * 60 * 1000;
    const updatedSince = new Date(Math.max(0, lastSuccessMs - overlapMs)).toISOString();

    return {
      safe: true,
      reason: `Incremental delta safe since ${repState.lastSuccessfulSync} (with 15m overlap)`,
      lastSuccessfulSync: repState.lastSuccessfulSync,
      updatedSince
    };
  }

  /**
   * Retrieves all rows from the active current report file if present.
   */
  getCurrentReportRows(clientId, reportType) {
    const safeClientId = this.getSafeClientId(clientId);
    clientStorageService.safeMigrateLegacyClientData(safeClientId);

    const config = this.getReportConfig(reportType);
    const currentFilePath = path.join(clientStorageService.getClientCurrentReportsDir(safeClientId), `${config.id}.json`);

    if (fs.existsSync(currentFilePath)) {
      try {
        const payload = JSON.parse(fs.readFileSync(currentFilePath, 'utf8'));
        return {
          headers: payload.headers || [],
          rows: payload.rows || [],
          periodLabel: payload.periodLabel,
          latestSnapshotId: payload.latestSnapshotId
        };
      } catch (e) {}
    }
    return { headers: [], rows: [], periodLabel: null, latestSnapshotId: null };
  }

  getReportConfig(reportType) {
    const key = (reportType || '').toLowerCase().trim();
    if (key.includes('sale')) return REPORT_CONFIG.sales;
    if (key.includes('purch') || key.includes('po')) return REPORT_CONFIG.purchase;
    if (key.includes('inv') || key.includes('avail') || key.includes('stock')) return REPORT_CONFIG.inventory;
    return REPORT_CONFIG.sales;
  }

  calculateTotals(reportType, rows = []) {
    const config = this.getReportConfig(reportType);
    const totals = {};

    config.metrics.forEach(m => {
      const sum = rows.reduce((acc, r) => {
        const val = Number(r[m.index]) || 0;
        return acc + val;
      }, 0);
      totals[m.key] = Number(sum.toFixed(2));
    });

    totals.recordCount = rows.length;
    return totals;
  }

  /**
   * Saves both the current state AND an immutable historical snapshot.
   * Only called on successful data retrieval and validation.
   */
  async saveCurrentAndSnapshot({ clientId, reportType, periodLabel, dataset, syncRunId }) {
    const safeClientId = this.getSafeClientId(clientId);
    const config = this.getReportConfig(reportType);
    const reportKey = config.id;
    const now = new Date();
    const timestampIso = now.toISOString();

    const headers = dataset?.headers || [];
    const rows = dataset?.rows || [];

    // Calculate totals and metrics
    const totals = this.calculateTotals(reportKey, rows);

    const snapshotId = `snap-${reportKey}-${now.getTime()}-${uuidv4().substring(0, 6)}`;
    const clientSnapshotDir = clientStorageService.getClientSnapshotsDir(safeClientId);
    const snapshotFilePath = path.join(clientSnapshotDir, `${snapshotId}.json`);

    const snapshotPayload = {
      id: snapshotId,
      clientId: safeClientId,
      reportType: reportKey,
      reportName: config.name,
      periodLabel: periodLabel || 'Last 30 days',
      recordCount: rows.length,
      headers,
      rows,
      totals,
      syncRunId: syncRunId || null,
      status: 'SUCCESS',
      createdAt: timestampIso
    };

    // 1. Atomic write of immutable historical snapshot file in storage/clients/<clientId>/snapshots/
    atomicWriteJson(snapshotFilePath, snapshotPayload);

    // 2. Atomic write of current active state in storage/clients/<clientId>/current_reports/
    const currentDir = clientStorageService.getClientCurrentReportsDir(safeClientId);
    const currentFilePath = path.join(currentDir, `${reportKey}.json`);
    const currentPayload = {
      ...snapshotPayload,
      latestSnapshotId: snapshotId,
      updatedAt: timestampIso
    };
    atomicWriteJson(currentFilePath, currentPayload);

    // 3. Record snapshot in DB index scoped strictly by client_id
    await db.query(
      `INSERT INTO report_snapshots (id, client_id, report_type, report_name, period_label, record_count, status, sync_run_id, file_path, totals_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'SUCCESS', ?, ?, ?, ?)`,
      [
        snapshotId,
        safeClientId,
        reportKey,
        config.name,
        periodLabel || 'Last 30 days',
        rows.length,
        syncRunId || null,
        snapshotFilePath,
        JSON.stringify(totals),
        timestampIso
      ]
    );

    return {
      snapshotId,
      reportType: reportKey,
      recordCount: rows.length,
      totals,
      createdAt: timestampIso
    };
  }

  /**
   * Returns current active report summary and data for a given client.
   */
  async getCurrentReports(clientId) {
    const safeClientId = this.getSafeClientId(clientId);
    clientStorageService.safeMigrateLegacyClientData(safeClientId);

    const currentDir = clientStorageService.getClientCurrentReportsDir(safeClientId);
    const reports = {};

    for (const reportKey of ['sales', 'purchase', 'inventory']) {
      const currentFilePath = path.join(currentDir, `${reportKey}.json`);
      if (fs.existsSync(currentFilePath)) {
        try {
          const raw = fs.readFileSync(currentFilePath, 'utf8');
          reports[reportKey] = JSON.parse(raw);
        } catch (e) {
          reports[reportKey] = null;
        }
      } else {
        reports[reportKey] = null;
      }
    }

    return reports;
  }

  /**
   * Returns current active report data for a specific type with pagination and search.
   */
  async getCurrentReportData(clientId, reportType, { page = 1, pageSize = 25, search = '' } = {}) {
    const safeClientId = this.getSafeClientId(clientId);
    clientStorageService.safeMigrateLegacyClientData(safeClientId);

    const config = this.getReportConfig(reportType);
    const currentFilePath = path.join(clientStorageService.getClientCurrentReportsDir(safeClientId), `${config.id}.json`);

    if (!fs.existsSync(currentFilePath)) {
      return {
        success: false,
        message: `No current ${config.name} report has been synchronized yet.`,
        reportType: config.id,
        reportName: config.name,
        headers: config.headers || [],
        rows: [],
        totalRecords: 0,
        page: 1,
        pageSize,
        totalPages: 1
      };
    }

    const payload = JSON.parse(fs.readFileSync(currentFilePath, 'utf8'));
    let filteredRows = payload.rows || [];

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      filteredRows = filteredRows.filter(r => r.some(cell => String(cell || '').toLowerCase().includes(q)));
    }

    const totalRecords = filteredRows.length;
    const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
    const start = (page - 1) * pageSize;
    const paginatedRows = filteredRows.slice(start, start + pageSize);

    return {
      success: true,
      reportType: config.id,
      reportName: config.name,
      latestSnapshotId: payload.latestSnapshotId,
      periodLabel: payload.periodLabel,
      updatedAt: payload.updatedAt || payload.createdAt,
      totals: payload.totals || {},
      headers: payload.headers || [],
      displayCols: config.displayCols,
      rows: paginatedRows,
      totalRecords,
      page,
      pageSize,
      totalPages
    };
  }

  /**
   * Returns previous reports list (all snapshots EXCEPT the active current state), strictly scoped by client_id.
   */
  async listPreviousSnapshots(clientId, { reportType = 'all', dateFilter = 'all', status = 'all', search = '', sortBy = 'date_desc' } = {}) {
    const safeClientId = this.getSafeClientId(clientId);
    clientStorageService.safeMigrateLegacyClientData(safeClientId);

    // Get current snapshots IDs so we exclude active ones from "Previous Reports"
    const currentReports = await this.getCurrentReports(safeClientId);
    const activeSnapshotIds = new Set(
      Object.values(currentReports)
        .filter(Boolean)
        .map(r => r.latestSnapshotId || r.id)
    );

    const dbRes = await db.query(
      `SELECT * FROM report_snapshots WHERE client_id = ? ORDER BY created_at DESC`,
      [safeClientId]
    );

    let items = (dbRes.rows || []).map(r => {
      let totals = {};
      try {
        totals = typeof r.totals_json === 'string' ? JSON.parse(r.totals_json) : (r.totals_json || {});
      } catch (e) {}

      return {
        id: r.id,
        snapshotId: r.id,
        reportType: r.report_type,
        reportName: r.report_name || this.getReportConfig(r.report_type).name,
        periodLabel: r.period_label || 'Last 30 days',
        recordCount: r.record_count || 0,
        status: r.status || 'SUCCESS',
        syncRunId: r.sync_run_id,
        createdAt: r.created_at,
        totals,
        isCurrent: activeSnapshotIds.has(r.id)
      };
    });

    // RULE 5: Previous Reports contains all successful snapshots EXCEPT the active/current state
    items = items.filter(item => !item.isCurrent);

    // Filter by report type
    if (reportType && reportType !== 'all') {
      items = items.filter(i => (i.reportType || '').toLowerCase() === reportType.toLowerCase());
    }

    // Filter by status
    if (status && status !== 'all') {
      items = items.filter(i => (i.status || '').toUpperCase() === status.toUpperCase());
    }

    // Filter by date
    if (dateFilter && dateFilter !== 'all') {
      const now = new Date();
      items = items.filter(i => {
        const itemDate = new Date(i.createdAt);
        if (dateFilter === 'today') {
          return itemDate.toDateString() === now.toDateString();
        }
        if (dateFilter === '7d') {
          return (now - itemDate) <= 7 * 24 * 60 * 60 * 1000;
        }
        if (dateFilter === '30d') {
          return (now - itemDate) <= 30 * 24 * 60 * 60 * 1000;
        }
        return true;
      });
    }

    // Filter by search
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      items = items.filter(i =>
        i.reportName.toLowerCase().includes(q) ||
        i.periodLabel.toLowerCase().includes(q) ||
        i.reportType.toLowerCase().includes(q) ||
        new Date(i.createdAt).toLocaleString().toLowerCase().includes(q)
      );
    }

    // Sorting
    if (sortBy === 'date_asc') {
      items.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    } else if (sortBy === 'records_desc') {
      items.sort((a, b) => b.recordCount - a.recordCount);
    } else if (sortBy === 'records_asc') {
      items.sort((a, b) => a.recordCount - b.recordCount);
    } else if (sortBy === 'report_type') {
      items.sort((a, b) => a.reportName.localeCompare(b.reportName));
    } else {
      // Default: date_desc
      items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    return items;
  }

  /**
   * Retrieves full immutable snapshot dataset for the read-only viewer.
   * Strictly enforces tenant isolation: ensures file belongs to the requested client.
   */
  async getSnapshotData(clientId, snapshotId, { page = 1, pageSize = 25, search = '' } = {}) {
    const safeClientId = this.getSafeClientId(clientId);
    clientStorageService.safeMigrateLegacyClientData(safeClientId);

    const safeSnapshotId = path.basename(snapshotId);
    const snapshotPath = path.join(clientStorageService.getClientSnapshotsDir(safeClientId), `${safeSnapshotId}.json`);

    if (!fs.existsSync(snapshotPath)) {
      throw new Error(`Snapshot ${snapshotId} was not found on server.`);
    }

    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    if (snapshot.clientId && snapshot.clientId !== safeClientId) {
      throw new Error(`Unauthorized snapshot access.`);
    }

    const config = this.getReportConfig(snapshot.reportType);

    let rows = snapshot.rows || [];

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(r => r.some(cell => String(cell || '').toLowerCase().includes(q)));
    }

    const totalRecords = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
    const start = (page - 1) * pageSize;
    const paginatedRows = rows.slice(start, start + pageSize);

    return {
      id: snapshot.id,
      reportType: snapshot.reportType,
      reportName: snapshot.reportName || config.name,
      periodLabel: snapshot.periodLabel,
      createdAt: snapshot.createdAt,
      syncRunId: snapshot.syncRunId,
      totals: snapshot.totals || this.calculateTotals(snapshot.reportType, snapshot.rows),
      headers: snapshot.headers || [],
      displayCols: config.displayCols,
      rows: paginatedRows,
      totalRecords,
      page,
      pageSize,
      totalPages
    };
  }

  /**
   * Compares Snapshot A (Previous) vs Snapshot B (Current or Later)
   * Strictly verifies that BOTH snapshots belong to the authenticated client.
   */
  async reconcileSnapshots(clientId, snapshotIdA, snapshotIdB) {
    const safeClientId = this.getSafeClientId(clientId);
    clientStorageService.safeMigrateLegacyClientData(safeClientId);

    const snapDir = clientStorageService.getClientSnapshotsDir(safeClientId);
    const pathA = path.join(snapDir, `${path.basename(snapshotIdA)}.json`);
    const pathB = path.join(snapDir, `${path.basename(snapshotIdB)}.json`);

    if (!fs.existsSync(pathA)) throw new Error(`Snapshot A (${snapshotIdA}) not found.`);
    if (!fs.existsSync(pathB)) throw new Error(`Snapshot B (${snapshotIdB}) not found.`);

    const snapA = JSON.parse(fs.readFileSync(pathA, 'utf8'));
    const snapB = JSON.parse(fs.readFileSync(pathB, 'utf8'));

    if (snapA.clientId !== safeClientId || snapB.clientId !== safeClientId) {
      throw new Error(`Unauthorized reconciliation request across tenant boundaries.`);
    }

    if (snapA.reportType !== snapB.reportType) {
      throw new Error(`Cannot reconcile different report types (${snapA.reportType} vs ${snapB.reportType}).`);
    }

    const config = this.getReportConfig(snapA.reportType);

    // Build Maps of records by unique key
    const mapA = new Map();
    (snapA.rows || []).forEach((row, idx) => {
      const key = config.getKey(row, idx);
      mapA.set(key, { row, key, idx });
    });

    const mapB = new Map();
    (snapB.rows || []).forEach((row, idx) => {
      const key = config.getKey(row, idx);
      mapB.set(key, { row, key, idx });
    });

    const getItemInfo = (reportType, row, fallbackKey) => {
      let title = fallbackKey;
      let subtitle = '';
      if (!row || !Array.isArray(row)) return { title, subtitle };

      if (reportType === 'sales') {
        title = String(row[2] || row[4] || fallbackKey).trim();
        const sku = String(row[5] || '').trim();
        const prod = String(row[6] || '').trim();
        const cust = String(row[11] || '').trim();
        subtitle = [sku || prod, cust].filter(Boolean).join(' · ');
      } else if (reportType === 'purchase') {
        title = String(row[4] || fallbackKey).trim();
        const supp = String(row[2] || '').trim();
        const loc = String(row[12] || '').trim();
        const status = String(row[14] || '').trim();
        subtitle = [supp, loc, status].filter(Boolean).join(' · ');
      } else if (reportType === 'inventory') {
        title = String(row[1] || fallbackKey).trim();
        const prod = String(row[2] || '').trim();
        const loc = String(row[0] || '').trim();
        subtitle = [prod, loc].filter(Boolean).join(' · ');
      }
      return { title: title || fallbackKey, subtitle };
    };

    const newRecords = [];
    const removedRecords = [];
    const updatedRecords = [];
    const unchangedRecords = [];

    // 1. Check all records in Snapshot B
    for (const [key, itemB] of mapB.entries()) {
      if (!mapA.has(key)) {
        const info = getItemInfo(snapA.reportType, itemB.row, key);
        const deltas = [];

        config.metrics.forEach(m => {
          const valB = Number(itemB.row[m.index]) || 0;
          if (Math.abs(valB) > 0.0001) {
            deltas.push({
              metric: m.label,
              type: m.type,
              previousValue: 0,
              currentValue: valB,
              delta: valB,
              percentChange: 100
            });
          }
        });

        if (deltas.length === 0) {
          deltas.push({
            metric: 'Record Status',
            type: 'text',
            previousValue: 'Not in Baseline',
            currentValue: 'Present in Comparison',
            delta: '+1',
            percentChange: 100
          });
        }

        newRecords.push({
          key,
          displayTitle: info.title,
          subtitle: info.subtitle,
          row: itemB.row,
          deltas,
          type: 'NEW'
        });
      } else {
        const itemA = mapA.get(key);
        const info = getItemInfo(snapA.reportType, itemB.row, key);
        const deltas = [];
        let hasChanges = false;

        // Check each metric field defined for this report type
        config.metrics.forEach(m => {
          const valA = Number(itemA.row[m.index]) || 0;
          const valB = Number(itemB.row[m.index]) || 0;
          const diff = Number((valB - valA).toFixed(2));

          if (Math.abs(diff) > 0.0001) {
            hasChanges = true;
            deltas.push({
              metric: m.label,
              type: m.type,
              previousValue: valA,
              currentValue: valB,
              delta: diff,
              percentChange: valA !== 0 ? Number(((diff / valA) * 100).toFixed(1)) : (diff > 0 ? 100 : 0)
            });
          }
        });

        if (hasChanges) {
          updatedRecords.push({
            key,
            displayTitle: info.title,
            subtitle: info.subtitle,
            rowA: itemA.row,
            rowB: itemB.row,
            deltas,
            type: 'UPDATED'
          });
        } else {
          unchangedRecords.push({
            key,
            displayTitle: info.title,
            subtitle: info.subtitle,
            row: itemB.row,
            type: 'UNCHANGED'
          });
        }
      }
    }

    // 2. Check for removed records (present in A, absent in B)
    for (const [key, itemA] of mapA.entries()) {
      if (!mapB.has(key)) {
        const info = getItemInfo(snapA.reportType, itemA.row, key);
        const deltas = [];

        config.metrics.forEach(m => {
          const valA = Number(itemA.row[m.index]) || 0;
          if (Math.abs(valA) > 0.0001) {
            deltas.push({
              metric: m.label,
              type: m.type,
              previousValue: valA,
              currentValue: 0,
              delta: -valA,
              percentChange: -100
            });
          }
        });

        if (deltas.length === 0) {
          deltas.push({
            metric: 'Record Status',
            type: 'text',
            previousValue: 'Present in Baseline',
            currentValue: 'Not in Comparison',
            delta: '-1',
            percentChange: -100
          });
        }

        removedRecords.push({
          key,
          displayTitle: info.title,
          subtitle: info.subtitle,
          row: itemA.row,
          deltas,
          type: 'REMOVED'
        });
      }
    }

    // Aggregate Metric Totals Comparison
    const totalsA = snapA.totals || this.calculateTotals(snapA.reportType, snapA.rows);
    const totalsB = snapB.totals || this.calculateTotals(snapB.reportType, snapB.rows);

    const summaryDeltas = config.metrics.map(m => {
      const a = totalsA[m.key] || 0;
      const b = totalsB[m.key] || 0;
      const diff = Number((b - a).toFixed(2));
      return {
        metric: m.label,
        key: m.key,
        type: m.type,
        previousTotal: a,
        currentTotal: b,
        delta: diff,
        percentChange: a !== 0 ? Number(((diff / a) * 100).toFixed(1)) : 0
      };
    });

    return {
      reportType: snapA.reportType,
      reportName: config.name,
      snapshotA: {
        id: snapA.id,
        createdAt: snapA.createdAt,
        periodLabel: snapA.periodLabel,
        recordCount: snapA.rows?.length || 0,
        totals: totalsA
      },
      snapshotB: {
        id: snapB.id,
        createdAt: snapB.createdAt,
        periodLabel: snapB.periodLabel,
        recordCount: snapB.rows?.length || 0,
        totals: totalsB
      },
      counts: {
        newCount: newRecords.length,
        updatedCount: updatedRecords.length,
        removedCount: removedRecords.length,
        unchangedCount: unchangedRecords.length,
        totalA: (snapA.rows || []).length,
        totalB: (snapB.rows || []).length
      },
      summaryDeltas,
      displayCols: config.displayCols,
      newRecords,
      updatedRecords,
      removedRecords
    };
  }

  /**
   * Neutralizes spreadsheet formula execution prefixes for untrusted string cells (SEC-10)
   * Prevents CSV / Spreadsheet formula injection while preserving valid negative numbers.
   */
  sanitizeCsvCell(val) {
    if (val === null || val === undefined) return '';

    // Preserve native numeric types without formula escaping
    if (typeof val === 'number' && !isNaN(val)) {
      return val;
    }

    let str = String(val);

    // Preserve strings that represent pure numbers (including negative numbers like -150.50)
    if (/^-?\d+(\.\d+)?$/.test(str.trim())) {
      return str.trim();
    }

    // Neutralize dangerous spreadsheet formula execution prefixes for string cells
    if (/^[=+\-@\t\r]/.test(str)) {
      str = "'" + str;
    }

    return str;
  }

  /**
   * Generates CSV string from an immutable snapshot, strictly within tenant isolation.
   */
  async exportSnapshotCsv(clientId, snapshotId) {
    const safeClientId = this.getSafeClientId(clientId);
    clientStorageService.safeMigrateLegacyClientData(safeClientId);

    const snapshotPath = path.join(clientStorageService.getClientSnapshotsDir(safeClientId), `${path.basename(snapshotId)}.json`);

    if (!fs.existsSync(snapshotPath)) throw new Error('Snapshot file not found.');

    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    if (snapshot.clientId && snapshot.clientId !== safeClientId) {
      throw new Error('Unauthorized export request.');
    }

    const headers = snapshot.headers || [];
    const rows = snapshot.rows || [];

    const formatCsvCell = (val) => {
      const sanitized = this.sanitizeCsvCell(val);
      const str = String(sanitized);
      // RFC4180 CSV escaping for quotes, commas, and newlines
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const lines = [
      headers.map(formatCsvCell).join(','),
      ...rows.map(r => r.map(formatCsvCell).join(','))
    ];

    return {
      csvContent: lines.join('\r\n'),
      fileName: `${snapshot.reportType}_snapshot_${snapshotId}.csv`
    };
  }
}

module.exports = new SnapshotService();
