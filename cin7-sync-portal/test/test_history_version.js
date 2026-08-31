const db = require('../src/db');
const { v4: uuidv4 } = require('uuid');

async function testHistoricalVersionLookup() {
  console.log('🧪 Testing Historical Sync Record Lookup...');

  const clientId = `test-client-${uuidv4().substring(0, 6)}`;
  const runId = `run-sales-${uuidv4().substring(0, 6)}`;

  // Insert a test sync run into memory store
  await db.query(
    `INSERT INTO sync_runs (id, client_id, user_id, run_id, sync_type, status, destination_provider, destination_file_id, destination_file_name)
     VALUES (?, ?, ?, ?, 'sales', 'COMPLETED', 'microsoft', 'ms-test-123', 'Test.xlsx')`,
    [runId, clientId, 'user-1', runId]
  );

  // Query using historyId AND clientId
  const queryResult = await db.query(
    'SELECT * FROM sync_runs WHERE (id = ? OR run_id = ?) AND client_id = ?',
    [runId, runId, clientId]
  );

  if (queryResult.rows && queryResult.rows.length > 0) {
    console.log('✅ [PASS] Found historical sync run record:', queryResult.rows[0].id);
  } else {
    console.error('❌ [FAIL] Record not found!');
    process.exit(1);
  }
}

testHistoricalVersionLookup();
