/**
 * VNC CIN7 SYNC — VNC SUPER ADMIN PORTAL TEST SUITE
 * Verifies SUPER_ADMIN authorization, 403 enforcement for normal users,
 * 11 monitoring and aggregation APIs, Organization 360° inspection,
 * cross-tenant audit logging, and strict secret masking.
 */

const http = require('http');
const app = require('../src/server');
const db = require('../src/db');
const cryptoService = require('../src/services/cryptoService');

let server;
let baseUrl;

function makeRequest(path, options = {}, cookie = '') {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const reqOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { 'Cookie': cookie } : {}),
        ...(options.headers || {})
      }
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      const setCookie = res.headers['set-cookie'];
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { json = data; }
        resolve({ status: res.statusCode, data: json, headers: res.headers, cookie: setCookie ? setCookie[0].split(';')[0] : cookie });
      });
    });

    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('\n================================================================');
  console.log('🛡️ VNC SUPER ADMIN PORTAL & CROSS-TENANT MONITORING TEST SUITE');
  console.log('================================================================\n');

  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://localhost:${port}`;
  console.log(`🚀 Test server listening on port ${port}\n`);

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  try {
    // -------------------------------------------------------------
    // Auth Sessions Setup
    // -------------------------------------------------------------
    console.log('--- 1. Session Setup & Role Logins ---');

    const superPass = 'SuperAdmin2026!#';
    const testPass = 'TestPass2026!#';

    // Seed test users
    await db.query('UPDATE users SET password_hash = ?, platform_role = ? WHERE email = ?', [cryptoService.hashPassword(superPass), 'SUPER_ADMIN', 'superadmin@vnc.global']);
    await db.query('UPDATE users SET password_hash = ?, role = ? WHERE email = ?', [cryptoService.hashPassword(testPass), 'ADMIN', 'harshili.patni@vnc.global']);

    // Ensure manager and viewer exist
    const clientMaster = 'client-05262fcf';
    const existingMgr = await db.getOne('SELECT id FROM users WHERE email = ?', ['manager@vnc.global']);
    if (!existingMgr) {
      await db.query(
        `INSERT INTO users (id, client_id, full_name, email, password_hash, role, platform_role, auth_provider, status, onboarding_status)
         VALUES (?, ?, 'Test Manager', 'manager@vnc.global', ?, 'MANAGER', 'USER', 'local', 'ACTIVE', 'completed')`,
        ['user-test-mgr-001', clientMaster, cryptoService.hashPassword(testPass)]
      );
    } else {
      await db.query('UPDATE users SET password_hash = ?, role = ? WHERE email = ?', [cryptoService.hashPassword(testPass), 'MANAGER', 'manager@vnc.global']);
    }

    const existingVwr = await db.getOne('SELECT id FROM users WHERE email = ?', ['viewer@vnc.global']);
    if (!existingVwr) {
      await db.query(
        `INSERT INTO users (id, client_id, full_name, email, password_hash, role, platform_role, auth_provider, status, onboarding_status)
         VALUES (?, ?, 'Test Viewer', 'viewer@vnc.global', ?, 'VIEWER', 'USER', 'local', 'ACTIVE', 'completed')`,
        ['user-test-vwr-001', clientMaster, cryptoService.hashPassword(testPass)]
      );
    } else {
      await db.query('UPDATE users SET password_hash = ?, role = ? WHERE email = ?', [cryptoService.hashPassword(testPass), 'VIEWER', 'viewer@vnc.global']);
    }
    
    // 1. Super Admin Login
    const saLogin = await makeRequest('/api/auth/login', {
      method: 'POST',
      body: { email: 'superadmin@vnc.global', password: superPass }
    });
    assert(saLogin.status === 200, 'Super Admin logs in successfully');
    assert(saLogin.data.user && saLogin.data.user.platformRole === 'SUPER_ADMIN', 'Super Admin has platform_role = SUPER_ADMIN');
    const saCookie = saLogin.cookie;

    // 2. Org Admin Login
    const adminLogin = await makeRequest('/api/auth/login', {
      method: 'POST',
      body: { email: 'harshili.patni@vnc.global', password: testPass }
    });
    assert(adminLogin.status === 200, 'Org Admin logs in successfully');
    assert(adminLogin.data.user && adminLogin.data.user.platformRole === 'USER', 'Org Admin has platform_role = USER');
    const adminCookie = adminLogin.cookie;

    // 3. Org Manager Login
    const mgrLogin = await makeRequest('/api/auth/login', {
      method: 'POST',
      body: { email: 'manager@vnc.global', password: testPass }
    });
    const mgrCookie = mgrLogin.cookie;

    // 4. Org Viewer Login
    const vwrLogin = await makeRequest('/api/auth/login', {
      method: 'POST',
      body: { email: 'viewer@vnc.global', password: testPass }
    });
    const vwrCookie = vwrLogin.cookie;

    // -------------------------------------------------------------
    // Test 1 - 4: Super Admin Gate & 403 Forbidden for Non-Super Admins
    // -------------------------------------------------------------
    console.log('\n--- 2. Super Admin Authorization Enforcement ---');
    
    const saDash = await makeRequest('/api/admin/dashboard', {}, saCookie);
    assert(saDash.status === 200 && saDash.data.success === true, 'SUPER_ADMIN is PERMITTED to access /api/admin/dashboard');

    const adminDash = await makeRequest('/api/admin/dashboard', {}, adminCookie);
    assert(adminDash.status === 403, 'Normal Organization ADMIN receives 403 FORBIDDEN on /api/admin/*');

    const mgrDash = await makeRequest('/api/admin/dashboard', {}, mgrCookie);
    assert(mgrDash.status === 403, 'Organization MANAGER receives 403 FORBIDDEN on /api/admin/*');

    const vwrDash = await makeRequest('/api/admin/dashboard', {}, vwrCookie);
    assert(vwrDash.status === 403, 'Organization VIEWER receives 403 FORBIDDEN on /api/admin/*');

    const unauthDash = await makeRequest('/api/admin/dashboard', {});
    assert(unauthDash.status === 401, 'Unauthenticated request receives 401 UNAUTHORIZED');

    // -------------------------------------------------------------
    // Test 5 - 8: Organizations Listing, Search, Filter & Pagination
    // -------------------------------------------------------------
    console.log('\n--- 3. Organizations Management & Server-Side Pagination ---');
    const orgsRes = await makeRequest('/api/admin/organizations?page=1&limit=10', {}, saCookie);
    assert(orgsRes.status === 200, 'GET /api/admin/organizations returns 200 OK');
    assert(Array.isArray(orgsRes.data.organizations), 'Returns list of organizations');
    assert(orgsRes.data.pagination?.total >= 1, 'Pagination metadata is populated');

    // Search by name
    const searchRes = await makeRequest('/api/admin/organizations?search=VNC', {}, saCookie);
    assert(searchRes.data.organizations.some(o => o.name?.includes('VNC') || o.id?.includes('vnc')), 'Search by organization name works');

    // Filter by status
    const filterRes = await makeRequest('/api/admin/organizations?status=ACTIVE', {}, saCookie);
    assert(filterRes.data.organizations.every(o => o.status === 'ACTIVE'), 'Filter by status ACTIVE works accurately');

    // -------------------------------------------------------------
    // Test 9: Organization 360° Inspection View
    // -------------------------------------------------------------
    console.log('\n--- 4. Organization 360° Deep Inspection ---');
    const org360 = await makeRequest('/api/admin/organizations/client-vnc-master', {}, saCookie);
    assert(org360.status === 200, 'GET /api/admin/organizations/:id returns 200 OK');
    assert(org360.data.organization?.id === 'client-vnc-master', 'Returns correct organization profile');
    assert(Array.isArray(org360.data.users) && org360.data.users.length > 0, 'Returns full user membership list');
    assert(org360.data.subscription !== undefined, 'Returns subscription and plan details');
    assert(org360.data.integrations?.cin7 !== undefined, 'Returns CIN7 integration status');
    assert(org360.data.integrations?.googleSheets !== undefined, 'Returns Google Sheets status');

    // -------------------------------------------------------------
    // Test 10 - 15: Subviews: Users, Subscriptions, Billing, CIN7, Sheets, Sync
    // -------------------------------------------------------------
    console.log('\n--- 5. Platform Aggregation APIs ---');
    
    // Cross-org users directory
    const usersDir = await makeRequest('/api/admin/users?page=1&limit=20', {}, saCookie);
    assert(usersDir.status === 200 && Array.isArray(usersDir.data.users), 'Users directory returns cross-tenant user list');

    // Subscriptions monitoring
    const subsMon = await makeRequest('/api/admin/subscriptions', {}, saCookie);
    assert(subsMon.status === 200 && Array.isArray(subsMon.data.subscriptions), 'Subscriptions monitoring returns active/trial plans');

    // Billing & Payment Due monitoring
    const billMon = await makeRequest('/api/admin/billing?section=all', {}, saCookie);
    assert(billMon.status === 200 && Array.isArray(billMon.data.billingItems), 'Billing monitoring returns local payment-due status items');

    // CIN7 Integration health across orgs
    const cin7Mon = await makeRequest('/api/admin/cin7', {}, saCookie);
    assert(cin7Mon.status === 200 && Array.isArray(cin7Mon.data.connections), 'CIN7 monitoring returns connections without exposing keys');

    // Google Sheets health across orgs
    const sheetsMon = await makeRequest('/api/admin/google-sheets', {}, saCookie);
    assert(sheetsMon.status === 200 && Array.isArray(sheetsMon.data.integrations), 'Google Sheets monitoring returns spreadsheet status');

    // Sync runs platform-wide
    const syncMon = await makeRequest('/api/admin/sync', {}, saCookie);
    assert(syncMon.status === 200 && Array.isArray(syncMon.data.syncRuns), 'Sync monitoring returns real platform sync runs');

    // -------------------------------------------------------------
    // Test 16: Usage Metrics & System Health
    // -------------------------------------------------------------
    console.log('\n--- 6. Usage Analytics & System Health ---');
    const usageRes = await makeRequest('/api/admin/usage?range=30d', {}, saCookie);
    assert(usageRes.status === 200 && usageRes.data.usage?.totalOrganizations >= 1, 'Platform usage API aggregates metrics accurately');

    const healthRes = await makeRequest('/api/admin/system-health', {}, saCookie);
    assert(healthRes.status === 200, 'System health endpoint returns 200 OK');
    assert(healthRes.data.health?.database?.status === 'CONNECTED', 'System health reports database status');
    assert(healthRes.data.health?.storage?.status === 'ISOLATED', 'System health verifies client storage isolation');
    assert(typeof healthRes.data.health?.uptimeSeconds === 'number', 'System health reports process uptime');

    // -------------------------------------------------------------
    // Test 17 & 18: Masked Secrets & Credential Protection
    // -------------------------------------------------------------
    console.log('\n--- 7. Security: Zero Plaintext Secret Exposure ---');
    // Check CIN7 endpoint payload
    const cin7Item = cin7Mon.data.connections[0];
    assert(!cin7Item.apiKey || cin7Item.apiKey.includes('•'), 'CIN7 API Key is never exposed in plaintext in admin APIs');
    assert(!cin7Item.apiSecret, 'CIN7 API Secret is not present in responses');

    // Check user directory payload for password hashes
    const userItem = usersDir.data.users[0];
    assert(!userItem.password_hash && !userItem.password, 'User password hashes are omitted from cross-org user directory');

    // -------------------------------------------------------------
    // Test 19 & 20: Cross-Tenant Access Audit Logging
    // -------------------------------------------------------------
    console.log('\n--- 8. Platform Audit Trail & Cross-Tenant Logging ---');
    const auditRes = await makeRequest('/api/admin/audit', {}, saCookie);
    assert(auditRes.status === 200 && Array.isArray(auditRes.data.auditLogs), 'Audit logs endpoint returns platform events');
    
    // Verify inspection of client-vnc-master created an audit record
    const hasOrg360Log = auditRes.data.auditLogs.some(l => l.action === 'ORGANIZATION_VIEWED' && l.organization_id === 'client-vnc-master');
    assert(hasOrg360Log === true, 'Super Admin inspection of Organization 360° was automatically audited');

  } catch (err) {
    console.error('Test execution exception:', err);
    failed++;
  } finally {
    if (server) server.close();
  }

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} PASSED | ${failed} FAILED (TOTAL: ${passed + failed})`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
