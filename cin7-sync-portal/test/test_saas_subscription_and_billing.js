/**
 * VNC CIN7 SYNC — SAAS SUBSCRIPTION & BILLING TEST SUITE
 * Verifies SaaS plans, subscriptions, trial lifecycles, feature entitlements,
 * usage/seat limits, tenant isolation, and provider-neutral billing abstraction.
 */

const http = require('http');
const app = require('../src/server');
const subscriptionService = require('../src/services/subscriptionService');
const billingProviderService = require('../src/services/billingProviderService');
const cryptoService = require('../src/services/cryptoService');
const db = require('../src/db');

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
  console.log('💳 VNC SAAS SUBSCRIPTION & BILLING TEST SUITE');
  console.log('================================================================\n');

  // Start test server
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
    // Test 1: Seed / Existing Tenant Subscription Exists
    // -------------------------------------------------------------
    console.log('--- 1. Default Tenant Subscription & Hierarchy ---');
    let existingClient = await db.getOne('SELECT * FROM clients WHERE id = ?', ['client-vnc-master']);
    if (!existingClient) {
      await db.query(
        'INSERT INTO clients (id, company_name, created_at) VALUES (?, ?, ?)',
        ['client-vnc-master', 'VNC Master Organization', new Date().toISOString()]
      );
    }
    let masterSub = await subscriptionService.getOrganizationSubscription('client-vnc-master');
    if (!masterSub) {
      masterSub = await subscriptionService.createTrialSubscription('client-vnc-master', 'PROFESSIONAL', 30);
    }
    assert(masterSub !== null, 'Organization client-vnc-master has an existing subscription');
    assert(masterSub.plan_id.toLowerCase().includes('professional') || masterSub.plan?.code === 'PROFESSIONAL', 'Master organization is on PROFESSIONAL plan');
    assert(masterSub.status === 'ACTIVE' || masterSub.status === 'TRIAL' || masterSub.status === 'TRIALING', 'Master organization subscription status is ACTIVE, TRIAL, or TRIALING');

    // -------------------------------------------------------------
    // Test 2 & 3 & 4: User Registration, First User = ADMIN, Trial Creation
    // -------------------------------------------------------------
    console.log('\n--- 2. Organization Signup, Admin Assignment & Trial Creation ---');
    const testOrgEmail = `founder-${Date.now()}@acme-corp.com`;
    const regRes = await makeRequest('/api/auth/register', {
      method: 'POST',
      body: {
        fullName: 'Acme Founder',
        email: testOrgEmail,
        password: 'Password123!',
        companyName: 'Acme Corporation'
      }
    });

    assert(regRes.status === 200, 'New organization registered successfully');
    assert(regRes.data?.user?.role === 'ADMIN', 'First user created in new organization is assigned ADMIN role');
    assert(regRes.data?.client?.id?.startsWith('client-'), 'Organization has valid client_id tenant identifier');
    
    const acmeOrgId = regRes.data.client.id;
    const acmeCookie = regRes.cookie;

    const acmeSub = await subscriptionService.getOrganizationSubscription(acmeOrgId);
    assert(acmeSub !== null, 'Trial subscription was automatically created for new organization');
    assert(acmeSub.status === 'TRIALING' || acmeSub.status === 'ACTIVE', 'Subscription starts in TRIALING or ACTIVE state');
    assert(acmeSub.plan_id.toLowerCase().includes('professional') || acmeSub.plan_id.toLowerCase().includes('starter'), 'Assigned default plan on registration');

    // -------------------------------------------------------------
    // Test 5 & 6: Active vs Expired Subscription Enforcement
    // -------------------------------------------------------------
    console.log('\n--- 3. Active vs Expired Subscription Feature Enforcement ---');
    const activeCheck = await subscriptionService.isSubscriptionActive(acmeOrgId);
    assert(activeCheck === true, 'Trialing/Active subscription returns true for isSubscriptionActive');

    const canSync = await subscriptionService.hasFeature(acmeOrgId, 'cin7_sync');
    assert(canSync === true, 'Permitted cin7_sync feature is allowed for active organization');

    // Temporarily expire subscription to verify gate
    await db.query(`UPDATE subscriptions SET status = 'EXPIRED' WHERE organization_id = ?`, [acmeOrgId]);
    const expiredCheck = await subscriptionService.isSubscriptionActive(acmeOrgId);
    assert(expiredCheck === false, 'Expired subscription returns false for isSubscriptionActive');

    // Attempting protected sync endpoint when expired
    const expiredSyncRes = await makeRequest('/api/sync/sales', { method: 'POST' }, acmeCookie);
    assert(expiredSyncRes.status === 402 || expiredSyncRes.status === 403, 'Expired subscription blocks protected sync operation (402/403)');

    // Restore to ACTIVE for remaining tests
    await db.query(`UPDATE subscriptions SET status = 'ACTIVE' WHERE organization_id = ?`, [acmeOrgId]);

    // -------------------------------------------------------------
    // Test 7, 8, 9: RBAC on Billing Management
    // -------------------------------------------------------------
    console.log('\n--- 4. RBAC Permissions on Billing Management ---');
    
    // Login as Admin
    const adminBillRes = await makeRequest('/api/billing', {}, acmeCookie);
    assert(adminBillRes.status === 200, 'ADMIN is PERMITTED to access billing details');
    assert(adminBillRes.data.success === true, 'Admin receives subscription, plan, usage, and limits data');

    // Create Manager and Viewer users in acmeOrg
    const mgrPass = 'ManagerPass2026!#';
    const vwrPass = 'ViewerPass2026!#';
    await db.query(
      `INSERT INTO users (id, client_id, full_name, email, password_hash, role, platform_role, status, auth_provider, onboarding_status)
       VALUES (?, ?, ?, ?, ?, ?, 'USER', 'ACTIVE', 'local', 'completed')`,
      ['user-mgr-test', acmeOrgId, 'Test Manager', 'manager.test@vnc.test', cryptoService.hashPassword(mgrPass), 'MANAGER']
    );
    await db.query(
      `INSERT INTO users (id, client_id, full_name, email, password_hash, role, platform_role, status, auth_provider, onboarding_status)
       VALUES (?, ?, ?, ?, ?, ?, 'USER', 'ACTIVE', 'local', 'completed')`,
      ['user-vwr-test', acmeOrgId, 'Test Viewer', 'viewer.test@vnc.test', cryptoService.hashPassword(vwrPass), 'VIEWER']
    );

    const mgrLoginRes = await makeRequest('/api/auth/login', {
      method: 'POST',
      body: { email: 'manager.test@vnc.test', password: mgrPass }
    });
    const mgrCookie = mgrLoginRes.cookie;

    const vwrLoginRes = await makeRequest('/api/auth/login', {
      method: 'POST',
      body: { email: 'viewer.test@vnc.test', password: vwrPass }
    });
    const vwrCookie = vwrLoginRes.cookie;

    // Manager and Viewer attempting billing modification
    const mgrChangePlan = await makeRequest('/api/billing/change-plan', {
      method: 'POST',
      body: { planCode: 'ENTERPRISE' }
    }, mgrCookie);
    assert(mgrChangePlan.status === 403, 'MANAGER is FORBIDDEN from changing subscription plan (403)');

    const vwrChangePlan = await makeRequest('/api/billing/change-plan', {
      method: 'POST',
      body: { planCode: 'STARTER' }
    }, vwrCookie);
    assert(vwrChangePlan.status === 403, 'VIEWER is FORBIDDEN from changing subscription plan (403)');

    const vwrCancel = await makeRequest('/api/billing/cancel', { method: 'POST' }, vwrCookie);
    assert(vwrCancel.status === 403, 'VIEWER is FORBIDDEN from canceling subscription (403)');

    // -------------------------------------------------------------
    // Test 10: Feature Entitlements System
    // -------------------------------------------------------------
    console.log('\n--- 5. Centralized Feature Entitlements ---');
    // Change to STARTER plan
    await subscriptionService.changeOrganizationPlan(acmeOrgId, 'STARTER');
    const starterAdvReports = await subscriptionService.hasFeature(acmeOrgId, 'advanced_reports');
    assert(starterAdvReports === false, 'STARTER plan lacks advanced_reports feature');

    await subscriptionService.changeOrganizationPlan(acmeOrgId, 'PROFESSIONAL');
    const proAdvReports = await subscriptionService.hasFeature(acmeOrgId, 'advanced_reports');
    assert(proAdvReports === true, 'PROFESSIONAL plan includes advanced_reports feature');

    // -------------------------------------------------------------
    // Test 11 & 12: Usage and Seat Limit Enforcement
    // -------------------------------------------------------------
    console.log('\n--- 6. Usage & Seat Limit Checks ---');
    const maxUsersStarter = await subscriptionService.getLimit(acmeOrgId, 'max_users');
    assert(typeof maxUsersStarter === 'number' && maxUsersStarter > 0, 'getLimit returns numeric seat limit');

    // Switch to STARTER (seat limit = 1)
    await subscriptionService.changeOrganizationPlan(acmeOrgId, 'STARTER');
    
    // Attempt inviting a 2nd member on Starter plan (limit 1)
    const inviteRes = await makeRequest('/api/team/invite', {
      method: 'POST',
      body: {
        fullName: 'Second Member',
        email: 'member2@acme-corp.com',
        role: 'VIEWER'
      }
    }, acmeCookie);

    assert(inviteRes.status === 403, 'Inviting member beyond max_users limit is blocked (403 SEAT_LIMIT_REACHED)');
    assert(inviteRes.data.code === 'SEAT_LIMIT_REACHED' || inviteRes.data.message.includes('limit'), 'Error payload clearly cites seat limit');

    // -------------------------------------------------------------
    // Test 13 & 14: Tenant Isolation on Subscriptions & Billing
    // -------------------------------------------------------------
    console.log('\n--- 7. Strict Multi-Tenant Isolation on Billing ---');
    // Org Acme requests billing without sending any query param
    const billingAcme = await makeRequest('/api/billing', {}, acmeCookie);
    assert(billingAcme.data.subscription.organization_id === acmeOrgId, 'Billing endpoint derives tenant solely from server session');

    // Attempting cross-tenant tampering via body/query
    const crossTenantAttempt = await makeRequest(`/api/billing?organizationId=client-vnc-master`, {}, acmeCookie);
    assert(crossTenantAttempt.data.subscription.organization_id === acmeOrgId, 'Server-side session ignores attacker-supplied organizationId query parameter');

    // -------------------------------------------------------------
    // Test 15: Non-Destructive Data Retention after Cancellation
    // -------------------------------------------------------------
    console.log('\n--- 8. Data Retention after Cancellation ---');
    const cancelRes = await makeRequest('/api/billing/cancel', { method: 'POST' }, acmeCookie);
    assert(cancelRes.status === 200 && cancelRes.data.success === true, 'Admin can cancel subscription');

    const canceledSub = await subscriptionService.getOrganizationSubscription(acmeOrgId);
    assert(canceledSub.status === 'CANCELED', 'Subscription status transitioned to CANCELED');
    
    // Verify tenant organization still exists in database
    const orgCheck = await db.query('SELECT * FROM clients WHERE id = ?', [acmeOrgId]);
    assert(orgCheck.rows.length === 1, 'Organization database record is safely retained after cancellation');

    // -------------------------------------------------------------
    // Test 16, 17, 18: Provider-Neutral Billing Architecture & Webhook
    // -------------------------------------------------------------
    console.log('\n--- 9. Provider-Neutral Architecture & Webhook Safety ---');
    const availablePlans = await billingProviderService.getPlans();
    assert(Array.isArray(availablePlans) && availablePlans.length >= 3, 'Billing service returns configurable plan catalog (Starter, Pro, Enterprise)');

    const checkoutResult = await billingProviderService.createCheckoutSession(acmeOrgId, 'PROFESSIONAL');
    assert(checkoutResult.status === 'MOCK_CHECKOUT_READY' || checkoutResult.url, 'Provider-neutral checkout session interface works cleanly without real Stripe/Razorpay');

    // Verify webhook signature validation rejects fake unsigned events
    const fakeWebhook = await makeRequest('/api/billing/webhook', {
      method: 'POST',
      body: { eventType: 'payment_succeeded', organizationId: acmeOrgId }
    });
    assert(fakeWebhook.status === 400 || fakeWebhook.status === 401, 'Unsigned or unauthorized webhook payloads are rejected');

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
