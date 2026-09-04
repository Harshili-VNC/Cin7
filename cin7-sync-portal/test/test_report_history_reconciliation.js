const http = require('http');
const app = require('../src/server');
const snapshotService = require('../src/services/snapshotService');
const clientStorageService = require('../src/services/clientStorageService');
const db = require('../src/db');
const { v4: uuidv4 } = require('uuid');

async function runReportHistoryTests() {
  console.log('=====================================================================');
  console.log('🧪 TESTING CIN7 REPORT HISTORY, SNAPSHOTS & RECONCILIATION SUITE');
  console.log('=====================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, msg) {
    if (condition) {
      console.log(`✅ [PASS] ${msg}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${msg}`);
      failed++;
    }
  }

  // Start test server on dynamic port
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const testTenant = `client-test-${uuidv4().substring(0, 8)}`;
  const otherTenant = `client-other-${uuidv4().substring(0, 8)}`;

  const testHeaders = { 'x-client-id': testTenant };
  const otherHeaders = { 'x-client-id': otherTenant };

  try {
    // -----------------------------------------------------------------------
    // TEST 1: Initial Empty State
    // -----------------------------------------------------------------------
    console.log('--- TEST 1: Initial Empty State ---');
    const emptyCurrentRes = await fetch(`${baseUrl}/api/reports/current`, { headers: testHeaders });
    const emptyCurrentData = await emptyCurrentRes.json();
    assert(emptyCurrentData.success === true, 'GET /api/reports/current returns success');
    assert(emptyCurrentData.reports.sales === null, 'Sales report is initially null before any sync');

    const emptyPrevRes = await fetch(`${baseUrl}/api/reports/previous`, { headers: testHeaders });
    const emptyPrevData = await emptyPrevRes.json();
    assert(emptyPrevData.success === true && emptyPrevData.snapshots.length === 0, 'GET /api/reports/previous returns empty list (0 snapshots)');

    // -----------------------------------------------------------------------
    // TEST 2: First Sync Execution & Snapshot Creation
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 2: First Sync Execution ---');
    // Sample Sales Dataset 1
    const salesDataset1 = {
      headers: ['Index', 'Source', 'Order #', 'Order Date', 'Invoice #', 'SKU', 'Product Name', 'Option 1', 'Option 2', 'Category', 'Customer Code', 'Customer Name', 'Billing Contact', 'Billing Addr', 'Shipping Addr', 'City', 'Country', 'Sales Channel', 'Sales Rep', 'Qty Sold', 'Revenue', 'Tax', 'COGS', 'Discount', 'Gross Profit'],
      rows: [
        [1, 'Cin7', 'SO-1001', '2026-08-01', 'INV-1001', 'SKU-A', 'Product Alpha', 'Black', 'Large', 'Apparel', 'CUST-1', 'Acme Corp', 'John Doe', '123 Main', '123 Main', 'New York', 'USA', 'B2B Wholesale', 'Rep A', 10, 1000.00, 80.00, 400.00, 0, 600.00],
        [2, 'Cin7', 'SO-1002', '2026-08-02', 'INV-1002', 'SKU-B', 'Product Beta', 'White', 'Medium', 'Apparel', 'CUST-2', 'Beta LLC', 'Jane Smith', '456 Elm', '456 Elm', 'Chicago', 'USA', 'E-commerce', 'Rep B', 5, 250.00, 20.00, 100.00, 0, 150.00],
        [3, 'Cin7', 'SO-1003', '2026-08-03', 'INV-1003', 'SKU-C', 'Product Gamma', 'Blue', 'Small', 'Apparel', 'CUST-3', 'Gamma Inc', 'Bob Brown', '789 Oak', '789 Oak', 'Dallas', 'USA', 'Shopify', 'Rep C', 2, 100.00, 8.00, 40.00, 0, 60.00]
      ]
    };

    const sync1 = await snapshotService.saveCurrentAndSnapshot({
      clientId: testTenant,
      reportType: 'sales',
      periodLabel: 'Last 365 Days',
      dataset: salesDataset1,
      syncRunId: 'sync-run-001'
    });

    assert(sync1.snapshotId && sync1.snapshotId.startsWith('snap-sales-'), `Created Snapshot 1 (${sync1.snapshotId})`);
    assert(sync1.recordCount === 3, 'Snapshot 1 processed 3 records');
    assert(sync1.totals.revenue === 1350.00, `Snapshot 1 Revenue Total = $${sync1.totals.revenue} (Expected 1350.00)`);
    assert(sync1.totals.profit === 810.00, `Snapshot 1 Profit Total = $${sync1.totals.profit} (Expected 810.00)`);

    // -----------------------------------------------------------------------
    // TEST 3: RULE 5 Check (Only 1 Sync Exists -> Previous Reports is Empty)
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 3: Rule 5 Validation (Current State vs Previous Reports) ---');
    const currentAfterSync1 = await (await fetch(`${baseUrl}/api/reports/current`, { headers: testHeaders })).json();
    assert(currentAfterSync1.reports.sales !== null, 'Current Sales report is now populated');
    assert(currentAfterSync1.reports.sales.latestSnapshotId === sync1.snapshotId, 'Current Sales report points to Snapshot 1');

    const prevAfterSync1 = await (await fetch(`${baseUrl}/api/reports/previous`, { headers: testHeaders })).json();
    assert(prevAfterSync1.snapshots.length === 0, 'RULE 5 SATISFIED: Previous Reports is still empty because Snapshot 1 is the ACTIVE current report');

    // -----------------------------------------------------------------------
    // TEST 4: Second Sync with Changes (Updates, New Item, Removed Item)
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 4: Second Sync with Field Deltas & Key Changes ---');
    const salesDataset2 = {
      headers: salesDataset1.headers,
      rows: [
        [1, 'Cin7', 'SO-1001', '2026-08-01', 'INV-1001', 'SKU-A', 'Product Alpha', 'Black', 'Large', 'Apparel', 'CUST-1', 'Acme Corp', 'John Doe', '123 Main', '123 Main', 'New York', 'USA', 'B2B Wholesale', 'Rep A', 15, 1500.00, 120.00, 600.00, 0, 900.00],
        [2, 'Cin7', 'SO-1002', '2026-08-02', 'INV-1002', 'SKU-B', 'Product Beta', 'White', 'Medium', 'Apparel', 'CUST-2', 'Beta LLC', 'Jane Smith', '456 Elm', '456 Elm', 'Chicago', 'USA', 'E-commerce', 'Rep B', 5, 250.00, 20.00, 100.00, 0, 150.00],
        [4, 'Cin7', 'SO-1004', '2026-08-04', 'INV-1004', 'SKU-D', 'Product Delta', 'Red', 'Large', 'Apparel', 'CUST-4', 'Delta Corp', 'Sam Lee', '101 Pine', '101 Pine', 'Miami', 'USA', 'Retail', 'Rep D', 4, 400.00, 32.00, 160.00, 0, 240.00]
      ]
    };

    const sync2 = await snapshotService.saveCurrentAndSnapshot({
      clientId: testTenant,
      reportType: 'sales',
      periodLabel: 'Last 365 Days',
      dataset: salesDataset2,
      syncRunId: 'sync-run-002'
    });

    assert(sync2.snapshotId && sync2.snapshotId !== sync1.snapshotId, `Created Snapshot 2 (${sync2.snapshotId})`);
    assert(sync2.totals.revenue === 2150.00, `Snapshot 2 Revenue Total = $${sync2.totals.revenue} (Expected 2150.00)`);

    // -----------------------------------------------------------------------
    // TEST 5: Previous Reports Now Lists Snapshot 1
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 5: Previous Reports Listing & Pagination ---');
    const prevAfterSync2 = await (await fetch(`${baseUrl}/api/reports/previous`, { headers: testHeaders })).json();
    assert(prevAfterSync2.snapshots.length === 1, 'Previous reports now contains exactly 1 snapshot');
    assert(prevAfterSync2.snapshots[0].id === sync1.snapshotId, `Previous reports contains Snapshot 1 (${sync1.snapshotId})`);

    // Current State points to Snapshot 2
    const currentAfterSync2 = await (await fetch(`${baseUrl}/api/reports/current`, { headers: testHeaders })).json();
    assert(currentAfterSync2.reports.sales.latestSnapshotId === sync2.snapshotId, `Current active state updated to Snapshot 2 (${sync2.snapshotId})`);

    // -----------------------------------------------------------------------
    // TEST 6: Read-Only Snapshot Viewer & Search Filter
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 6: Read-Only Snapshot Viewer API ---');
    const snapViewerRes = await (await fetch(`${baseUrl}/api/reports/snapshots/${sync1.snapshotId}?page=1&pageSize=2`, { headers: testHeaders })).json();
    assert(snapViewerRes.success === true, 'Snapshot viewer endpoint returned HTTP 200');
    assert(snapViewerRes.totalRecords === 3, 'Total records in snapshot 1 is 3');
    assert(snapViewerRes.rows.length === 2, 'Page size limit of 2 respected for pagination');
    assert(snapViewerRes.totalPages === 2, 'Total pages calculated correctly (2 pages)');

    // Search query test
    const snapSearchRes = await (await fetch(`${baseUrl}/api/reports/snapshots/${sync1.snapshotId}?search=Beta`, { headers: testHeaders })).json();
    assert(snapSearchRes.rows.length === 1, 'Search for "Beta" filtered dataset to 1 matching row');
    assert(snapSearchRes.rows[0][6] === 'Product Beta', 'Search returned correct product name');

    // -----------------------------------------------------------------------
    // TEST 7: Immutability Verification
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 7: Snapshot Immutability Check ---');
    const rawSnap1 = await snapshotService.getSnapshotData(testTenant, sync1.snapshotId);
    assert(rawSnap1.rows.length === 3, 'Snapshot 1 raw rows count remained strictly 3');
    assert(rawSnap1.totals.revenue === 1350.00, 'Snapshot 1 historical totals remained strictly $1,350.00');
    assert(rawSnap1.rows[0][19] === 10, 'Snapshot 1 first row Qty Sold is still 10 (not updated to 15)');

    // -----------------------------------------------------------------------
    // TEST 8: CSV Export API
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 8: CSV Export Endpoint ---');
    const csvRes = await fetch(`${baseUrl}/api/reports/snapshots/${sync1.snapshotId}/export`, { headers: testHeaders });
    assert(csvRes.status === 200, 'Export endpoint returned HTTP 200');
    assert(csvRes.headers.get('content-type') === 'text/csv; charset=utf-8' || csvRes.headers.get('content-type')?.includes('text/csv'), 'Content-Type is text/csv');
    const csvBody = await csvRes.text();
    const csvLines = csvBody.trim().split('\r\n');
    assert(csvLines.length === 4, `CSV has 1 header line + 3 row lines (${csvLines.length} total lines)`);
    assert(csvLines[0].includes('Order #') && csvLines[0].includes('Gross Profit'), 'CSV header contains correct column names');
    assert(csvLines[1].includes('SO-1001') && csvLines[1].includes('SKU-A'), 'CSV data line 1 contains valid quoted data');

    // -----------------------------------------------------------------------
    // TEST 9: Reconciliation Engine (Snapshot 1 vs Snapshot 2)
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 9: Reconciliation Engine & Field-Level Deltas ---');
    const reconcileRes = await (await fetch(`${baseUrl}/api/reports/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...testHeaders },
      body: JSON.stringify({
        snapshotIdA: sync1.snapshotId,
        snapshotIdB: sync2.snapshotId
      })
    })).json();

    assert(reconcileRes.success === true, 'POST /api/reports/reconcile succeeded');
    const rec = reconcileRes.reconciliation;
    assert(rec.counts.newCount === 1, `Reconciliation detected exactly 1 NEW record (SO-1004__SKU-D) - got ${rec.counts.newCount}`);
    assert(rec.counts.updatedCount === 1, `Reconciliation detected exactly 1 UPDATED record (SO-1001__SKU-A) - got ${rec.counts.updatedCount}`);
    assert(rec.counts.removedCount === 1, `Reconciliation detected exactly 1 REMOVED record (SO-1003__SKU-C) - got ${rec.counts.removedCount}`);
    assert(rec.counts.unchangedCount === 1, `Reconciliation detected exactly 1 UNCHANGED record (SO-1002__SKU-B) - got ${rec.counts.unchangedCount}`);

    // Check deltas for updated record
    const updated = rec.updatedRecords[0];
    assert(updated.key === 'SO-1001__SKU-A', 'Updated record key matched SO-1001__SKU-A');
    const qtyDelta = updated.deltas.find(d => d.metric === 'Quantity');
    assert(qtyDelta && qtyDelta.previousValue === 10 && qtyDelta.currentValue === 15 && qtyDelta.delta === 5, 'Quantity delta: 10 -> 15 (+5, +50%)');
    const revDelta = updated.deltas.find(d => d.metric === 'Revenue');
    assert(revDelta && revDelta.previousValue === 1000 && revDelta.currentValue === 1500 && revDelta.delta === 500, 'Revenue delta: $1000 -> $1500 (+$500, +50%)');

    // Check summary aggregate deltas
    const revSummary = rec.summaryDeltas.find(s => s.metric === 'Revenue');
    assert(revSummary && revSummary.previousTotal === 1350 && revSummary.currentTotal === 2150 && revSummary.delta === 800, 'Summary Revenue delta: $1,350 -> $2,150 (+$800)');

    // -----------------------------------------------------------------------
    // TEST 10: Purchase & Inventory Unique Business Keys in Reconciliation
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 10: Purchase & Inventory Business Key Reconciliation ---');
    const poHeaders = ['Year', 'Month', 'Supplier', 'Expiry date', 'PO #', 'Invoice #', 'Brand', 'Category', 'Family', 'SKU', 'Product', 'Unit', 'Location', 'Batch #', 'Status', 'Quantity', 'Main cost', 'Additional cost', 'Journal cost', 'Tax'];
    const poDataset1 = {
      headers: poHeaders,
      rows: [
        [2026, 'August', 'Supplier X', '', 'PO-900', 'INV-900', 'Brand A', 'Cat A', 'Fam A', 'SKU-10', 'Widget', 'Case', 'Main Warehouse', 'B1', 'Received', 100, 500.00, 50.00, 0, 40.00],
        [2026, 'August', 'Supplier Y', '', 'PO-901', 'INV-901', 'Brand B', 'Cat B', 'Fam B', 'SKU-20', 'Gadget', 'Case', 'West Coast DC', 'B2', 'Received', 50, 1000.00, 100.00, 0, 80.00]
      ]
    };
    const poDataset2 = {
      headers: poHeaders,
      rows: [
        [2026, 'August', 'Supplier X', '', 'PO-900', 'INV-900', 'Brand A', 'Cat A', 'Fam A', 'SKU-10', 'Widget', 'Case', 'Main Warehouse', 'B1', 'Received', 120, 600.00, 60.00, 0, 48.00],
        [2026, 'August', 'Supplier Y', '', 'PO-901', 'INV-901', 'Brand B', 'Cat B', 'Fam B', 'SKU-20', 'Gadget', 'Case', 'West Coast DC', 'B2', 'Received', 50, 1000.00, 100.00, 0, 80.00]
      ]
    };

    const poSync1 = await snapshotService.saveCurrentAndSnapshot({ clientId: testTenant, reportType: 'purchase', dataset: poDataset1 });
    const poSync2 = await snapshotService.saveCurrentAndSnapshot({ clientId: testTenant, reportType: 'purchase', dataset: poDataset2 });

    const poRec = await snapshotService.reconcileSnapshots(testTenant, poSync1.snapshotId, poSync2.snapshotId);
    assert(poRec.counts.updatedCount === 1, `Purchase PO reconciliation identified updated record`);
    assert(poRec.counts.unchangedCount === 1, `Purchase PO reconciliation identified unchanged record`);

    // -----------------------------------------------------------------------
    // TEST 11: Tenant Isolation Security Check
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 11: Tenant Isolation Check ---');
    const otherCurrent = await (await fetch(`${baseUrl}/api/reports/current`, { headers: otherHeaders })).json();
    assert(otherCurrent.reports.sales === null, 'Other tenant cannot access test tenant current report data');

    const otherViewerRes = await fetch(`${baseUrl}/api/reports/snapshots/${sync1.snapshotId}`, { headers: otherHeaders });
    assert(otherViewerRes.status === 404, 'Other tenant receives 404 when attempting to access test tenant snapshot');

    // -----------------------------------------------------------------------
    // TEST 12: Failure Isolation Verification
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 12: Failure Isolation Check ---');
    const failReconcile = await (await fetch(`${baseUrl}/api/reports/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...testHeaders },
      body: JSON.stringify({
        snapshotIdA: 'invalid-snap-id',
        snapshotIdB: sync2.snapshotId
      })
    })).json();
    assert(failReconcile.success === false, 'Invalid reconciliation request returns clean error response');

    // Cleanup test tenant files
    try {
      const dirTest = clientStorageService.getClientDir(testTenant);
      const dirOther = clientStorageService.getClientDir(otherTenant);
      if (fs.existsSync(dirTest)) fs.rmSync(dirTest, { recursive: true, force: true });
      if (fs.existsSync(dirOther)) fs.rmSync(dirOther, { recursive: true, force: true });
    } catch (_) {}

  } finally {
    server.close();
  }

  console.log('\n=====================================================================');
  console.log(`📊 TEST SUITE RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('=====================================================================\n');

  if (failed === 0) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runReportHistoryTests().catch(err => {
  console.error('Test suite crash:', err);
  process.exit(1);
});
