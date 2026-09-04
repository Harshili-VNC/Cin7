const http = require('http');
const assert = require('assert');
const app = require('../src/server');
const db = require('../src/db');
const clientStorageService = require('../src/services/clientStorageService');

async function runCompanyAuthAndSettingsTests() {
  console.log('================================================================');
  console.log('🏢 ENTERPRISE MULTI-TENANT SAAS AUTH & SETTINGS TEST SUITE');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function test(name, condition) {
    if (condition) {
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${name}`);
      failed++;
    }
  }

  // Start test server on dynamic port
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  console.log(`🚀 Test server started dynamically on port ${port} (${baseUrl})\n`);

  async function login(email, password) {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    const cookie = res.headers.get('set-cookie') || '';
    return { res, data, cookie };
  }

  try {
    // ------------------------------------------------------------------------
    console.log('--- 1. Multi-Role Authentication & Organization Context ---');
    // ------------------------------------------------------------------------
    
    // 1.1 Admin Login
    const adminAuth = await login('harshili.patni@vnc.global', '12345');
    test('Admin user logs in successfully', adminAuth.res.status === 200 && adminAuth.data.success);
    test('Admin user has ADMIN role', adminAuth.data.user?.role === 'ADMIN');
    test('Admin user has Organization VNC Global Business Edge', (adminAuth.data.client?.companyName || adminAuth.data.organization?.name || '').includes('VNC Global Business Edge'));
    test('Admin user maps to internal client_id client-vnc-master', adminAuth.data.user?.clientId === 'client-vnc-master');

    // 1.2 Manager Login
    const managerAuth = await login('manager@vnc.global', '12345');
    test('Manager user logs in successfully', managerAuth.res.status === 200 && managerAuth.data.success);
    test('Manager user has MANAGER role', managerAuth.data.user?.role === 'MANAGER');
    test('Manager user maps to same organization client-vnc-master', managerAuth.data.user?.clientId === 'client-vnc-master');

    // 1.3 Viewer Login
    const viewerAuth = await login('viewer@vnc.global', '12345');
    test('Viewer user logs in successfully', viewerAuth.res.status === 200 && viewerAuth.data.success);
    test('Viewer user has VIEWER role', viewerAuth.data.user?.role === 'VIEWER');

    // ------------------------------------------------------------------------
    console.log('\n--- 2. Masked API Keys & Secret Security ---');
    // ------------------------------------------------------------------------

    // 2.1 Unauthenticated Request to Credentials
    const unauthCin7 = await fetch(`${baseUrl}/api/integrations/cin7`);
    test('Unauthenticated request to integrations is blocked (401)', unauthCin7.status === 401);

    // 2.2 Admin requests CIN7 credentials
    const adminCin7 = await fetch(`${baseUrl}/api/integrations/cin7`, {
      headers: { cookie: adminAuth.cookie }
    });
    const adminCin7Data = await adminCin7.json();
    test('Admin can access CIN7 integration details', adminCin7.status === 200 && adminCin7Data.success);
    test('CIN7 API key is masked as ••••••••••••••••••••', (adminCin7Data.integration?.apiKeyMasked || adminCin7Data.apiKeyMasked) === '••••••••••••••••••••');
    test('Plaintext API key is NEVER exposed in GET response', adminCin7Data.integration?.apiKey === undefined && adminCin7Data.apiKey === undefined);

    // 2.3 Viewer cannot modify credentials
    const viewerPutCin7 = await fetch(`${baseUrl}/api/integrations/cin7`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: viewerAuth.cookie },
      body: JSON.stringify({ accountId: 'test', apiKey: 'test' })
    });
    test('Viewer is blocked from modifying CIN7 credentials (403)', viewerPutCin7.status === 403);

    // ------------------------------------------------------------------------
    console.log('\n--- 3. System Health & Real Dynamic Metrics ---');
    // ------------------------------------------------------------------------

    const healthRes = await fetch(`${baseUrl}/api/organization/health`, {
      headers: { cookie: adminAuth.cookie }
    });
    const healthData = await healthRes.json();
    test('System health endpoint returns 200 OK', healthRes.status === 200 && healthData.success);
    test('System health contains CIN7 status', healthData.health?.cin7 && typeof healthData.health.cin7.connected === 'boolean');
    test('System health contains Google Sheets status', healthData.health?.googleSheets && typeof healthData.health.googleSheets.connected === 'boolean');
    test('System health contains Daily Sync status', healthData.health?.dailySync && typeof healthData.health.dailySync.active === 'boolean');
    test('System health contains real sync metrics (lastSync, recordsSynced, successRate)', 
      typeof (healthData.health?.lastSync || healthData.health?.metrics?.lastSync) === 'string' &&
      typeof (healthData.health?.recordsSynced || healthData.health?.metrics?.totalRecordsProcessed) === 'number' &&
      typeof (healthData.health?.successRate || healthData.health?.metrics?.successRate) === 'string'
    );

    // ------------------------------------------------------------------------
    console.log('\n--- 4. Role-Based Access Control (RBAC) Permission Matrix ---');
    // ------------------------------------------------------------------------

    // 4.1 Sync Trigger Permissions
    // Viewer: Blocked from triggering sync
    const viewerSyncRes = await fetch(`${baseUrl}/api/sync/inventory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: viewerAuth.cookie }
    });
    test('Viewer is FORBIDDEN from triggering syncs (403)', viewerSyncRes.status === 403);

    // Manager: Allowed to trigger sync
    const managerSyncRes = await fetch(`${baseUrl}/api/sync/inventory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: managerAuth.cookie }
    });
    test('Manager is PERMITTED to trigger syncs', managerSyncRes.status === 200 || managerSyncRes.status === 409);

    // 4.2 Organization Settings Permissions
    // Manager: Blocked from updating organization
    const managerPutOrg = await fetch(`${baseUrl}/api/organization`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: managerAuth.cookie },
      body: JSON.stringify({ companyName: 'Hacked Corp' })
    });
    test('Manager is FORBIDDEN from modifying organization settings (403)', managerPutOrg.status === 403);

    // Admin: Allowed to update organization
    const adminPutOrg = await fetch(`${baseUrl}/api/organization`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminAuth.cookie },
      body: JSON.stringify({ companyName: 'VNC Global Business Edge Pvt Ltd', timezone: 'Asia/Kolkata' })
    });
    const adminPutOrgData = await adminPutOrg.json();
    test('Admin is PERMITTED to update organization settings', adminPutOrg.status === 200 && adminPutOrgData.success);

    // ------------------------------------------------------------------------
    console.log('\n--- 5. Team & Access Management ---');
    // ------------------------------------------------------------------------

    // 5.1 Manager cannot invite team members
    const managerInviteRes = await fetch(`${baseUrl}/api/team/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: managerAuth.cookie },
      body: JSON.stringify({ fullName: 'Unauthorized Invite', email: 'unauth@vnc.global', role: 'VIEWER' })
    });
    test('Manager is FORBIDDEN from inviting team members (403)', managerInviteRes.status === 403);

    // 5.2 Admin invites a new member
    const testMemberEmail = `finance.analyst.${Date.now()}@vnc.global`;
    const adminInviteRes = await fetch(`${baseUrl}/api/team/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminAuth.cookie },
      body: JSON.stringify({ fullName: 'Finance Analyst', email: testMemberEmail, role: 'VIEWER' })
    });
    const adminInviteData = await adminInviteRes.json();
    test('Admin can invite new team member', adminInviteRes.status === 200 && adminInviteData.success);
    const newUserId = adminInviteData.member?.id;

    // 5.3 Admin updates new member's role to MANAGER
    if (newUserId) {
      const updateRoleRes = await fetch(`${baseUrl}/api/team/${newUserId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie: adminAuth.cookie },
        body: JSON.stringify({ role: 'MANAGER' })
      });
      const updateRoleData = await updateRoleRes.json();
      test('Admin can promote team member to MANAGER', updateRoleRes.status === 200 && updateRoleData.member?.role === 'MANAGER');

      // 5.4 Admin removes the test team member
      const deleteMemberRes = await fetch(`${baseUrl}/api/team/${newUserId}`, {
        method: 'DELETE',
        headers: { cookie: adminAuth.cookie }
      });
      const deleteMemberData = await deleteMemberRes.json();
      test('Admin can remove team member', deleteMemberRes.status === 200 && deleteMemberData.success);
    }

    // 5.5 Admin cannot delete or demote themselves (self-protection)
    const adminSelfId = adminAuth.data.user?.id;
    if (adminSelfId) {
      const selfDeleteRes = await fetch(`${baseUrl}/api/team/${adminSelfId}`, {
        method: 'DELETE',
        headers: { cookie: adminAuth.cookie }
      });
      test('Admin is prevented from self-deletion', selfDeleteRes.status === 400);

      const selfDemoteRes = await fetch(`${baseUrl}/api/team/${adminSelfId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie: adminAuth.cookie },
        body: JSON.stringify({ role: 'VIEWER' })
      });
      test('Admin is prevented from self-demotion', selfDemoteRes.status === 400);
    }

    // ------------------------------------------------------------------------
    console.log('\n--- 6. Settings, Automation Preferences & Password Hashing ---');
    // ------------------------------------------------------------------------

    // 6.1 Sync Settings
    const putSyncStg = await fetch(`${baseUrl}/api/sync/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminAuth.cookie },
      body: JSON.stringify({ dailySyncEnabled: true, dailySyncTime: '03:30', incrementalSync: true })
    });
    const putSyncStgData = await putSyncStg.json();
    test('Admin can update sync schedule & incremental preferences', putSyncStg.status === 200 && putSyncStgData.settings?.dailySyncTime === '03:30');

    // 6.2 Notifications Settings
    const putNotif = await fetch(`${baseUrl}/api/notifications`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminAuth.cookie },
      body: JSON.stringify({ dailySummary: true, syncCompleted: true, syncFailed: true, criticalErrors: true, weeklyReports: false })
    });
    const putNotifData = await putNotif.json();
    test('Admin can update notification channels', putNotif.status === 200 && putNotifData.notifications?.weeklyReports === false);

    // 6.3 Clear Cache Action
    const clearCacheRes = await fetch(`${baseUrl}/api/security/clear-cache`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminAuth.cookie },
      body: JSON.stringify({ cacheType: 'order_detail' })
    });
    const clearCacheData = await clearCacheRes.json();
    test('Admin can clear enriched order detail cache', clearCacheRes.status === 200 && clearCacheData.success);

    // 6.4 Password Change with PBKDF2 Hashing
    const changePwdRes = await fetch(`${baseUrl}/api/security/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminAuth.cookie },
      body: JSON.stringify({ currentPassword: '12345', newPassword: 'newSecretPassword2026', confirmPassword: 'newSecretPassword2026' })
    });
    const changePwdData = await changePwdRes.json();
    test('User can change password securely', changePwdRes.status === 200 && changePwdData.success);

    // Revert password back to '12345'
    await fetch(`${baseUrl}/api/security/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminAuth.cookie },
      body: JSON.stringify({ currentPassword: 'newSecretPassword2026', newPassword: '12345', confirmPassword: '12345' })
    });

    // ------------------------------------------------------------------------
    console.log('\n--- 7. Integration Connection Tests ---');
    // ------------------------------------------------------------------------

    const testCin7Res = await fetch(`${baseUrl}/api/integrations/cin7/test`, {
      method: 'POST',
      headers: { cookie: adminAuth.cookie }
    });
    test('CIN7 connection test endpoint responds', testCin7Res.status === 200);

    const testSheetsRes = await fetch(`${baseUrl}/api/integrations/google-sheets/test`, {
      method: 'POST',
      headers: { cookie: adminAuth.cookie }
    });
    test('Google Sheets connection test endpoint responds', testSheetsRes.status === 200);

  } finally {
    server.close();
  }

  console.log('\n================================================================');
  console.log(`📊 TEST SUMMARY: ${passed} PASSED | ${failed} FAILED (TOTAL: ${passed + failed})`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runCompanyAuthAndSettingsTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
  });
}

module.exports = runCompanyAuthAndSettingsTests;
