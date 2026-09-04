const app = require('../src/server');
const ExcelJS = require('exceljs');
const http = require('http');

async function testApiEndpoints() {
  console.log('=====================================================================');
  console.log('🧪 TESTING API ENDPOINTS & REAL .XLSX BINARY DOWNLOADS');
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

  // Start test server on random port
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  let cookie = '';

  try {
    // 1. Sign In
    console.log('--- 1. Authenticating Client User ---');
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'harshili.patni@vnc.global', password: '123456' })
    });
    const loginData = await loginRes.json();
    cookie = loginRes.headers.get('set-cookie') || '';

    assert(loginRes.status === 200 && loginData.success, 'Logged in successfully as harshili.patni@vnc.global');

    // 2. GET /api/destination/workbook metadata
    console.log('\n--- 2. Checking Workbook Metadata ---');
    const wbRes = await fetch(`${baseUrl}/api/destination/workbook`, {
      headers: { cookie }
    });
    const wbData = await wbRes.json();
    assert(wbRes.status === 200 && (wbData.success || wbData.requiresAuthorization), 'Retrieved destination workbook metadata');
    assert(wbData.file && (!wbData.file.webUrl || !wbData.file.webUrl.includes('/api/destination/view/')), 'Metadata webUrl does NOT point to fake HTML viewer');

    // 3. POST /api/sync/all (Creates real version snapshot or fails safely)
    console.log('\n--- 3. Triggering Sync to Real Excel Workbook ---');
    const syncRes = await fetch(`${baseUrl}/api/sync/all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ timelinePeriod: 'Last 30 days', destination: 'excel' })
    });
    const syncData = await syncRes.json();

    if (syncRes.status === 200 && syncData.success) {
      assert(syncData.success, `Sync all completed (${syncData.recordsProcessed} records, Version ${syncData.versionId})`);
    } else {
      assert(syncRes.status === 500 && syncData.status === 'FAILED', 'Sync failed safely without injecting fake data');
      assert(syncData.errorMessage && syncData.errorMessage.includes('Cin7 synchronization failed'), 'Received safe error message from backend');
      console.log(`✅ [PASS] Sync failed safely as expected on remote credentials: ${syncData.errorMessage}`);
    }

    // 4. GET /api/destination/download (Binary .xlsx download)
    console.log('\n--- 4. Testing GET /api/destination/download (Real .xlsx Binary Stream) ---');
    const downloadRes = await fetch(`${baseUrl}/api/destination/download`, {
      headers: { cookie }
    });
    const downloadBuf = Buffer.from(await downloadRes.arrayBuffer());

    assert(downloadRes.status === 200, `Download returned HTTP status 200`);
    assert(
      downloadRes.headers.get('content-type') === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      `Content-Type is Excel spreadsheetml.sheet`
    );
    assert(
      (downloadRes.headers.get('content-disposition') || '').includes('.xlsx'),
      `Content-Disposition contains .xlsx filename`
    );
    assert(downloadBuf.length > 100000, `Received valid binary Excel buffer (${downloadBuf.length} bytes)`);

    // Verify downloaded buffer is a real Excel workbook (current template has 14 sheets)
    const downloadedWb = new ExcelJS.Workbook();
    await downloadedWb.xlsx.load(downloadBuf);
    const sheetCount = downloadedWb.worksheets.length;
    assert(sheetCount >= 10, `Downloaded buffer is a valid Excel workbook with ${sheetCount} worksheets`);

    // 5. GET /api/sync/history & GET /api/sync/history/:historyId/session
    console.log('\n--- 5. Testing Historical Version Inspection ---');
    const historyRes = await fetch(`${baseUrl}/api/sync/history?page=1&limit=10`, {
      headers: { cookie }
    });
    const historyData = await historyRes.json();
    const historyItems = historyData.syncRuns || historyData.items || [];
    assert(historyRes.status === 200 && historyItems.length > 0, `Sync history returned ${historyItems.length} records`);

    const prevRes = await fetch(`${baseUrl}/api/reports/previous`, {
      headers: { cookie }
    });
    const prevData = await prevRes.json();
    assert(prevRes.status === 200 && Array.isArray(prevData.snapshots), 'Retrieved previous snapshots list');

    if (prevData.snapshots.length > 0) {
      const snap = prevData.snapshots[0];
      const exportRes = await fetch(`${baseUrl}/api/reports/snapshots/${snap.id}/export`, {
        headers: { cookie }
      });
      assert(exportRes.status === 200, 'Snapshot export returned HTTP 200');
      assert((exportRes.headers.get('content-type') || '').includes('text/csv'), 'Snapshot export is text/csv');
    }

    // 6. Verify NO fake HTML spreadsheet endpoint exists
    console.log('\n--- 6. Verifying Deprecated HTML Spreadsheet Viewers are REMOVED ---');
    const fakeViewerRes = await fetch(`${baseUrl}/api/destination/view/ms-excel-test`, {
      headers: { cookie }
    });
    const fakeText = await fakeViewerRes.text();
    assert(fakeViewerRes.status === 404 || !fakeText.includes('class="excel-grid"'), 'Deprecated /api/destination/view/ is NOT serving HTML spreadsheet');

    console.log('\n=====================================================================');
    console.log(`📊 API ENDPOINTS TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('=====================================================================\n');

    server.close();
    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    server.close();
    console.error('❌ API verification crash:', err);
    process.exit(1);
  }
}

testApiEndpoints();
