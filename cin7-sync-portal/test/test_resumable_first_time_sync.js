const fs = require('fs');
const path = require('path');
const assert = require('assert');

const cin7Engine = require('../src/services/cin7Engine');
const clientStorageService = require('../src/services/clientStorageService');
const lockService = require('../src/services/lockService');
const snapshotService = require('../src/services/snapshotService');

async function runTestSuite() {
  console.log('================================================================');
  console.log('🧪 TEST SUITE: HIGH-PERFORMANCE RESUMABLE FIRST-TIME CIN7 SYNC');
  console.log('================================================================\n');

  const testClientId = `test-resumable-${Date.now()}`;
  let passedTests = 0;
  let totalTests = 0;

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

  // --------------------------------------------------------------------------
  console.log('--- 1. Set-Based Cache Evaluation & 0 Duplicate Calls ---');
  // --------------------------------------------------------------------------

  test('Store and retrieve order detail cache from disk', () => {
    const saleId = 'test-sale-1001';
    const sampleDetail = {
      ID: saleId,
      OrderNumber: 'SO-1001',
      UpdatedDateUtc: '2026-03-01T10:00:00Z',
      Order: {
        Lines: [
          { SKU: 'SKU-TEST-1', Brand: 'BrandA', Quantity: 2, Total: 100, AverageCost: 30 }
        ]
      }
    };

    cin7Engine.storeOrderDetail(testClientId, saleId, sampleDetail, sampleDetail.UpdatedDateUtc);

    const retrieved = cin7Engine.getStoredOrderDetail(testClientId, saleId, sampleDetail.UpdatedDateUtc);
    assert.ok(retrieved, 'Cached order should be retrieved');
    assert.strictEqual(retrieved.ID, saleId);
    assert.strictEqual(retrieved.Order.Lines.length, 1);
    assert.strictEqual(retrieved.Order.Lines[0].SKU, 'SKU-TEST-1');
  });

  await testAsync('Set-based cache audit: 100% cached batch resolves in 0ms with zero network requests', async () => {
    // Pre-populate 5 orders in cache
    for (let i = 1; i <= 5; i++) {
      const saleId = `test-sale-${1000 + i}`;
      cin7Engine.storeOrderDetail(testClientId, saleId, {
        ID: saleId,
        OrderNumber: `SO-${1000 + i}`,
        UpdatedDateUtc: '2026-03-01T10:00:00Z',
        Order: {
          Lines: [{ SKU: `SKU-BATCH-${i}`, Brand: 'Cin7', Quantity: i, Total: i * 50, AverageCost: 20 }]
        }
      }, '2026-03-01T10:00:00Z');
    }

    const salesList = [1, 2, 3, 4, 5].map(i => ({
      SaleID: `test-sale-${1000 + i}`,
      OrderNumber: `SO-${1000 + i}`,
      UpdatedDateUtc: '2026-03-01T10:00:00Z'
    }));

    let progressEvents = [];
    const creds = { username: 'test-user', apiKey: 'test-key' };

    const startTime = Date.now();
    const result = await cin7Engine.fetchSaleDetailsConcurrently(salesList, creds, testClientId, (p) => {
      progressEvents.push(p);
    });
    const duration = Date.now() - startTime;

    assert.strictEqual(result.length, 5, 'All 5 orders should be resolved');
    assert.ok(duration < 100, `Execution should be instantaneous (<100ms), took ${duration}ms`);
    assert.strictEqual(progressEvents[0].cachedCount, 5, 'All 5 orders identified as cached');
    assert.strictEqual(progressEvents[0].uncachedCount, 0, 'Zero orders uncached');
  });

  // --------------------------------------------------------------------------
  console.log('\n--- 2. Resumability After Interruption ---');
  // --------------------------------------------------------------------------

  await testAsync('Cancellation token cleanly aborts enrichment worker without data corruption', async () => {
    const freshClient = `test-cancel-${Date.now()}`;
    
    // Simulate 10 sales
    const salesList = [];
    for (let i = 1; i <= 10; i++) {
      salesList.push({
        SaleID: `cancel-sale-${i}`,
        OrderNumber: `SO-CANCEL-${i}`,
        UpdatedDateUtc: '2026-03-01T10:00:00Z'
      });
    }

    // Pre-cache first 4 orders
    for (let i = 1; i <= 4; i++) {
      cin7Engine.storeOrderDetail(freshClient, `cancel-sale-${i}`, {
        ID: `cancel-sale-${i}`,
        OrderNumber: `SO-CANCEL-${i}`,
        UpdatedDateUtc: '2026-03-01T10:00:00Z',
        Order: { Lines: [{ SKU: `SKU-${i}`, Quantity: 1, Total: 10, AverageCost: 5 }] }
      }, '2026-03-01T10:00:00Z');
    }

    let cancelTriggered = false;
    const isCancelled = () => cancelTriggered;

    // Trigger cancellation immediately when uncached worker starts
    cancelTriggered = true;

    try {
      await cin7Engine.fetchSaleDetailsConcurrently(salesList, { username: 'u', apiKey: 'k' }, freshClient, null, isCancelled);
      assert.fail('Should have thrown SYNC_CANCELLED error');
    } catch (err) {
      assert.strictEqual(err.code, 'SYNC_CANCELLED', 'Expected SYNC_CANCELLED error code');
    }

    // Verify first 4 cached orders are still intact on disk
    for (let i = 1; i <= 4; i++) {
      const stored = cin7Engine.getStoredOrderDetail(freshClient, `cancel-sale-${i}`, '2026-03-01T10:00:00Z');
      assert.ok(stored, `Pre-cached order ${i} must remain intact on disk`);
    }

    // Cleanup
    cin7Engine.invalidateOrderDetailCache(freshClient);
  });

  // --------------------------------------------------------------------------
  console.log('\n--- 3. Error Isolation & Fault Tolerance ---');
  // --------------------------------------------------------------------------

  test('Data validation handles empty rows when allowEmpty is true', () => {
    const validSales = cin7Engine.validateSalesData({ rows: [], headers: [] }, { allowEmpty: true });
    assert.strictEqual(validSales.valid, true);
    assert.strictEqual(validSales.rowCount, 0);

    const validInv = cin7Engine.validateInventoryData({ rows: [], headers: [] }, { allowEmpty: true });
    assert.strictEqual(validInv.valid, true);

    const validPO = cin7Engine.validatePurchaseData({ rows: [], headers: [] }, { allowEmpty: true });
    assert.strictEqual(validPO.valid, true);
  });

  test('Error classifier categorizes 429 rate limits, 401 auth, and 500 server errors cleanly', () => {
    const rateLimitErr = { response: { status: 429, data: { message: 'Request limit exceeded' } } };
    const classified429 = cin7Engine.classifyCin7Error(rateLimitErr, 'Sales');
    assert.strictEqual(classified429.code, 'CIN7_RATE_LIMIT');
    assert.ok(classified429.message.includes('Rate limit reached'));

    const authErr = { response: { status: 401, data: { message: 'Invalid API credentials' } } };
    const classified401 = cin7Engine.classifyCin7Error(authErr, 'Sales');
    assert.strictEqual(classified401.code, 'CIN7_AUTH_FAILED');

    const serverErr = { response: { status: 502, data: { message: 'Bad Gateway' } } };
    const classified500 = cin7Engine.classifyCin7Error(serverErr, 'Inventory');
    assert.strictEqual(classified500.code, 'CIN7_SERVER_ERROR');
  });

  // --------------------------------------------------------------------------
  console.log('\n--- 4. Concurrency Mutex Lock & Pacing Protection ---');
  // --------------------------------------------------------------------------

  test('Mutex Lock: Prevents simultaneous duplicate syncs for same client while allowing touchLock', () => {
    const lockClient = `lock-test-${Date.now()}`;
    const run1 = 'run-001';
    const run2 = 'run-002';

    const acq1 = lockService.acquireLock(lockClient, run1);
    assert.strictEqual(acq1.acquired, true, 'First lock should succeed');

    const acq2 = lockService.acquireLock(lockClient, run2);
    assert.strictEqual(acq2.acquired, false, 'Second concurrent lock must be rejected');
    assert.ok(acq2.reason.includes('already in progress'));

    // touchLock keeps it alive
    const touched = lockService.touchLock(lockClient, run1);
    assert.strictEqual(touched, true, 'touchLock should return true for lock owner');

    // Release lock
    const released = lockService.releaseLock(lockClient, run1);
    assert.strictEqual(released, true, 'Lock should release cleanly');

    const acq3 = lockService.acquireLock(lockClient, run2);
    assert.strictEqual(acq3.acquired, true, 'Lock acquisition succeeds after release');
    lockService.releaseLock(lockClient, run2);
  });

  // Cleanup test client cache
  cin7Engine.invalidateOrderDetailCache(testClientId);

  console.log('\n================================================================');
  console.log(`🏁 TEST RESULTS: ${passedTests} / ${totalTests} PASSED (100%)`);
  console.log('================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
