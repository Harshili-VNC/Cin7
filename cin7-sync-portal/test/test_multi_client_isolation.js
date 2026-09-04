const fs = require('fs');
const path = require('path');
const assert = require('assert');

const clientStorageService = require('../src/services/clientStorageService');
const snapshotService = require('../src/services/snapshotService');
const cin7Engine = require('../src/services/cin7Engine');
const lockService = require('../src/services/lockService');
const db = require('../src/db');

async function runIsolationTestSuite() {
  console.log('================================================================');
  console.log('🛡️ MULTI-CLIENT DATA ISOLATION & STORAGE SECURITY TEST SUITE');
  console.log('================================================================\n');

  const clientAlpha = `client-alpha-${Date.now()}`;
  const clientBeta = `client-beta-${Date.now()}`;
  const STORAGE_ROOT = path.join(__dirname, '../storage');

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
  console.log('--- 1. Client ID Validation & Path Traversal Rejection ---');
  // --------------------------------------------------------------------------

  test('Valid client IDs pass allow-list format validation', () => {
    assert.strictEqual(clientStorageService.validateClientId('client-vnc-master'), 'client-vnc-master');
    assert.strictEqual(clientStorageService.validateClientId('client-alpha_123'), 'client-alpha_123');
    assert.strictEqual(clientStorageService.validateClientId('tenant-999'), 'tenant-999');
  });

  test('TEST 11 — Invalid Tenant Path: Path traversal and malformed IDs are strictly rejected', () => {
    const invalidIds = [
      '../../other-client',
      '../storage',
      'client/a',
      'client\\b',
      'client;drop table',
      'client 123',
      '',
      null,
      undefined,
      'client\0null'
    ];

    for (const invalid of invalidIds) {
      assert.throws(
        () => clientStorageService.validateClientId(invalid),
        /Invalid clientId/,
        `Expected rejection for invalid clientId: '${invalid}'`
      );
    }
  });

  // --------------------------------------------------------------------------
  console.log('\n--- 2. Storage Namespace Isolation ---');
  // --------------------------------------------------------------------------

  test('TEST 1 — Per-Client Storage Directories are Completely Isolated', () => {
    const dirA = clientStorageService.getClientDir(clientAlpha);
    const dirB = clientStorageService.getClientDir(clientBeta);

    assert.ok(dirA.includes(path.join('storage', 'clients', clientAlpha)));
    assert.ok(dirB.includes(path.join('storage', 'clients', clientBeta)));
    assert.notStrictEqual(dirA, dirB);

    const snapDirA = clientStorageService.getClientSnapshotsDir(clientAlpha);
    const snapDirB = clientStorageService.getClientSnapshotsDir(clientBeta);
    assert.notStrictEqual(snapDirA, snapDirB);

    const cacheDirA = clientStorageService.getClientOrderCacheDir(clientAlpha);
    const cacheDirB = clientStorageService.getClientOrderCacheDir(clientBeta);
    assert.notStrictEqual(cacheDirA, cacheDirB);
  });

  // --------------------------------------------------------------------------
  console.log('\n--- 3. Order Cache Isolation (Disk & In-Memory) ---');
  // --------------------------------------------------------------------------

  test('TEST 3 — Order Cache is Strictly Tenant-Scoped (No Cross-Client Leaks)', () => {
    const saleId = 'SO-TEST-999';
    const detailAlpha = {
      Order: { Lines: [{ SKU: 'SKU-ALPHA', Quantity: 10, AverageCost: 5, Total: 100 }] },
      UpdatedDateUtc: '2026-09-04T08:00:00Z'
    };

    // Store order detail for Client Alpha
    cin7Engine.storeOrderDetail(clientAlpha, saleId, detailAlpha, '2026-09-04T08:00:00Z');

    // Retrieve for Client Alpha -> must exist
    const cachedAlpha = cin7Engine.getStoredOrderDetail(clientAlpha, saleId, '2026-09-04T08:00:00Z');
    assert.ok(cachedAlpha, 'Client Alpha must retrieve its own cached order detail');
    assert.strictEqual(cachedAlpha.Order.Lines[0].SKU, 'SKU-ALPHA');

    // Retrieve for Client Beta -> must be NULL (no leak)
    const cachedBeta = cin7Engine.getStoredOrderDetail(clientBeta, saleId, '2026-09-04T08:00:00Z');
    assert.strictEqual(cachedBeta, null, 'Client Beta must NOT be able to access Client Alpha cached order detail');
  });

  // --------------------------------------------------------------------------
  console.log('\n--- 4. Independent Sync State & Report Configurations ---');
  // --------------------------------------------------------------------------

  test('TEST 4 — Independent Sync States: Client Alpha (30d) vs Client Beta (365d)', () => {
    const boundaryAlpha = '2026-09-04T08:30:00.000Z';
    const boundaryBeta = '2026-09-04T09:00:00.000Z';

    // Client Alpha on 30d
    snapshotService.updateSyncState(clientAlpha, 'sales', {
      reportWindow: '30d',
      lastSuccessfulSync: boundaryAlpha,
      lastSyncRunId: 'run-alpha-1',
      recordCount: 150
    });

    // Client Beta on 365d
    snapshotService.updateSyncState(clientBeta, 'sales', {
      reportWindow: '365d',
      lastSuccessfulSync: boundaryBeta,
      lastSyncRunId: 'run-beta-1',
      recordCount: 1200
    });

    const stateA = snapshotService.getSyncState(clientAlpha);
    const stateB = snapshotService.getSyncState(clientBeta);

    assert.strictEqual(stateA.reports.sales.reportWindow, '30d');
    assert.strictEqual(stateA.reports.sales.lastSuccessfulSync, boundaryAlpha);
    assert.strictEqual(stateA.reports.sales.recordCount, 150);

    assert.strictEqual(stateB.reports.sales.reportWindow, '365d');
    assert.strictEqual(stateB.reports.sales.lastSuccessfulSync, boundaryBeta);
    assert.strictEqual(stateB.reports.sales.recordCount, 1200);

    // Incremental safety checks
    const safetyA = snapshotService.isIncrementalSafe(clientAlpha, 'sales', '30d');
    const safetyB = snapshotService.isIncrementalSafe(clientBeta, 'sales', '365d');
    assert.strictEqual(safetyA.safe, true);
    assert.strictEqual(safetyB.safe, true);
    assert.strictEqual(safetyA.lastSuccessfulSync, boundaryAlpha);
    assert.strictEqual(safetyB.lastSuccessfulSync, boundaryBeta);
  });

  // --------------------------------------------------------------------------
  console.log('\n--- 5. Snapshots & Current Reports Isolation ---');
  // --------------------------------------------------------------------------

  await testAsync('TEST 5 — Snapshots and Current State Isolation Between Tenants', async () => {
    const datasetAlpha = {
      headers: ['Month', 'Order #', 'SKU', 'Revenue', 'Profit'],
      rows: [
        [2026, 'SO-A1', 'SKU-A1', 500, 250],
        [2026, 'SO-A2', 'SKU-A2', 300, 150]
      ]
    };

    const datasetBeta = {
      headers: ['Month', 'Order #', 'SKU', 'Revenue', 'Profit'],
      rows: [
        [2026, 'SO-B1', 'SKU-B1', 9999, 4999]
      ]
    };

    const snapAlpha = await snapshotService.saveCurrentAndSnapshot({
      clientId: clientAlpha,
      reportType: 'sales',
      periodLabel: 'Last 30 Days',
      dataset: datasetAlpha,
      syncRunId: 'run-alpha-snap'
    });

    const snapBeta = await snapshotService.saveCurrentAndSnapshot({
      clientId: clientBeta,
      reportType: 'sales',
      periodLabel: 'Last 365 Days',
      dataset: datasetBeta,
      syncRunId: 'run-beta-snap'
    });

    // Verify Current Reports Isolation
    const currentA = await snapshotService.getCurrentReports(clientAlpha);
    const currentB = await snapshotService.getCurrentReports(clientBeta);

    assert.strictEqual(currentA.sales.recordCount, 2);
    assert.strictEqual(currentA.sales.rows[0][1], 'SO-A1');

    assert.strictEqual(currentB.sales.recordCount, 1);
    assert.strictEqual(currentB.sales.rows[0][1], 'SO-B1');

    // Verify Direct Snapshot Snooping Prevention
    const snapDataAlpha = await snapshotService.getSnapshotData(clientAlpha, snapAlpha.snapshotId);
    assert.strictEqual(snapDataAlpha.id, snapAlpha.snapshotId);

    // Client Beta attempting to query Client Alpha's snapshot must throw/fail
    await assert.rejects(
      async () => await snapshotService.getSnapshotData(clientBeta, snapAlpha.snapshotId),
      /not found|Unauthorized/,
      'Client Beta must not be able to read Client Alpha snapshot'
    );
  });

  await testAsync('TEST 6 — Cross-Tenant Snapshot Export and Reconciliation Prevention', async () => {
    const currentA = await snapshotService.getCurrentReports(clientAlpha);
    const currentB = await snapshotService.getCurrentReports(clientBeta);

    const snapIdA = currentA.sales.latestSnapshotId;
    const snapIdB = currentB.sales.latestSnapshotId;

    // Export Client Alpha snapshot using Client Beta credentials -> must reject
    await assert.rejects(
      async () => await snapshotService.exportSnapshotCsv(clientBeta, snapIdA),
      /not found|Unauthorized/,
      'Cross-tenant export must be rejected'
    );

    // Reconcile Client Alpha snapshot with Client Beta snapshot -> must reject
    await assert.rejects(
      async () => await snapshotService.reconcileSnapshots(clientAlpha, snapIdA, snapIdB),
      /not found|Unauthorized/,
      'Cross-tenant reconciliation must be rejected'
    );
  });

  // --------------------------------------------------------------------------
  console.log('\n--- 6. Per-Client Concurrency Mutex Locking ---');
  // --------------------------------------------------------------------------

  test('TEST 8 — Same Client Concurrent Sync: Mutex prevents concurrent corrupting executions', () => {
    const run1 = 'run-mutex-001';
    const run2 = 'run-mutex-002';

    // 1. Client Alpha acquires lock
    const lock1 = lockService.acquireLock(clientAlpha, run1);
    assert.strictEqual(lock1.acquired, true, 'First lock request for Client Alpha must succeed');
    assert.strictEqual(lockService.isLocked(clientAlpha), true);

    // 2. Second concurrent request for Client Alpha must be rejected (HTTP 409 conflict simulation)
    const lock2 = lockService.acquireLock(clientAlpha, run2);
    assert.strictEqual(lock2.acquired, false, 'Second concurrent lock for Client Alpha must be rejected');
    assert.ok(lock2.reason.includes('Sync already in progress'));

    // 3. Release lock for Run 1
    const released = lockService.releaseLock(clientAlpha, run1);
    assert.strictEqual(released, true);
    assert.strictEqual(lockService.isLocked(clientAlpha), false);

    // 4. Now Run 2 can safely acquire lock
    const lock2Retry = lockService.acquireLock(clientAlpha, run2);
    assert.strictEqual(lock2Retry.acquired, true, 'After release, next sync can acquire lock');
    lockService.releaseLock(clientAlpha, run2);
  });

  test('TEST 9 — Different Client Concurrent Sync: Client Alpha and Client Beta sync in parallel', () => {
    const runAlpha = 'run-parallel-alpha';
    const runBeta = 'run-parallel-beta';

    // Client Alpha acquires lock
    const lockA = lockService.acquireLock(clientAlpha, runAlpha);
    assert.strictEqual(lockA.acquired, true, 'Client Alpha lock acquired');

    // Client Beta acquires lock simultaneously -> must NOT be blocked by Alpha
    const lockB = lockService.acquireLock(clientBeta, runBeta);
    assert.strictEqual(lockB.acquired, true, 'Client Beta lock acquired simultaneously without blocking');

    assert.strictEqual(lockService.isLocked(clientAlpha), true);
    assert.strictEqual(lockService.isLocked(clientBeta), true);

    // Release both
    lockService.releaseLock(clientAlpha, runAlpha);
    lockService.releaseLock(clientBeta, runBeta);

    assert.strictEqual(lockService.isLocked(clientAlpha), false);
    assert.strictEqual(lockService.isLocked(clientBeta), false);
  });

  // --------------------------------------------------------------------------
  console.log('\n--- 7. Verified Legacy Migration with Explicit Ownership ---');
  // --------------------------------------------------------------------------

  test('TEST 10 — Legacy Migration Ownership: Unverified/mismatched data is never migrated', () => {
    const legacyTestClient = `client-mig-${Date.now()}`;
    const legacyDir = path.join(STORAGE_ROOT, 'sync_state');
    if (!fs.existsSync(legacyDir)) fs.mkdirSync(legacyDir, { recursive: true });

    const legacyFile = path.join(legacyDir, `${legacyTestClient}.json`);

    // Write legacy file with MISMATCHED metadata owner (says 'other-owner')
    fs.writeFileSync(legacyFile, JSON.stringify({
      clientId: 'other-owner-123',
      reports: { sales: { recordCount: 99 } }
    }), 'utf8');

    // Run safe migration
    const result = clientStorageService.safeMigrateLegacyClientData(legacyTestClient);
    const targetFile = clientStorageService.getClientSyncStatePath(legacyTestClient);

    // Verified: target file must NOT have been created because ownership did not match!
    assert.strictEqual(fs.existsSync(targetFile), false, 'Mismatched legacy file must NOT be migrated');

    // Clean up
    if (fs.existsSync(legacyFile)) fs.unlinkSync(legacyFile);
  });

  // Cleanup test client folders
  try {
    const dirA = clientStorageService.getClientDir(clientAlpha);
    const dirB = clientStorageService.getClientDir(clientBeta);
    if (fs.existsSync(dirA)) fs.rmSync(dirA, { recursive: true, force: true });
    if (fs.existsSync(dirB)) fs.rmSync(dirB, { recursive: true, force: true });
  } catch (_) {}

  console.log('\n================================================================');
  console.log(`📊 TEST SUITE RESULTS: ${passedTests} / ${totalTests} TESTS PASSED`);
  console.log('================================================================\n');

  if (passedTests === totalTests) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runIsolationTestSuite().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
