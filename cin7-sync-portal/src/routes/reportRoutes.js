const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { enforceTenantIsolation } = require('../middleware/tenantMiddleware');
const snapshotService = require('../services/snapshotService');

// Tenant isolation middleware on all routes
router.use(enforceTenantIsolation);

/**
 * GET /api/reports/current
 * Returns latest active report summaries for Sales, Purchase, and Inventory
 */
router.get('/current', async (req, res) => {
  const clientId = req.tenantId;
  try {
    const currentReports = await snapshotService.getCurrentReports(clientId);
    res.json({
      success: true,
      reports: currentReports
    });
  } catch (err) {
    console.error('Error fetching current reports:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/reports/current/:reportType
 * Returns paginated & searchable rows of the current active report
 */
router.get('/current/:reportType', async (req, res) => {
  const clientId = req.tenantId;
  const reportType = req.params.reportType;
  const page = parseInt(req.query.page || 1, 10);
  const pageSize = parseInt(req.query.pageSize || 25, 10);
  const search = req.query.search || '';

  try {
    const data = await snapshotService.getCurrentReportData(clientId, reportType, { page, pageSize, search });
    res.json(data);
  } catch (err) {
    console.error(`Error fetching current ${reportType} report:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/reports/previous
 * Returns previous snapshots list (all snapshots EXCEPT active current report)
 */
router.get('/previous', async (req, res) => {
  const clientId = req.tenantId;
  const { reportType, dateFilter, status, search, sortBy } = req.query;

  try {
    const snapshots = await snapshotService.listPreviousSnapshots(clientId, {
      reportType,
      dateFilter,
      status,
      search,
      sortBy
    });

    res.json({
      success: true,
      snapshots,
      totalCount: snapshots.length
    });
  } catch (err) {
    console.error('Error listing previous snapshots:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/reports/snapshots-list-for-reconcile
 * Returns all snapshots (both current and previous) grouped for selector in Reconciliation tab
 */
router.get('/snapshots-list-for-reconcile', async (req, res) => {
  const clientId = req.tenantId;
  const reportType = req.query.reportType || 'all';

  try {
    const current = await snapshotService.getCurrentReports(clientId);
    const previous = await snapshotService.listPreviousSnapshots(clientId, { reportType });

    const all = [];
    Object.entries(current).forEach(([k, r]) => {
      if (r && (reportType === 'all' || r.reportType === reportType)) {
        all.push({
          id: r.latestSnapshotId || r.id,
          reportType: r.reportType,
          reportName: r.reportName,
          periodLabel: r.periodLabel,
          createdAt: r.updatedAt || r.createdAt,
          recordCount: r.recordCount,
          isCurrent: true,
          label: `${r.reportName} (Current Active - ${new Date(r.updatedAt || r.createdAt).toLocaleDateString()})`
        });
      }
    });

    previous.forEach(p => {
      all.push({
        id: p.id,
        reportType: p.reportType,
        reportName: p.reportName,
        periodLabel: p.periodLabel,
        createdAt: p.createdAt,
        recordCount: p.recordCount,
        isCurrent: false,
        label: `${p.reportName} (${new Date(p.createdAt).toLocaleDateString()} - ${p.periodLabel})`
      });
    });

    res.json({
      success: true,
      snapshots: all
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/reports/snapshots/:snapshotId
 * Returns full snapshot dataset for read-only viewer with server-side pagination & search
 */
router.get('/snapshots/:snapshotId', async (req, res) => {
  const clientId = req.tenantId;
  const snapshotId = req.params.snapshotId;
  const page = parseInt(req.query.page || 1, 10);
  const pageSize = parseInt(req.query.pageSize || 25, 10);
  const search = req.query.search || '';

  try {
    const data = await snapshotService.getSnapshotData(clientId, snapshotId, { page, pageSize, search });
    res.json({
      success: true,
      ...data
    });
  } catch (err) {
    console.error('Error fetching snapshot data:', err.message);
    res.status(404).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/reports/snapshots/:snapshotId/export
 * Downloads the exact historical snapshot as CSV
 */
router.get('/snapshots/:snapshotId/export', async (req, res) => {
  const clientId = req.tenantId;
  const snapshotId = req.params.snapshotId;

  try {
    const { csvContent, fileName } = await snapshotService.exportSnapshotCsv(clientId, snapshotId);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(csvContent);
  } catch (err) {
    console.error('Error exporting snapshot CSV:', err.message);
    res.status(404).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/reports/reconcile
 * Compares two snapshots and returns reconciliation metrics & field deltas
 */
router.post('/reconcile', async (req, res) => {
  const clientId = req.tenantId;
  const { snapshotIdA, snapshotIdB } = req.body;

  if (!snapshotIdA || !snapshotIdB) {
    return res.status(400).json({
      success: false,
      error: 'Both snapshotIdA (Previous) and snapshotIdB (Current) are required for reconciliation.'
    });
  }

  try {
    const diff = await snapshotService.reconcileSnapshots(clientId, snapshotIdA, snapshotIdB);
    res.json({
      success: true,
      reconciliation: diff
    });
  } catch (err) {
    console.error('Error running reconciliation:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
