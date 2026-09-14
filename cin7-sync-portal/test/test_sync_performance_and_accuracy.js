const fs = require('fs');
const path = require('path');
const assert = require('assert');

const cin7Engine = require('../src/services/cin7Engine');
const snapshotService = require('../src/services/snapshotService');
const db = require('../src/db');

async function runTestSuite() {
  console.log('================================================================');
  console.log('🚀 CIN7 LIVE SYNC PERFORMANCE, ACCURACY & INCREMENTAL ENGINE TEST');
  console.log('================================================================\n');

  const testClientId = `test-client-perf-${Date.now()}`;
  await db.query(
    `INSERT INTO clients (id, company_name, sync_status) VALUES (?, ?, 'READY') ON CONFLICT (id) DO NOTHING`,
    [testClientId, 'Test Perf Client']
  );

  const STORAGE_ROOT = path.join(__dirname, '../storage');
  const SYNC_STATE_FILE = path.join(STORAGE_ROOT, 'sync_state', `${testClientId}.json`);
  const CURRENT_SALES_FILE = path.join(STORAGE_ROOT, 'current_reports', testClientId, 'sales.json');

  let passedTests = 0;
  let totalTests = 0;

  function test(name, fn) {
    totalTests++;
    try {
      fn();
      console.log(`  ✅ PASS: ${name}`);
      passedTests++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Error: ${err.message}\n`, err.stack);
    }
  }

  async function testAsync(name, fn) {
    totalTests++;
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passedTests++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Error: ${err.message}\n`, err.stack);
    }
  }

  // --------------------------------------------------------------------------
  console.log('--- 1. Sync State Configuration & Safety Evaluation ---');
  // --------------------------------------------------------------------------

  test('Initial state: isIncrementalSafe returns false when no prior sync exists', () => {
    const safety = snapshotService.isIncrementalSafe(testClientId, 'sales', '30d');
    assert.strictEqual(safety.safe, false, 'Expected safe to be false on initial run');
    assert.strictEqual(safety.lastSuccessfulSync, null);
    assert.strictEqual(safety.updatedSince, null);
  });

  test('Save first sync state with completion boundary timestamp', () => {
    const syncStart = new Date(Date.now() - 60000).toISOString(); // 1 min ago
    const completionBoundary = new Date().toISOString(); // Now

    snapshotService.updateSyncState(testClientId, 'sales', {
      reportWindow: '30d',
      lastSuccessfulSync: completionBoundary,
      lastSyncRunId: 'run-test-001',
      recordCount: 269
    });

    const state = snapshotService.getSyncState(testClientId);
    assert.strictEqual(state.reports.sales.reportWindow, '30d');
    assert.strictEqual(state.reports.sales.lastSuccessfulSync, completionBoundary);
    assert.strictEqual(state.reports.sales.recordCount, 269);
  });

  test('Incremental Safety: returns true for identical or smaller window (30d -> 30d, 30d -> 7d)', () => {
    const safety30 = snapshotService.isIncrementalSafe(testClientId, 'sales', '30d');
    assert.strictEqual(safety30.safe, true, 'Should be safe for 30d');
    assert.ok(safety30.updatedSince, 'Should provide updatedSince timestamp');

    // Verify 15-minute overlap buffer
    const lastSyncMs = new Date(safety30.lastSuccessfulSync).getTime();
    const updatedSinceMs = new Date(safety30.updatedSince).getTime();
    const diffMin = Math.round((lastSyncMs - updatedSinceMs) / (60 * 1000));
    assert.strictEqual(diffMin, 15, 'UpdatedSince must be exactly 15 minutes before lastSuccessfulSync');

    const safety7 = snapshotService.isIncrementalSafe(testClientId, 'sales', '7d');
    assert.strictEqual(safety7.safe, true, 'Should be safe for smaller 7d window');
  });

  test('Report Window Expansion (30d -> 365d): Automatically triggers full sync', () => {
    const safety365 = snapshotService.isIncrementalSafe(testClientId, 'sales', '365d');
    assert.strictEqual(safety365.safe, false, 'Should NOT be safe when expanding from 30d to 365d');
    assert.ok(safety365.reason.includes('expanded'), 'Reason should mention window expansion');
    assert.strictEqual(safety365.updatedSince, null, 'UpdatedSince should be null to force full fetch');
  });

  test('After 365d sync completes: Future 365d syncs use incremental UpdatedSince', () => {
    const newCompletionBoundary = new Date().toISOString();
    snapshotService.updateSyncState(testClientId, 'sales', {
      reportWindow: '365d',
      lastSuccessfulSync: newCompletionBoundary,
      lastSyncRunId: 'run-test-365',
      recordCount: 1500
    });

    const safetyAfter = snapshotService.isIncrementalSafe(testClientId, 'sales', '365d');
    assert.strictEqual(safetyAfter.safe, true, 'Subsequent 365d sync should now be safe for incremental delta');
    assert.ok(safetyAfter.updatedSince, 'Should have updatedSince for 365d');
  });

  // --------------------------------------------------------------------------
  console.log('\n--- 2. Business Key Upserting, Deduplication & Deletion Handling (Section 2A) ---');
  // --------------------------------------------------------------------------

  test('mergeSalesData: Deduplicates and updates records by Order # + SKU', () => {
    const existingRows = [
      [2026, 'January', 'SO-101', '2026-01-10', 'INV-101', 'SKU-A', 'Product A', 'Cin7', 'FG', 'FG', 'Std', 'Cust 1', 'Invoiced', 'ea', 'Shipped', '', '', 'Shopify', 'Shopify web', 2, 100, 100, 50, 0, 50, 0.5],
      [2026, 'January', 'SO-102', '2026-01-11', 'INV-102', 'SKU-B', 'Product B', 'Cin7', 'FG', 'FG', 'Std', 'Cust 2', 'Invoiced', 'ea', 'Shipped', '', '', 'Amazon', 'Amazon web', 1, 60, 60, 30, 0, 30, 0.5]
    ];

    const deltaRows = [
      // Modified SO-101 (Quantity updated to 5, revenue 250)
      [2026, 'January', 'SO-101', '2026-01-10', 'INV-101', 'SKU-A', 'Product A', 'Cin7', 'FG', 'FG', 'Std', 'Cust 1', 'Invoiced', 'ea', 'Shipped', '', '', 'Shopify', 'Shopify web', 5, 250, 250, 125, 0, 125, 0.5],
      // Brand new SO-103
      [2026, 'January', 'SO-103', '2026-01-12', 'INV-103', 'SKU-C', 'Product C', 'Cin7', 'FG', 'FG', 'Std', 'Cust 3', 'Invoiced', 'ea', 'Shipped', '', '', 'Wholesale', 'Wholesale B2B', 10, 800, 800, 400, 0, 400, 0.5]
    ];

    const merged = cin7Engine.mergeSalesData(existingRows, deltaRows);

    assert.strictEqual(merged.length, 3, 'Merged total should be 3 (2 existing + 1 new, with 1 updated)');
    
    // Find updated SO-101
    const updatedRow = merged.find(r => r[2] === 'SO-101' && r[5] === 'SKU-A');
    assert.ok(updatedRow, 'Updated SO-101 should exist');
    assert.strictEqual(updatedRow[19], 5, 'Quantity should be updated to 5');
    assert.strictEqual(updatedRow[20], 250, 'Revenue should be updated to 250');

    // Find new SO-103
    const newRow = merged.find(r => r[2] === 'SO-103' && r[5] === 'SKU-C');
    assert.ok(newRow, 'New SO-103 should exist');
    assert.strictEqual(newRow[19], 10, 'New SO-103 quantity should be 10');
  });

  test('Section 2A Deletion Handling: Unmentioned records in delta are NOT deleted', () => {
    const existingRows = [
      [2026, 'January', 'SO-201', '2026-01-10', 'INV-201', 'SKU-X', 'Product X', 'Cin7', 'FG', 'FG', 'Std', 'Cust 1', 'Invoiced', 'ea', 'Shipped', '', '', 'Shopify', 1, 100, 100, 50, 0, 50, 0.5],
      [2026, 'January', 'SO-202', '2026-01-11', 'INV-202', 'SKU-Y', 'Product Y', 'Cin7', 'FG', 'FG', 'Std', 'Cust 2', 'Invoiced', 'ea', 'Shipped', '', '', 'Amazon', 1, 100, 100, 50, 0, 50, 0.5]
    ];

    // Delta only mentions SO-203
    const deltaRows = [
      [2026, 'January', 'SO-203', '2026-01-12', 'INV-203', 'SKU-Z', 'Product Z', 'Cin7', 'FG', 'FG', 'Std', 'Cust 3', 'Invoiced', 'ea', 'Shipped', '', '', 'Wholesale', 1, 100, 100, 50, 0, 50, 0.5]
    ];

    const merged = cin7Engine.mergeSalesData(existingRows, deltaRows);

    assert.strictEqual(merged.length, 3, 'Must retain SO-201 and SO-202 even though they were absent from delta');
    assert.ok(merged.some(r => r[2] === 'SO-201'), 'SO-201 must be preserved');
    assert.ok(merged.some(r => r[2] === 'SO-202'), 'SO-202 must be preserved');
    assert.ok(merged.some(r => r[2] === 'SO-203'), 'SO-203 must be added');
  });

  test('mergePurchaseData: Deduplicates by PO # + SKU + Location', () => {
    const existingPOs = [
      [2026, 'January', 'Supplier A', '2026-02-01', 'PO-101', 'INV-101', 'Cin7', 'FG', 'FG', 'SKU-P1', 'Product P1', 'Case', 'Main', 'B-1', 'Received', 100, 500, 0, 0, 50]
    ];
    const deltaPOs = [
      // Updated cost for same PO + SKU + Location
      [2026, 'January', 'Supplier A', '2026-02-01', 'PO-101', 'INV-101', 'Cin7', 'FG', 'FG', 'SKU-P1', 'Product P1', 'Case', 'Main', 'B-1', 'Received', 100, 650, 0, 0, 65],
      // Same PO # but different SKU
      [2026, 'January', 'Supplier A', '2026-02-01', 'PO-101', 'INV-101', 'Cin7', 'FG', 'FG', 'SKU-P2', 'Product P2', 'Case', 'Main', 'B-1', 'Received', 50, 250, 0, 0, 25]
    ];

    const merged = cin7Engine.mergePurchaseData(existingPOs, deltaPOs);
    assert.strictEqual(merged.length, 2, 'Should have 2 distinct line items for PO-101');
    const p1 = merged.find(r => r[4] === 'PO-101' && r[9] === 'SKU-P1');
    assert.strictEqual(p1[16], 650, 'Main cost should be updated to 650');
  });

  test('mergeInventoryData: Deduplicates product availability by Location + SKU', () => {
    const existingInv = [
      ['Warehouse A', 'SKU-001', 'Widget', 'Case', 100, 10, 20, 0, 15.00, 100, 90]
    ];
    const newInv = [
      ['Warehouse A', 'SKU-001', 'Widget', 'Case', 80, 20, 20, 0, 15.00, 80, 60],
      ['Warehouse B', 'SKU-001', 'Widget', 'Case', 50, 0, 0, 0, 15.00, 50, 50]
    ];

    const merged = cin7Engine.mergeInventoryData(existingInv, newInv);
    assert.strictEqual(merged.length, 2, 'Should have 2 location entries for SKU-001');
    const whA = merged.find(r => r[0] === 'Warehouse A');
    assert.strictEqual(whA[4], 80, 'Warehouse A on-hand should be updated to 80');
    assert.strictEqual(whA[10], 60, 'Warehouse A available should be updated to 60');
  });

  // --------------------------------------------------------------------------
  console.log('\n--- 3. Rolling Window Filter & State Persistence ---');
  // --------------------------------------------------------------------------

  test('filterSalesByWindow: Correctly prunes out-of-window records', () => {
    const today = new Date();
    const d5 = new Date(today.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const d20 = new Date(today.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const d45 = new Date(today.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const d120 = new Date(today.getTime() - 120 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const sampleRows = [
      [2026, 'Aug', 'SO-1', d5, 'INV-1', 'SKU-1', 'P1', 'Cin7', 'FG', 'FG', 'Std', 'C1', 'Invoiced', 'ea', 'S', '', '', 'Web', 1, 10, 10, 5, 0, 5, 0.5],
      [2026, 'Aug', 'SO-2', d20, 'INV-2', 'SKU-2', 'P2', 'Cin7', 'FG', 'FG', 'Std', 'C2', 'Invoiced', 'ea', 'S', '', '', 'Web', 1, 20, 20, 10, 0, 10, 0.5],
      [2026, 'Jul', 'SO-3', d45, 'INV-3', 'SKU-3', 'P3', 'Cin7', 'FG', 'FG', 'Std', 'C3', 'Invoiced', 'ea', 'S', '', '', 'Web', 1, 30, 30, 15, 0, 15, 0.5],
      [2026, 'May', 'SO-4', d120, 'INV-4', 'SKU-4', 'P4', 'Cin7', 'FG', 'FG', 'Std', 'C4', 'Invoiced', 'ea', 'S', '', '', 'Web', 1, 40, 40, 20, 0, 20, 0.5]
    ];

    const filtered7d = cin7Engine.filterSalesByWindow(sampleRows, '7d');
    assert.strictEqual(filtered7d.length, 1, '7d should only keep records within 7 days (SO-1)');

    const filtered30d = cin7Engine.filterSalesByWindow(sampleRows, '30d');
    assert.strictEqual(filtered30d.length, 2, '30d should keep SO-1 and SO-2');

    const filtered90d = cin7Engine.filterSalesByWindow(sampleRows, '90d');
    assert.strictEqual(filtered90d.length, 3, '90d should keep SO-1, SO-2, SO-3');

    const filtered365d = cin7Engine.filterSalesByWindow(sampleRows, '365d');
    assert.strictEqual(filtered365d.length, 4, '365d should keep all 4 records');
  });

  await testAsync('Current State & Snapshot Atomicity', async () => {
    const dataset = {
      headers: ['Month', 'Order date', 'Order #', 'Invoice date', 'Document #', 'SKU'],
      rows: [
        [2026, 'September', 'SO-LIVE-1', '2026-09-01', 'INV-LIVE-1', 'SKU-LIVE-1'],
        [2026, 'September', 'SO-LIVE-2', '2026-09-02', 'INV-LIVE-2', 'SKU-LIVE-2']
      ]
    };

    const saved = await snapshotService.saveCurrentAndSnapshot({
      clientId: testClientId,
      reportType: 'sales',
      periodLabel: 'Last 30 Days',
      dataset,
      syncRunId: 'run-verify-atomicity'
    });

    assert.ok(saved.snapshotId, 'Snapshot ID must be generated');
    assert.strictEqual(saved.recordCount, 2);

    const currentRows = snapshotService.getCurrentReportRows(testClientId, 'sales');
    assert.strictEqual(currentRows.rows.length, 2, 'Current state rows must match saved dataset');
    assert.strictEqual(currentRows.latestSnapshotId, saved.snapshotId);
  });

  // Cleanup test client files
  try {
    if (fs.existsSync(SYNC_STATE_FILE)) fs.unlinkSync(SYNC_STATE_FILE);
    const clientCurrentDir = path.join(STORAGE_ROOT, 'current_reports', testClientId);
    if (fs.existsSync(clientCurrentDir)) fs.rmSync(clientCurrentDir, { recursive: true, force: true });
    const clientSnapDir = path.join(STORAGE_ROOT, 'snapshots', testClientId);
    if (fs.existsSync(clientSnapDir)) fs.rmSync(clientSnapDir, { recursive: true, force: true });
  } catch (_) {}

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passedTests} / ${totalTests} TESTS PASSED`);
  console.log('================================================================\n');

  if (passedTests === totalTests) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
