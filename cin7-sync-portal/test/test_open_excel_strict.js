const app = require('../src/server');
const db = require('../src/db');
const ExcelJS = require('exceljs');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

async function testOpenExcelStrict() {
  console.log('=====================================================================');
  console.log('🧪 STRICT VERIFICATION: OPEN EXCEL ONLINE VS DOWNLOAD .XLSX');
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

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // ─────────────────────────────────────────────────────────────────
    // 1. DISCONNECTED STATE: Microsoft 365 NOT Connected
    // ─────────────────────────────────────────────────────────────────
    console.log('--- 1. Testing Disconnected State (Microsoft 365 Not Connected) ---');

    const discEmail = `disc-user-${Date.now()}@vnc.global`;
    const discClientId = `client-disc-${uuidv4().substring(0, 6)}`;
    const discUserId = `user-disc-${uuidv4().substring(0, 6)}`;

    await db.query(
      'INSERT INTO clients (id, company_name, status, onboarding_status) VALUES (?, ?, ?, ?)',
      [discClientId, 'Disconnected Corp', 'ACTIVE', 'completed']
    );

    await db.query(
      `INSERT INTO users (id, client_id, full_name, email, phone_number, auth_provider, role, onboarding_status)
       VALUES (?, ?, ?, ?, ?, 'email', 'CLIENT', 'completed')`,
      [discUserId, discClientId, 'Local User', discEmail, '+1 555 000 1111']
    );

    const localUserRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: discEmail, password: '123456' })
    });
    const localCookie = localUserRes.headers.get('set-cookie') || '';
    assert(localUserRes.status === 200, 'Authenticated local email user');

    const wbRes = await fetch(`${baseUrl}/api/destination/workbook`, {
      headers: { cookie: localCookie }
    });
    const wbData = await wbRes.json();

    assert(wbRes.status === 200, 'GET /api/destination/workbook returned HTTP 200');
    assert(wbData.connected === false, 'connected flag is FALSE for disconnected user');
    assert(wbData.webUrl === null, 'webUrl is NULL (No fake URLs, No silent fallback)');
    assert(
      wbData.message && (wbData.message.includes('Microsoft 365 is not connected') || wbData.message.includes('Microsoft 365 file access permission is required')),
      `Returned clear notification message: "${wbData.message}"`
    );

    // ─────────────────────────────────────────────────────────────────
    // 2. CONNECTED STATE: Microsoft 365 Connected via OAuth / Graph
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- 2. Testing Connected State (Microsoft 365 OAuth Connected) ---');

    const m365ClientId = `client-m365-${uuidv4().substring(0, 6)}`;
    const m365UserId = `user-m365-${uuidv4().substring(0, 6)}`;
    const m365Email = `executive-${Date.now()}@vnc-corp.com`;

    // Insert M365 tenant record
    await db.query(
      'INSERT INTO clients (id, company_name, status, onboarding_status) VALUES (?, ?, ?, ?)',
      [m365ClientId, 'VNC Global Financials', 'ACTIVE', 'completed']
    );

    await db.query(
      `INSERT INTO users (id, client_id, full_name, email, phone_number, auth_provider, role, onboarding_status)
       VALUES (?, ?, ?, ?, ?, 'microsoft', 'CLIENT', 'completed')`,
      [m365UserId, m365ClientId, 'Chief Financial Officer', m365Email, '+1 555 777 8899']
    );

    // Authenticate M365 user
    const oauthRes = await fetch(`${baseUrl}/api/auth/oauth/mock-authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'microsoft',
        email: m365Email,
        name: 'Chief Financial Officer',
        providerUserId: `ms-graph-${m365UserId}`
      })
    });
    const m365Cookie = oauthRes.headers.get('set-cookie') || '';
    assert(oauthRes.status === 200, 'Authenticated M365 user');

    const m365WbRes = await fetch(`${baseUrl}/api/destination/workbook`, {
      headers: { cookie: m365Cookie }
    });
    const m365WbData = await m365WbRes.json();

    assert(m365WbRes.status === 200 && m365WbData.success, 'GET /api/destination/workbook returned success');
    assert(m365WbData.connected === true, 'connected flag is TRUE for M365 user');
    assert(
      m365WbData.webUrl && m365WbData.webUrl.startsWith('https://'),
      `Returned genuine Microsoft Excel Online webUrl: ${m365WbData.webUrl}`
    );

    // ─────────────────────────────────────────────────────────────────
    // 3. SEPARATE ACTION: Dedicated Download .xlsx Button
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- 3. Testing Dedicated "Download .xlsx" Action ---');

    const downloadRes = await fetch(`${baseUrl}/api/destination/download`, {
      headers: { cookie: m365Cookie }
    });
    const downloadBuf = Buffer.from(await downloadRes.arrayBuffer());

    assert(downloadRes.status === 200, 'GET /api/destination/download returned HTTP 200');
    assert(
      downloadRes.headers.get('content-type') === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Type is valid Excel spreadsheetml.sheet'
    );
    assert(
      (downloadRes.headers.get('content-disposition') || '').includes('.xlsx'),
      'Content-Disposition header includes .xlsx filename'
    );
    assert(downloadBuf.length > 100000, `Downloaded valid binary Excel workbook (${downloadBuf.length} bytes)`);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(downloadBuf);
    assert(wb.worksheets.length === 17, 'Preserved all 17 worksheets in downloaded .xlsx');

    // ─────────────────────────────────────────────────────────────────
    // 4. HISTORICAL VERSION: Open Version in Excel Online
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- 4. Testing Historical Version "Open Version" in Excel Online ---');

    // Sync a run to generate historical snapshot
    const syncRes = await fetch(`${baseUrl}/api/sync/all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: m365Cookie },
      body: JSON.stringify({ timelinePeriod: 'Last 30 days' })
    });
    const syncData = await syncRes.json();
    assert(syncRes.status === 200 && syncData.success, `Sync all completed with version ${syncData.excelVersionId}`);

    const historyRes = await fetch(`${baseUrl}/api/sync/history?page=1&limit=5`, {
      headers: { cookie: m365Cookie }
    });
    const historyData = await historyRes.json();
    assert(historyData.items.length > 0, `Audit history returned ${historyData.items.length} records`);

    const runItem = historyData.items[0];
    const openVerRes = await fetch(`${baseUrl}/api/sync/history/${runItem.id}/open-version`, {
      headers: { cookie: m365Cookie }
    });
    const openVerData = await openVerRes.json();

    assert(openVerRes.status === 200 && openVerData.success, 'Historical open-version returned success');
    assert(
      openVerData.webUrl && openVerData.webUrl.startsWith('https://'),
      `Historical version returns real Microsoft Excel Online URL: ${openVerData.webUrl}`
    );

    // Test historical version download endpoint
    const dlVerRes = await fetch(`${baseUrl}/api/sync/history/${runItem.id}/download-version`, {
      headers: { cookie: m365Cookie }
    });
    const dlVerBuf = Buffer.from(await dlVerRes.arrayBuffer());
    assert(dlVerRes.status === 200, 'GET /api/sync/history/:id/download-version returned HTTP 200');
    assert(dlVerBuf.length > 100000, `Downloaded historical version binary .xlsx (${dlVerBuf.length} bytes)`);

    console.log('\n=====================================================================');
    console.log(`📊 STRICT OPEN EXCEL TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('=====================================================================\n');

    server.close();
    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    server.close();
    console.error('❌ Strict test crash:', err);
    process.exit(1);
  }
}

testOpenExcelStrict();
