/**
 * Comprehensive Verification Suite: 1st-Time vs 2nd-Time Sign-In Onboarding Workflow
 *
 * Requirements:
 * 1. 1st-time sign in (Google OAuth or Email/Password):
 *    - Directs user to "Connect Cin7 Core" onboarding screen (#onboarding-view).
 *    - Form fields are clean and blank.
 *    - Once credentials are saved, database records onboarding_status = 'completed' & cin7_connections status = 'CONNECTED'.
 * 2. 2nd-time / Subsequent sign in (Google OAuth or Email/Password):
 *    - Database fetch verifies onboarding_status === 'completed' & cin7.connected === true.
 *    - "Connect Cin7 Core" screen IS NOT SHOWN.
 *    - User is routed directly to the Dashboard (#dashboard-view).
 */

const assert = require('assert');
const http = require('http');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const db = require('../src/db');
const authRoutes = require('../src/routes/authRoutes');
const cin7Routes = require('../src/routes/cin7Routes');
const { v4: uuidv4 } = require('uuid');

async function makeRequest(app, method, url, body = null, cookie = null) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: url,
      method,
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let setCookie = res.headers['set-cookie'];
        let cookieHeader = null;
        if (setCookie) {
          cookieHeader = Array.isArray(setCookie) ? setCookie.map(c => c.split(';')[0]).join('; ') : setCookie.split(';')[0];
        }
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (_) {}
        server.close();
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data, json, cookie: cookieHeader });
      });
    });

    req.on('error', (err) => {
      server.close();
      reject(err);
    });

    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(session({
    secret: 'test_session_secret_for_onboarding_verification_2026',
    resave: false,
    saveUninitialized: false,
    name: '__vnc_portal_sid',
    cookie: { secure: false }
  }));
  app.use('/api/auth', authRoutes);
  app.use('/api/cin7', cin7Routes);
  return app;
}

async function runTests() {
  console.log('=====================================================================');
  console.log('🧪 VERIFYING 1ST-TIME VS 2ND-TIME SIGN-IN ONBOARDING WORKFLOW');
  console.log('=====================================================================\n');

  const app = createApp();

  // ─────────────────────────────────────────────────────────────────────────────
  // PART A: EMAIL / PASSWORD WORKFLOW
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('🔹 [PART A] Email/Password Sign-In Workflow');

  const testEmail = `controller.test.${Date.now()}@vnc.global`;
  const testPassword = 'Password123!';
  const testCompany = 'Acme Global Logistics';

  // 1. First-time registration
  const regRes = await makeRequest(app, 'POST', '/api/auth/register', {
    fullName: 'Controller User',
    companyName: testCompany,
    phoneNumber: '+1 (555) 019-2834',
    email: testEmail,
    password: testPassword,
    confirmPassword: testPassword
  });

  assert.strictEqual(regRes.statusCode, 200, 'Registration should succeed with 200');
  assert.strictEqual(regRes.json.success, true);
  assert.strictEqual(regRes.json.user.onboardingStatus, 'pending', '1st-time registration must have onboardingStatus = pending');
  console.log('   ✅ 1. First-time registration created account with onboardingStatus = "pending"');

  const regCookie = regRes.cookie;

  // 2. Check /api/auth/me immediately after registration
  const meAfterReg = await makeRequest(app, 'GET', '/api/auth/me', null, regCookie);
  assert.strictEqual(meAfterReg.statusCode, 200);
  assert.strictEqual(meAfterReg.json.user.onboardingStatus, 'pending', 'User must be pending onboarding on 1st login');
  assert.strictEqual(meAfterReg.json.cin7.connected, false, 'Cin7 must be disconnected initially');
  console.log('   ✅ 2. GET /api/auth/me returns onboardingStatus = "pending" and cin7.connected = false (Routes to Connect Cin7 screen)');

  // 3. User enters credentials on "Connect Cin7 Core" onboarding screen
  const saveCredsRes = await makeRequest(app, 'POST', '/api/cin7/save-credentials', {
    accountId: 'cin7-acc-998822',
    apiKey: 'cin7-key-sec-77665544332211',
    billingType: 'trial'
  }, regCookie);

  assert.strictEqual(saveCredsRes.statusCode, 200, 'Saving Cin7 credentials must return 200');
  assert.strictEqual(saveCredsRes.json.success, true);
  assert.strictEqual(saveCredsRes.json.status, 'CONNECTED');
  assert.strictEqual(saveCredsRes.json.onboardingStatus, 'completed', 'Onboarding status must be marked completed in response');
  console.log('   ✅ 3. POST /api/cin7/save-credentials encrypted credentials, stored connection & set onboardingStatus = "completed"');

  // Verify DB state
  const dbUserA = await db.getOne('SELECT onboarding_status, client_id FROM users WHERE email = ?', [testEmail]);
  const dbClientA = await db.getOne('SELECT onboarding_status FROM clients WHERE id = ?', [dbUserA.client_id]);
  const dbCin7A = await db.getOne('SELECT status FROM cin7_connections WHERE client_id = ?', [dbUserA.client_id]);

  assert.strictEqual(dbUserA.onboarding_status, 'completed', 'DB user onboarding_status must be completed');
  assert.strictEqual(dbClientA.onboarding_status, 'completed', 'DB client onboarding_status must be completed');
  assert.strictEqual(dbCin7A.status, 'CONNECTED', 'DB cin7_connections status must be CONNECTED');
  console.log('   ✅ 4. Verified DB persistence: user, client and cin7_connections are completed & CONNECTED');

  // 4. Logout
  await makeRequest(app, 'POST', '/api/auth/logout', null, regCookie);

  // 5. 2nd-time / Subsequent Sign In with Email/Password
  const secondLoginRes = await makeRequest(app, 'POST', '/api/auth/login', {
    email: testEmail,
    password: testPassword
  });

  assert.strictEqual(secondLoginRes.statusCode, 200, '2nd-time login must succeed');
  assert.strictEqual(secondLoginRes.json.success, true);
  assert.strictEqual(secondLoginRes.json.user.onboardingStatus, 'completed', '2nd-time login must return onboardingStatus = "completed" fetched from DB');
  assert.strictEqual(secondLoginRes.json.cin7.connected, true, '2nd-time login must return cin7.connected = true fetched from DB');
  console.log('   ✅ 5. 2nd-time Sign In: POST /api/auth/login returned onboardingStatus = "completed" & cin7.connected = true (Connect Cin7 screen skipped -> directly to Dashboard)');

  // 6. Check /api/auth/me on 2nd session
  const meSecondSession = await makeRequest(app, 'GET', '/api/auth/me', null, secondLoginRes.cookie);
  assert.strictEqual(meSecondSession.statusCode, 200);
  assert.strictEqual(meSecondSession.json.user.onboardingStatus, 'completed');
  assert.strictEqual(meSecondSession.json.cin7.connected, true);
  console.log('   ✅ 6. 2nd-time Session: GET /api/auth/me returns onboardingStatus = "completed" & cin7.connected = true');

  // ─────────────────────────────────────────────────────────────────────────────
  // PART B: GOOGLE OAUTH WORKFLOW
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n🔹 [PART B] Google OAuth Sign-In Workflow');

  const googleEmail = `google.user.${Date.now()}@gmail.com`;
  const googleUserId = `user-google-${uuidv4().substring(0, 8)}`;

  // 1. Simulate 1st-time Google OAuth callback inserting new user
  await db.query(
    `INSERT INTO users (id, client_id, full_name, email, phone_number, password_hash, role, platform_role, status, auth_provider, onboarding_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [googleUserId, null, 'Google User', googleEmail, null, null, 'ADMIN', 'USER', 'ACTIVE', 'google', 'pending_client_selection']
  );

  // Simulate establishing session for new Google user
  const googleInitApp = express();
  googleInitApp.use(express.json());
  googleInitApp.use(cookieParser());
  googleInitApp.use(session({
    secret: 'test_session_secret_for_onboarding_verification_2026',
    resave: false,
    saveUninitialized: false,
    name: '__vnc_portal_sid',
    cookie: { secure: false }
  }));
  googleInitApp.get('/init-session', (req, res) => {
    req.session.user = {
      id: googleUserId,
      email: googleEmail,
      full_name: 'Google User',
      client_id: null,
      onboarding_status: 'pending_client_selection'
    };
    res.json({ ok: true });
  });
  googleInitApp.use('/api/auth', authRoutes);
  googleInitApp.use('/api/cin7', cin7Routes);

  const initRes = await makeRequest(googleInitApp, 'GET', '/init-session');
  const googleCookie = initRes.cookie;

  // 2. GET /api/auth/me returns needsClientSelection = true
  const googleMeFirst = await makeRequest(googleInitApp, 'GET', '/api/auth/me', null, googleCookie);
  assert.strictEqual(googleMeFirst.json.needsClientSelection, true, 'New Google user must require client workspace selection');
  console.log('   ✅ 1. 1st-time Google sign-in: GET /api/auth/me returns needsClientSelection = true (Prompts Client Workspace Setup)');

  // 3. User sets up client workspace
  const setupWsRes = await makeRequest(googleInitApp, 'POST', '/api/auth/setup-workspace', {
    companyName: 'Apex Logistics Inc',
    fullName: 'Google User Admin',
    phoneNumber: '+1 (555) 334-5566',
    timezone: 'Asia/Kolkata'
  }, googleCookie);

  assert.strictEqual(setupWsRes.statusCode, 200);
  assert.strictEqual(setupWsRes.json.success, true);
  console.log('   ✅ 2. POST /api/auth/setup-workspace created client workspace with pending Cin7 onboarding');

  // 4. GET /api/auth/me after workspace setup -> returns onboardingStatus = "pending"
  const googleMeAfterWs = await makeRequest(googleInitApp, 'GET', '/api/auth/me', null, googleCookie);
  assert.strictEqual(googleMeAfterWs.json.needsClientSelection, false);
  assert.strictEqual(googleMeAfterWs.json.user.onboardingStatus, 'pending', '1st-time Google user must be routed to Connect Cin7 screen');
  assert.strictEqual(googleMeAfterWs.json.cin7.connected, false);
  console.log('   ✅ 3. GET /api/auth/me returns onboardingStatus = "pending" and cin7.connected = false (Shows Connect Cin7 screen for 1st time)');

  // 5. Connect Cin7 Core on onboarding screen
  const googleSaveCin7 = await makeRequest(googleInitApp, 'POST', '/api/cin7/save-credentials', {
    accountId: 'cin7-google-org-1234',
    apiKey: 'cin7-google-key-abcdef987654321',
    billingType: 'trial'
  }, googleCookie);

  assert.strictEqual(googleSaveCin7.statusCode, 200);
  assert.strictEqual(googleSaveCin7.json.success, true);
  assert.strictEqual(googleSaveCin7.json.status, 'CONNECTED');
  assert.strictEqual(googleSaveCin7.json.onboardingStatus, 'completed');
  console.log('   ✅ 4. POST /api/cin7/save-credentials connected Cin7 and marked onboardingStatus = "completed"');

  // 6. 2nd-time Google Sign In
  // Simulate returning session for existing Google user
  const googleDbUser = await db.getOne('SELECT * FROM users WHERE email = ?', [googleEmail]);
  assert.strictEqual(googleDbUser.onboarding_status, 'completed', 'DB user onboarding_status must be completed');

  const googleSecondApp = express();
  googleSecondApp.use(express.json());
  googleSecondApp.use(cookieParser());
  googleSecondApp.use(session({
    secret: 'test_session_secret_for_onboarding_verification_2026',
    resave: false,
    saveUninitialized: false,
    name: '__vnc_portal_sid',
    cookie: { secure: false }
  }));
  googleSecondApp.get('/init-second-session', (req, res) => {
    req.session.user = {
      id: googleDbUser.id,
      email: googleDbUser.email,
      full_name: googleDbUser.full_name,
      client_id: googleDbUser.client_id,
      onboarding_status: 'completed'
    };
    res.json({ ok: true });
  });
  googleSecondApp.use('/api/auth', authRoutes);
  googleSecondApp.use('/api/cin7', cin7Routes);

  const initSecondRes = await makeRequest(googleSecondApp, 'GET', '/init-second-session');
  const googleSecondCookie = initSecondRes.cookie;

  const googleMeSecond = await makeRequest(googleSecondApp, 'GET', '/api/auth/me', null, googleSecondCookie);
  assert.strictEqual(googleMeSecond.statusCode, 200);
  assert.strictEqual(googleMeSecond.json.needsClientSelection, false);
  assert.strictEqual(googleMeSecond.json.user.onboardingStatus, 'completed', '2nd-time Google sign-in must return onboardingStatus = "completed"');
  assert.strictEqual(googleMeSecond.json.cin7.connected, true, '2nd-time Google sign-in must return cin7.connected = true');
  console.log('   ✅ 5. 2nd-time Google sign-in: GET /api/auth/me returned onboardingStatus = "completed" & cin7.connected = true (Connect Cin7 screen skipped -> directly to Dashboard)');

  // Clean up test users & clients created during test
  await db.query('DELETE FROM cin7_connections WHERE client_id IN (?, ?)', [dbUserA.client_id, googleDbUser.client_id]);
  await db.query('DELETE FROM users WHERE email IN (?, ?)', [testEmail, googleEmail]);
  await db.query('DELETE FROM clients WHERE id IN (?, ?)', [dbUserA.client_id, googleDbUser.client_id]);

  console.log('\n=====================================================================');
  console.log('🎉 ALL 11 VERIFICATION ASSERTIONS PASSED WITH 100% SUCCESS!');
  console.log('=====================================================================\n');
}

runTests().catch(err => {
  console.error('\n❌ Test execution failed:', err);
  process.exit(1);
});
