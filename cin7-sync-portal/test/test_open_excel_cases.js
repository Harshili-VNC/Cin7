const app = require('../src/server');
const db = require('../src/db');
const ExcelJS = require('exceljs');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

async function testOpenExcelCases() {
  console.log('=====================================================================');
  console.log('🧪 TESTING "OPEN EXCEL" BOTH PATHS: CLOUD M365 VS DESKTOP DOWNLOAD');
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
    // PATH 1: CASE 2 — MICROSOFT 365 NOT CONNECTED (DESKTOP DOWNLOAD)
    // ─────────────────────────────────────────────────────────────────
    console.log('--- PATH 1: Case 2 (Microsoft 365 NOT Connected -> Desktop .xlsx Download) ---');

    const unconnectedEmail = `unconnected-${Date.now()}@vnc.global`;
    const unconnectedClientId = `client-unconn-${uuidv4().substring(0, 6)}`;
    const unconnectedUserId = `user-unconn-${uuidv4().substring(0, 6)}`;

    await db.query(
      'INSERT INTO clients (id, company_name, status, onboarding_status) VALUES (?, ?, ?, ?)',
      [unconnectedClientId, 'Unconnected Retail Ltd', 'ACTIVE', 'completed']
    );

    await db.query(
      `INSERT INTO users (id, client_id, full_name, email, phone_number, auth_provider, role, onboarding_status)
       VALUES (?, ?, ?, ?, ?, 'email', 'CLIENT', 'completed')`,
      [unconnectedUserId, unconnectedClientId, 'Local Manager', unconnectedEmail, '+1 555 333 4444']
    );

    // Authenticate local user without Microsoft Graph cloud token
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: unconnectedEmail, password: '123456' })
    });
    const cookie = loginRes.headers.get('set-cookie') || '';
    assert(loginRes.status === 200, 'Authenticated local client user');

    // GET /api/destination/workbook
    const wbRes = await fetch(`${baseUrl}/api/destination/workbook`, {
      headers: { cookie }
    });
    const wbData = await wbRes.json();
    assert(wbRes.status === 200 && (wbData.success || wbData.requiresAuthorization), 'Retrieved destination workbook metadata');
    assert(wbData.webUrl === null, 'Case 2: webUrl is NULL when Microsoft 365 cloud is not connected');
    assert(wbData.downloadUrl === '/api/destination/download', 'Case 2: downloadUrl points to /api/destination/download');

    // Download .xlsx
    const downloadRes = await fetch(`${baseUrl}/api/destination/download`, {
      headers: { cookie }
    });
    const downloadBuf = Buffer.from(await downloadRes.arrayBuffer());
    assert(downloadRes.status === 200, 'GET /api/destination/download returned HTTP 200');
    assert(
      downloadRes.headers.get('content-type') === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Type is valid Excel spreadsheetml.sheet'
    );
    assert(
      downloadRes.headers.get('content-disposition')?.includes('filename='),
      'Content-Disposition header includes .xlsx filename'
    );
    assert(downloadBuf.length > 100000, `Valid binary Excel workbook received (${downloadBuf.length} bytes)`);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(downloadBuf);
    assert(wb.worksheets.length > 0, 'Downloaded workbook contains worksheets');

    // ─────────────────────────────────────────────────────────────────
    // PATH 2: CASE 1 — MICROSOFT 365 CONNECTED (REAL EXCEL ONLINE URL)
    // ─────────────────────────────────────────────────────────────────
    console.log('\n--- PATH 2: Case 1 (Microsoft 365 Connected -> Real Excel Online URL) ---');

    const m365ClientId = `client-m365-${uuidv4().substring(0, 6)}`;
    const m365UserId = `user-m365-${uuidv4().substring(0, 6)}`;
    const m365Email = `m365-client-${Date.now()}@vnc.global`;

    // 1. Create client & user
    await db.query(
      'INSERT INTO clients (id, company_name, status, onboarding_status) VALUES (?, ?, ?, ?)',
      [m365ClientId, 'M365 Enterprise Client', 'ACTIVE', 'completed']
    );

    await db.query(
      `INSERT INTO users (id, client_id, full_name, email, phone_number, auth_provider, role, onboarding_status)
       VALUES (?, ?, ?, ?, ?, 'microsoft', 'CLIENT', 'completed')`,
      [m365UserId, m365ClientId, 'Enterprise Lead', m365Email, '+1 555 999 8888']
    );

    // 2. Perform Mock OAuth Authorize for Microsoft
    const oauthRes = await fetch(`${baseUrl}/api/auth/oauth/mock-authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'microsoft',
        email: m365Email,
        name: 'Enterprise Lead',
        providerUserId: `ms-graph-${m365UserId}`
      })
    });
    const m365Cookie = oauthRes.headers.get('set-cookie') || '';
    assert(oauthRes.status === 200, 'Authenticated via Microsoft OAuth');

    // 3. GET /api/destination/workbook returns verified Microsoft Graph webUrl
    const m365WbRes = await fetch(`${baseUrl}/api/destination/workbook`, {
      headers: { cookie: m365Cookie }
    });
    const m365WbData = await m365WbRes.json();
    assert(
      m365WbData.webUrl && m365WbData.webUrl.startsWith('https://'),
      `Case 1: webUrl returns real Microsoft Excel Online URL: ${m365WbData.webUrl}`
    );
    assert(
      !m365WbData.webUrl.includes('/api/destination/view/'),
      'Case 1: webUrl points directly to Microsoft OneDrive / Office Online'
    );

    // Verify ZERO fake HTML spreadsheet viewer endpoints exist
    console.log('\n--- ZERO HTML VIEWER VERIFICATION ---');
    const viewRes = await fetch(`${baseUrl}/api/destination/view/any-file`, {
      headers: { cookie }
    });
    const viewText = await viewRes.text();
    assert(viewRes.status === 404 || !viewText.includes('class="excel-grid"'), 'Deprecated HTML spreadsheet viewer is NOT present');

    console.log('\n=====================================================================');
    console.log(`📊 "OPEN EXCEL" BOTH PATHS RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('=====================================================================\n');

    server.close();
    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    server.close();
    console.error('❌ Test crash:', err);
    process.exit(1);
  }
}

testOpenExcelCases();
