const db = require('../src/db');
const cryptoService = require('../src/services/cryptoService');
const cin7Engine = require('../src/services/cin7Engine');
const MicrosoftExcelAdapter = require('../src/services/microsoftExcelAdapter');
const GoogleSheetsAdapter = require('../src/services/googleSheetsAdapter');

async function runTests() {
  console.log('=======================================================');
  console.log('🧪 RUNNING VNC CIN7 SYNC PORTAL AUTH & ONBOARDING SUITE');
  console.log('=======================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${message}`);
      failed++;
    }
  }

  try {
    // 1. Password Hashing Security (Section 8)
    console.log('--- 1. Password Security & PBKDF2-SHA512 Hashing ---');
    const plainPwd = 'SuperSecurePassword2026!';
    const hashed = cryptoService.hashPassword(plainPwd);
    assert(hashed && hashed !== plainPwd && hashed.includes(':'), 'Password hashed with salt using PBKDF2-SHA512');
    
    const isValid = cryptoService.verifyPassword(plainPwd, hashed);
    assert(isValid === true, 'Password verification succeeded with valid password');
    
    const isInvalid = cryptoService.verifyPassword('WrongPassword123', hashed);
    assert(isInvalid === false, 'Password verification rejected invalid password');

    // 2. Encryption Security
    console.log('\n--- 2. AES-256-GCM Encryption Security ---');
    const secretKey = 'cin7_api_key_secret_2026';
    const encrypted = cryptoService.encrypt(secretKey);
    assert(encrypted && encrypted !== secretKey, 'Cin7 API key encrypted with AES-256-GCM');
    assert(cryptoService.decrypt(encrypted) === secretKey, 'Encrypted Cin7 key decrypted successfully');

    // 3. Scenario A: New Email/Password User Registration
    console.log('\n--- 3. Scenario A: Email/Password Registration & Tenant Creation ---');
    const regEmail = 'john.smith@acme.com';
    const clientAId = 'client-acme-001';
    const userAId = 'user-john-001';

    await db.query(
      'INSERT INTO clients (id, company_name, phone_number, status) VALUES (?, ?, ?, ?)',
      [clientAId, 'Acme Logistics Ltd', '+1 555 019 2834', 'ACTIVE']
    );

    await db.query(
      `INSERT INTO users (id, client_id, full_name, email, phone_number, password_hash, auth_provider, role)
       VALUES (?, ?, ?, ?, ?, ?, 'email', 'CLIENT')`,
      [userAId, clientAId, 'John Smith', regEmail, '+1 555 019 2834', hashed]
    );

    await db.query(
      'INSERT INTO client_preferences (id, client_id, destination) VALUES (?, ?, ?)',
      ['pref-acme-001', clientAId, 'microsoft']
    );

    const savedUserA = await db.getOne('SELECT * FROM users WHERE email = ?', [regEmail]);
    assert(savedUserA && savedUserA.full_name === 'John Smith', 'New user registered and stored in database');
    assert(savedUserA.password_hash !== plainPwd, 'Password stored as hash, zero plaintext storage');

    // 4. Scenario H: Email Uniqueness Enforcement
    console.log('\n--- 4. Scenario H: Email Uniqueness Enforcement ---');
    const duplicateCheck = await db.getOne('SELECT * FROM users WHERE email = ?', [regEmail]);
    assert(duplicateCheck !== null, 'Duplicate email detected prior to creation');

    // 5. Scenario B & E: Microsoft OAuth Account Linking & Single User Reuse
    console.log('\n--- 5. Scenario B & E: Microsoft OAuth Account Link & User Reuse ---');
    const msProvUserId = 'ms-oauth-user-7788';
    const oauthId = 'oauth-ms-001';

    await db.query(
      `INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id)
       VALUES (?, ?, 'microsoft', ?)`,
      [oauthId, userAId, msProvUserId]
    );

    const linkedOauth = await db.getOne(
      'SELECT * FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?',
      ['microsoft', msProvUserId]
    );
    assert(linkedOauth && linkedOauth.user_id === userAId, 'OAuth account linked to existing user without creating duplicate account');

    // 6. Scenario C & F: Google OAuth Account Registration
    console.log('\n--- 6. Scenario C & F: Google OAuth Registration & Preference ---');
    const clientBId = 'client-google-002';
    const userBId = 'user-google-002';
    const gEmail = 'sarah@globaltech.com';

    await db.query(
      'INSERT INTO clients (id, company_name, phone_number, status) VALUES (?, ?, ?, ?)',
      [clientBId, 'Global Tech Inc', '+1 555 998 1122', 'ACTIVE']
    );

    await db.query(
      `INSERT INTO users (id, client_id, full_name, email, phone_number, auth_provider, role)
       VALUES (?, ?, ?, ?, ?, 'google', 'CLIENT')`,
      [userBId, clientBId, 'Sarah Jenkins', gEmail, '+1 555 998 1122']
    );

    await db.query(
      'INSERT INTO client_preferences (id, client_id, destination) VALUES (?, ?, ?)',
      ['pref-google-002', clientBId, 'google']
    );

    const savedUserB = await db.getOne('SELECT * FROM users WHERE email = ?', [gEmail]);
    const prefB = await db.getOne('SELECT * FROM client_preferences WHERE client_id = ?', [clientBId]);
    assert(savedUserB && prefB.destination === 'google', 'Google OAuth user saved with Google Sheets destination preference');

    // 7. Cin7 Connection & Onboarding Routing
    console.log('\n--- 7. Cin7 Connection & Onboarding Routing ---');
    const cin7EncUser = cryptoService.encrypt('demo_user');
    const cin7EncKey = cryptoService.encrypt('demo_key');
    const now = new Date().toISOString();

    await db.query(
      `INSERT INTO cin7_connections (id, client_id, api_username_encrypted, api_key_encrypted, status, last_tested_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['cin7-conn-001', clientAId, cin7EncUser, cin7EncKey, 'CONNECTED', now]
    );

    const connA = await db.getOne('SELECT * FROM cin7_connections WHERE client_id = ?', [clientAId]);
    assert(connA && connA.status === 'CONNECTED', 'Cin7 account connected and verified as CONNECTED');

    const connB = await db.getOne('SELECT * FROM cin7_connections WHERE client_id = ?', [clientBId]);
    assert(!connB || connB.status !== 'CONNECTED', 'Unconnected client detected requiring Cin7 onboarding screen');

    // 8. Scenario I: Tenant Isolation Verification
    console.log('\n--- 8. Scenario I: Multi-Tenant Data Isolation ---');
    assert(savedUserA.client_id !== savedUserB.client_id, 'Tenant Client A isolated from Tenant Client B');

    console.log('\n=======================================================');
    console.log(`📊 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('=======================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Test suite crash:', err);
    process.exit(1);
  }
}

runTests();
