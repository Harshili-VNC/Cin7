const assert = require('assert');
const http = require('http');
const app = require('../src/server');
const cryptoService = require('../src/services/cryptoService');
const db = require('../src/db');

let server;
let port;
let baseUrl;

function makeRequest(path, options = {}, cookie = '') {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(path, baseUrl);
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };
    if (cookie) headers['Cookie'] = cookie;

    const req = http.request(parsedUrl, {
      method: options.method || 'GET',
      headers
    }, (res) => {
      let data = '';
      const setCookie = res.headers['set-cookie'];
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: json, headers: res.headers, cookie: setCookie ? setCookie[0].split(';')[0] : cookie });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data, headers: res.headers });
        }
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
  console.log('--- Testing Organization Lifecycle & Dynamic Addition ---');

  // 1. Start Server
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      port = server.address().port;
      baseUrl = `http://localhost:${port}`;
      console.log(`Test server running on port ${port}`);
      resolve();
    });
  });

  try {
    // 2. Seed and Login as Super Admin
    const superPass = 'SuperAdminPass2026!#';
    const existingSa = await db.getOne('SELECT id FROM users WHERE email = ?', ['superadmin@vnc.global']);
    if (existingSa) {
      await db.query('UPDATE users SET password_hash = ?, platform_role = ? WHERE email = ?', [cryptoService.hashPassword(superPass), 'SUPER_ADMIN', 'superadmin@vnc.global']);
    } else {
      await db.query(
        `INSERT INTO users (id, client_id, full_name, email, password_hash, role, platform_role, status, auth_provider, onboarding_status)
         VALUES (?, ?, ?, ?, ?, ?, 'SUPER_ADMIN', 'ACTIVE', 'local', 'completed')`,
        ['user-super-admin-root', 'client-vnc-master', 'Platform Super Admin', 'superadmin@vnc.global', cryptoService.hashPassword(superPass), 'SUPER_ADMIN']
      );
    }

    const loginRes = await makeRequest('/api/auth/login', {
      method: 'POST',
      body: { email: 'superadmin@vnc.global', password: superPass }
    });
    assert.strictEqual(loginRes.status, 200, 'Super admin login succeeds');
    const adminCookie = loginRes.cookie;

    // 3. Get initial list of organizations
    const initialListRes = await makeRequest('/api/admin/organizations?limit=100', {}, adminCookie);
    assert.strictEqual(initialListRes.status, 200, 'GET /api/admin/organizations returns 200');
    const initialCount = initialListRes.data.total !== undefined ? initialListRes.data.total : initialListRes.data.organizations.length;
    console.log(`Initial organizations total: ${initialCount}`);

    // 4. Add a brand new client organization
    const testCompanyName = `Test Client ${Date.now()}`;
    const createRes = await makeRequest('/api/admin/organizations', {
      method: 'POST',
      body: {
        companyName: testCompanyName,
        contactName: 'Alice Johnson',
        email: `alice.${Date.now()}@testclient.com`,
        phoneNumber: '+1 555-0199',
        plan: 'PROFESSIONAL'
      }
    }, adminCookie);

    assert.strictEqual(createRes.status, 200, 'POST /api/admin/organizations creates organization');
    assert.strictEqual(createRes.data.success, true);
    console.log(`✅ Created organization: ${testCompanyName} (ID: ${createRes.data.organization.id})`);
    const newOrgId = createRes.data.organization.id;

    // 5. Verify the new organization immediately appears in the list
    const updatedListRes = await makeRequest('/api/admin/organizations?limit=100', {}, adminCookie);
    assert.strictEqual(updatedListRes.status, 200);
    const updatedCount = updatedListRes.data.total !== undefined ? updatedListRes.data.total : updatedListRes.data.organizations.length;
    assert.strictEqual(updatedCount, initialCount + 1, 'Organizations count increased by 1');
    const found = updatedListRes.data.organizations.find(o => o.id === newOrgId);
    assert(found !== undefined, 'New organization is in the returned list');
    assert.strictEqual(found.companyName, testCompanyName, 'Company name matches');
    console.log(`✅ Verified new organization is dynamically present in directory: ${found.companyName}`);

    // 6. Delete the test organization
    const deleteRes = await makeRequest(`/api/admin/organizations/${newOrgId}`, {
      method: 'DELETE'
    }, adminCookie);
    assert.strictEqual(deleteRes.status, 200, 'DELETE /api/admin/organizations/:id returns 200');
    console.log(`✅ Cleanly deleted temporary test organization: ${newOrgId}`);

    // 7. Verify list is back to clean initial state
    const finalListRes = await makeRequest('/api/admin/organizations?limit=100', {}, adminCookie);
    const finalCount = finalListRes.data.total !== undefined ? finalListRes.data.total : finalListRes.data.organizations.length;
    assert.strictEqual(finalCount, initialCount, 'Clean list restored');
    console.log(`✅ Final clean organization list verified (Count: ${finalCount})`);

    console.log('\n🎉 ALL ORGANIZATION LIFECYCLE TESTS PASSED!');
  } finally {
    server.close();
  }
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
