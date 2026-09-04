const assert = require('assert');
const http = require('http');

async function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: body
        });
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function runGoogleAuthTests() {
  console.log('--- Testing Google OAuth Flow & Ticket Exchange ---');

  // 1. Test /api/auth/google/start redirects to accounts.google.com
  const startRes = await makeRequest({
    hostname: 'localhost',
    port: 2005,
    path: '/api/auth/google/start',
    method: 'GET'
  });

  assert.strictEqual(startRes.statusCode, 302, 'Expected 302 redirect from /api/auth/google/start');
  assert(startRes.headers.location.includes('accounts.google.com'), 'Expected redirect to accounts.google.com');
  console.log('✅ [PASS] /api/auth/google/start properly redirects to Google OAuth endpoint');

  // 2. Test invalid ticket consumption returns error redirect
  const invalidTicketRes = await makeRequest({
    hostname: 'localhost',
    port: 2005,
    path: '/api/auth/google/consume-ticket?ticket=non_existent_fake_ticket',
    method: 'GET'
  });

  assert.strictEqual(invalidTicketRes.statusCode, 302, 'Expected 302 redirect from invalid ticket');
  assert(invalidTicketRes.headers.location.includes('google_auth=error'), 'Expected error query in redirect');
  console.log('✅ [PASS] Invalid / expired tickets are safely rejected');

  console.log('\n=====================================================================');
  console.log('🎉 ALL GOOGLE AUTH FLOW TESTS PASSED');
  console.log('=====================================================================');
}

runGoogleAuthTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
