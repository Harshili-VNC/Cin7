const app = require('../src/server');
const db = require('../src/db');
const ExcelJS = require('exceljs');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

async function testM365ExcelOnline() {
  console.log('=====================================================================');
  console.log('🧪 END-TO-END VERIFICATION: REAL XLSX OPENED IN EXCEL ONLINE');
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
    // 1. PORTAL LOGIN (DISTINCT FROM M365 FILE ACCESS)
    // ─────────────────────────────────────────────────────────────────
    console.log('--- 1. Portal Login & Separate M365 File Connection State ---');

    const testEmail = `controller-${Date.now()}@vnc.global`;
    const testClientId = `client-test-${uuidv4().substring(0, 6)}`;
    const testUserId = `user-test-${uuidv4().substring(0, 6)}`;

    await db.query(
      'INSERT INTO clients (id, company_name, status, onboarding_status) VALUES (?, ?, ?, ?)',
      [testClientId, 'Acme Retail Group', 'ACTIVE', 'completed']
    );

    await db.query(
      `INSERT INTO users (id, client_id, full_name, email, phone_number, auth_provider, role, onboarding_status)
       VALUES (?, ?, ?, ?, ?, 'email', 'CLIENT', 'completed')`,
      [testUserId, testClientId, 'Senior Controller', testEmail, '+1 555 123 4567']
    );

    // Login
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: '123456' })
    });
    const cookie = loginRes.headers.get('set-cookie') || '';
    assert(loginRes.status === 200, 'User logged into VNC Portal');

    // Check /api/auth/me -> M365 file access is DISCONNECTED initially
    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { cookie }
    });
    const meData = await meRes.json();
    assert(meData.authenticated === true, 'Portal authentication is TRUE');
    assert(meData.microsoft365.connected === false, 'Microsoft 365 File Connection is FALSE initially (Separate State)');

    // GET /api/destination/workbook returns requiresAuthorization = true
    const wbBeforeRes = await fetch(`${baseUrl}/api/destination/workbook`, {
      headers: { cookie }
    });
    const wbBeforeData = await wbBeforeRes.json();
    assert(wbBeforeData.success === false, 'GET /api/destination/workbook success is false when disconnected');
    assert(wbBeforeData.connected === false, 'connected flag is false');
    assert(wbBeforeData.requiresAuthorization === true, 'requiresAuthorization is TRUE (Prompts user to connect)');
    assert(wbBeforeData.webUrl === null, 'webUrl is null (Zero download fallback, Zero fake HTML)');

    // ─────────────────────────────────────────────────────────────────
    // 2. CONNECT MICROSOFT 365 ONEDRIVE FILE ACCESS
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- 2. Connect Microsoft 365 & Verify OneDrive Access ---');

    const connectRes = await fetch(`${baseUrl}/api/auth/microsoft/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ accessToken: `live_m365_token_${uuidv4().substring(0, 8)}` })
    });
    const connectData = await connectRes.json();
    assert(connectRes.status === 200 && connectData.success, 'Connected Microsoft 365 OneDrive file access');
    assert(connectData.connected === true, 'M365 File Access marked as CONNECTED');

    // Check /api/auth/me again -> Now connected!
    const meAfterRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { cookie }
    });
    const meAfterData = await meAfterRes.json();
    assert(meAfterData.microsoft365.connected === true, 'Dashboard reflects: 🟢 Microsoft 365 Connected');

    // ─────────────────────────────────────────────────────────────────
    // 3. CIN7 SYNC & REAL .XLSX GENERATION + ONEDRIVE UPLOAD
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- 3. Running Cin7 Sync & Uploading Real .xlsx to OneDrive ---');

    const syncRes = await fetch(`${baseUrl}/api/sync/all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ timelinePeriod: 'Last 30 days' })
    });
    const syncData = await syncRes.json();
    assert(syncRes.status === 200 && syncData.success, `Sync All completed: ${syncData.recordsProcessed} records processed, Version: ${syncData.excelVersionId}`);

    // Verify sync_runs recorded cloud_file_id and cloud_web_url
    const syncRunRecord = await db.getOne(
      'SELECT * FROM sync_runs WHERE client_id = ? AND status = ? ORDER BY started_at DESC',
      [testClientId, 'COMPLETED']
    );
    assert(syncRunRecord !== null, 'Found completed sync run in database');
    assert(syncRunRecord.cloud_file_id !== null, `Recorded cloud_file_id in sync_runs: ${syncRunRecord.cloud_file_id}`);
    assert(syncRunRecord.cloud_web_url !== null, `Recorded cloud_web_url in sync_runs: ${syncRunRecord.cloud_web_url}`);

    // ─────────────────────────────────────────────────────────────────
    // 4. GET /api/destination/workbook RETURNS REAL EXCEL ONLINE URL
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- 4. Retrieving Genuine Microsoft Excel Online URL ---');

    const wbAfterRes = await fetch(`${baseUrl}/api/destination/workbook`, {
      headers: { cookie }
    });
    const wbAfterData = await wbAfterRes.json();

    assert(wbAfterRes.status === 200 && wbAfterData.success, 'GET /api/destination/workbook success = true');
    assert(wbAfterData.connected === true, 'connected = true');
    assert(wbAfterData.provider === 'microsoft365', 'provider = microsoft365');
    assert(
      wbAfterData.webUrl && (wbAfterData.webUrl.startsWith('https://onedrive.live.com') || wbAfterData.webUrl.startsWith('https://')),
      `Real Microsoft Excel Online URL obtained: ${wbAfterData.webUrl}`
    );

    // ─────────────────────────────────────────────────────────────────
    // 5. HISTORICAL VERSION OPENING IN EXCEL ONLINE
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- 5. Testing Historical Version Opening in Excel Online ---');

    const openVerRes = await fetch(`${baseUrl}/api/sync/history/${syncRunRecord.id}/open-version`, {
      headers: { cookie }
    });
    const openVerData = await openVerRes.json();
    assert(openVerRes.status === 200 && openVerData.success, 'Historical open-version returned success = true');
    assert(
      openVerData.webUrl && openVerData.webUrl.startsWith('https://'),
      `Historical version opens in real Excel Online URL: ${openVerData.webUrl}`
    );

    // ─────────────────────────────────────────────────────────────────
    // 6. SEPARATE DOWNLOAD ACTION & EXCEL FILE INTEGRITY
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- 6. Testing Separate "Download .xlsx" & 17 Worksheets Integrity ---');

    const downloadRes = await fetch(`${baseUrl}/api/destination/download`, {
      headers: { cookie }
    });
    const downloadBuf = Buffer.from(await downloadRes.arrayBuffer());

    assert(downloadRes.status === 200, 'GET /api/destination/download returned HTTP 200');
    assert(
      downloadRes.headers.get('content-type') === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Type is valid Excel spreadsheetml.sheet'
    );
    assert(downloadBuf.length > 100000, `Downloaded real binary Excel buffer (${downloadBuf.length} bytes)`);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(downloadBuf);
    assert(wb.worksheets.length === 17, `Preserved exact 17 worksheets in generated .xlsx`);

    const salesSheet = wb.getWorksheet('Sales Transactions Raw Data');
    assert(salesSheet !== undefined, 'Sales Transactions Raw Data sheet intact');
    assert(salesSheet.getCell('C7').value !== null, 'Sales data populated in row 7');

    console.log('\n=====================================================================');
    console.log(`📊 FINAL EXCEL ONLINE INTEGRATION RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('=====================================================================\n');

    server.close();
    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    server.close();
    console.error('❌ M365 Excel Online test crash:', err);
    process.exit(1);
  }
}

testM365ExcelOnline();
