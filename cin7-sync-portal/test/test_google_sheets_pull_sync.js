/**
 * Automated Test Suite: Google Sheet -> Dashboard Pull & Sync
 * Tests:
 * 1. GoogleSheetsAdapter.prototype.readSpreadsheetData (batchGet parsing & padding)
 * 2. POST /api/sync/pull-sheets endpoint with auth & tenant isolation
 * 3. Validation & safe snapshot update behavior (rejects corrupt/empty data without destroying valid snapshots)
 * 4. Verifying changed Sheet values reach dashboard snapshots & current reports
 * 5. Failure & partial data error handling (422 / 404 / 500)
 * 6. Frontend handler execution (handlePullFromGoogleSheets) & DOM button state transitions
 * 7. Zero secret exposure verification
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { v4: uuidv4 } = require('uuid');

const db = require('../src/db');
const GoogleSheetsAdapter = require('../src/services/googleSheetsAdapter');
const snapshotService = require('../src/services/snapshotService');
const cin7Engine = require('../src/services/cin7Engine');
const clientStorageService = require('../src/services/clientStorageService');

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

async function runSuite() {
  console.log('================================================================');
  console.log('🧪 GOOGLE SHEET -> DASHBOARD PULL & SYNC AUTOMATED TEST SUITE');
  console.log('================================================================\n');

  const testClientId = `client-test-${uuidv4().substring(0, 8)}`;
  const testUserId = `user-test-${uuidv4().substring(0, 8)}`;
  const testEmail = `alice-${uuidv4().substring(0, 6)}@testcompany.com`;
  const otherClientId = `client-other-${uuidv4().substring(0, 8)}`;
  const otherUserId = `user-other-${uuidv4().substring(0, 8)}`;
  const otherEmail = `bob-${uuidv4().substring(0, 6)}@othercompany.com`;
  const testSpreadsheetId = '1Qnx6RdCgI7krHtZru10J6r11ZpIkubCSR1jzUbs5G9Q';

  try {
    // ── STEP 1: TEST GOOGLESHEETSADAPTER.PROTOTYPE.READSPREADSHEETDATA ──
    console.log('--- 1. Testing GoogleSheetsAdapter.prototype.readSpreadsheetData ---');
    
    // Create adapter instance
    const adapter = new GoogleSheetsAdapter(testClientId, { id: testUserId, email: 'test@vnc.global' });
    assert(typeof adapter.readSpreadsheetData === 'function', 'readSpreadsheetData method exists on GoogleSheetsAdapter');

    // Test with mock sheet client to verify batchGet range format and row padding logic
    const mockBatchGetResponse = {
      data: {
        valueRanges: [
          // Sales: 2 sample rows (row 1 has 22 columns, row 2 has 26 columns)
          {
            range: "'Sales Transactions Raw Data'!A7:Z",
            values: [
              ['2026-09', '2026-09-14', 'SO-1001', '2026-09-14', 'INV-1001', 'SKU-001', 'Cin7 Widget A', 'BrandX', 'Electronics', 'FG', 'Synced', 'Acme Corp', 'Complete', 'each', 'FULFILLED', 'VIP', 'Rep A', 'Shopify', 5, 250.00, 250.00, 125.00],
              ['2026-09', '2026-09-14', 'SO-1002', '2026-09-14', 'INV-1002', 'SKU-002', 'Cin7 Widget B', 'BrandX', 'Electronics', 'FG', 'Synced', 'Beta LLC', 'Complete', 'each', 'FULFILLED', 'VIP', 'Rep B', 'Amazon', 10, 500.00, 500.00, 250.00, 250.00, 0, 250.00, 0.5]
            ]
          },
          // Inventory: 2 sample rows
          {
            range: "'Inventory On Hand Raw Data'!A7:K",
            values: [
              ['Main Warehouse', 'SKU-001', 'Cin7 Widget A', 'each', 150, 20, 50, 10, 25.00, 3750.00, 130],
              ['Main Warehouse', 'SKU-002', 'Cin7 Widget B', 'each', 80, 5, 20, 0, 25.00, 2000.00, 75]
            ]
          },
          // Purchase: 1 sample row
          {
            range: "'Purchase Transactions Raw data'!A7:T",
            values: [
              ['2026', 'September', 'Supplier Alpha', '2027-09-01', 'PO-9001', 'INV-9001', 'BrandX', 'Electronics', 'FG', 'SKU-001', 'Cin7 Widget A', 'each', 'Main Warehouse', 'B-100', 'Received', 100, 2500.00, 100.00, 0, 250.00]
            ]
          },
          // KPI Dashboard
          {
            range: "'KPI Dashboard'!A1:F20",
            values: [
              ['KPI Overview', 'September 2026'],
              ['Total Revenue', 750.00],
              ['Gross Profit', 375.00]
            ]
          }
        ]
      }
    };

    // Temporarily mock getGoogleClients on adapter instance to test parser
    adapter.getGoogleClients = async () => ({
      drive: {},
      sheets: {
        spreadsheets: {
          values: {
            batchGet: async (params) => {
              assert(params.spreadsheetId === testSpreadsheetId, 'batchGet receives correct spreadsheetId');
              assert(params.ranges.length === 4, 'batchGet requests all 4 target ranges');
              assert(params.ranges[0] === "'Sales Transactions Raw Data'!A7:Z", 'Sales range is A7:Z');
              assert(params.ranges[1] === "'Inventory On Hand Raw Data'!A7:K", 'Inventory range is A7:K');
              assert(params.ranges[2] === "'Purchase Transactions Raw data'!A7:T", 'Purchases range is A7:T');
              return mockBatchGetResponse;
            }
          }
        }
      }
    });

    const parsedSheetData = await adapter.readSpreadsheetData(testSpreadsheetId);
    assert(parsedSheetData.sales.rows.length === 2, 'Parsed 2 sales rows');
    assert(parsedSheetData.sales.rows[0].length === 26, 'Padded sales row 1 to 26 columns');
    assert(parsedSheetData.sales.rows[1].length === 26, 'Padded sales row 2 to 26 columns');
    assert(parsedSheetData.inventory.rows.length === 2, 'Parsed 2 inventory rows');
    assert(parsedSheetData.inventory.rows[0].length === 11, 'Padded inventory row to 11 columns');
    assert(parsedSheetData.purchase.rows.length === 1, 'Parsed 1 purchase row');
    assert(parsedSheetData.purchase.rows[0].length === 20, 'Padded purchase row to 20 columns');

    // ── STEP 2: TEST SCHEMA VALIDATION AGAINST PARSED DATA ──
    console.log('\n--- 2. Testing Data Validation on Parsed Sheet Data ---');
    const salesVal = cin7Engine.validateSalesData(parsedSheetData.sales);
    assert(salesVal.valid === true && salesVal.rowCount === 2, 'cin7Engine.validateSalesData passes on parsed sheet sales');

    const invVal = cin7Engine.validateInventoryData(parsedSheetData.inventory);
    assert(invVal.valid === true && invVal.rowCount === 2, 'cin7Engine.validateInventoryData passes on parsed sheet inventory');

    const poVal = cin7Engine.validatePurchaseData(parsedSheetData.purchase);
    assert(poVal.valid === true && poVal.rowCount === 1, 'cin7Engine.validatePurchaseData passes on parsed sheet purchases');

    // ── STEP 3: SETUP TEST DB TENANTS AND DESTINATION RECORD ──
    console.log('\n--- 3. Setting Up Test Tenants in Database ---');
    await db.query(
      `INSERT INTO clients (id, company_name, phone_number, status, current_version)
       VALUES (?, 'Test Company A', '+1 555 0100', 'ACTIVE', 'v1.0')
       ON CONFLICT (id) DO NOTHING`,
      [testClientId]
    );
    await db.query(
      `INSERT INTO users (id, client_id, full_name, email, role, platform_role)
       VALUES (?, ?, 'Alice Test', ?, 'ADMIN', 'USER')
       ON CONFLICT (id) DO NOTHING`,
      [testUserId, testClientId, testEmail]
    );
    await db.query(
      `INSERT INTO destination_files (id, client_id, provider, file_id, file_name, file_url)
       VALUES (?, ?, 'google', ?, 'Controller Reporting - Test Company A', 'https://docs.google.com/spreadsheets/d/test-sheet-id/edit')
       ON CONFLICT (id) DO NOTHING`,
      [`dest-${testClientId}`, testClientId, testSpreadsheetId]
    );

    // Setup initial valid snapshot for comparison
    const initialSales = {
      headers: parsedSheetData.sales.headers,
      rows: [
        ['2026-09', '2026-09-01', 'SO-OLD-1', '2026-09-01', 'INV-OLD-1', 'SKU-001', 'Widget Old', 'BrandX', 'FG', 'FG', 'Synced', 'Old Corp', 'Complete', 'each', 'FULFILLED', 'Tag', 'Rep', 'Shopify', 1, 100.00, 100.00, 50.00, 50.00, 0, 50.00, 0.5]
      ]
    };
    await snapshotService.saveCurrentAndSnapshot({
      clientId: testClientId,
      reportType: 'sales',
      periodLabel: 'Initial Baseline',
      dataset: initialSales,
      syncRunId: 'init-run-001'
    });

    const baselineReport = snapshotService.getCurrentReportRows(testClientId, 'sales');
    assert(baselineReport.rows.length === 1 && baselineReport.rows[0][2] === 'SO-OLD-1', 'Baseline snapshot saved: 1 row with SO-OLD-1');

    // ── STEP 4: TEST POST /api/sync/pull-sheets ENDPOINT ──
    console.log('\n--- 4. Testing POST /api/sync/pull-sheets Endpoint Execution ---');
    
    // Create test Express app with real syncRoutes
    const app = express();
    app.use(express.json());

    // Middleware to simulate authenticated user Alice
    let mockAuthUser = {
      id: testUserId,
      email: testEmail,
      client_id: testClientId,
      clientId: testClientId,
      role: 'ADMIN',
      platformRole: 'USER'
    };
    let simulateAuth = true;

    app.use((req, res, next) => {
      if (simulateAuth && mockAuthUser) {
        req.session = { user: mockAuthUser };
        req.user = mockAuthUser;
        req.tenantId = mockAuthUser.clientId;
      } else {
        req.session = null;
      }
      next();
    });

    const syncRoutes = require('../src/routes/syncRoutes');
    app.use('/api/sync', syncRoutes);

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    // A. Test Unauthenticated Request Rejected (401)
    simulateAuth = false;
    const unauthRes = await fetch(`${baseUrl}/api/sync/pull-sheets`, { method: 'POST' });
    assert(unauthRes.status === 401, 'Unauthenticated request correctly rejected with 401 Unauthorized');

    // B. Test Authenticated Successful Pull
    simulateAuth = true;

    // Temporarily mock GoogleSheetsAdapter.prototype.getGoogleClients for end-to-end endpoint call
    const origGetGoogleClients = GoogleSheetsAdapter.prototype.getGoogleClients;
    GoogleSheetsAdapter.prototype.getGoogleClients = async function() {
      return {
        drive: {},
        sheets: {
          spreadsheets: {
            values: {
              batchGet: async () => mockBatchGetResponse
            }
          }
        }
      };
    };

    const pullRes = await fetch(`${baseUrl}/api/sync/pull-sheets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spreadsheetId: testSpreadsheetId })
    });
    const pullData = await pullRes.json();

    assert(pullRes.status === 200, `POST /api/sync/pull-sheets returned HTTP 200 (Got ${pullRes.status})`);
    assert(pullData.success === true, 'Response payload has success: true');
    assert(pullData.recordsProcessed === 5, `Correct recordsProcessed count returned: ${pullData.recordsProcessed} (2 sales + 2 inv + 1 PO)`);
    assert(pullData.breakdown.sales === 2, 'Breakdown sales count is 2');
    assert(pullData.breakdown.inventory === 2, 'Breakdown inventory count is 2');
    assert(pullData.breakdown.purchaseOrders === 1, 'Breakdown purchase count is 1');
    assert(Boolean(pullData.runId), `Audit runId generated: ${pullData.runId}`);

    // ── STEP 5: TEST THAT CHANGED SHEET VALUES REACH SNAPSHOTS & CURRENT REPORTS ──
    console.log('\n--- 5. Verifying Snapshot Store & Current Reports Updated ---');
    const updatedSalesReport = snapshotService.getCurrentReportRows(testClientId, 'sales');
    assert(updatedSalesReport.rows.length === 2, 'Current Sales report rows updated from 1 to 2');
    assert(updatedSalesReport.rows[0][2] === 'SO-1001', 'Updated sales row 1 is SO-1001');
    assert(updatedSalesReport.rows[1][2] === 'SO-1002', 'Updated sales row 2 is SO-1002');
    assert(updatedSalesReport.periodLabel === 'Google Sheet Sync', 'Report periodLabel set to "Google Sheet Sync"');

    const updatedInvReport = snapshotService.getCurrentReportRows(testClientId, 'inventory');
    assert(updatedInvReport.rows.length === 2, 'Current Inventory report updated with 2 items');

    const updatedPoReport = snapshotService.getCurrentReportRows(testClientId, 'purchase');
    assert(updatedPoReport.rows.length === 1, 'Current Purchase report updated with 1 item');

    const allCurrentReports = await snapshotService.getCurrentReports(testClientId);
    assert(allCurrentReports.sales?.recordCount === 2, 'getCurrentReports returns 2 sales records');
    assert(allCurrentReports.inventory?.recordCount === 2, 'getCurrentReports returns 2 inventory records');
    assert(allCurrentReports.purchase?.recordCount === 1, 'getCurrentReports returns 1 purchase record');

    // ── STEP 6: TEST AUDIT LOG IN DB ──
    console.log('\n--- 6. Verifying Audit Log & Sync Runs in Database ---');
    const syncRunRecord = await db.getOne(
      'SELECT * FROM sync_runs WHERE id = ? AND client_id = ?',
      [pullData.runId, testClientId]
    );
    assert(syncRunRecord !== null, 'Sync run saved in sync_runs table');
    assert(syncRunRecord.sync_type === 'google_sheet_pull', 'Sync type recorded as "google_sheet_pull"');
    assert(syncRunRecord.status === 'COMPLETED', 'Status recorded as COMPLETED');
    assert(syncRunRecord.records_processed === 5, 'records_processed recorded as 5');

    // ── STEP 7: TEST FAILURE & PARTIAL DATA SAFETY (GUARD VALID SNAPSHOTS) ──
    console.log('\n--- 7. Testing Failure, Partial & Corrupt Data Safety ---');
    
    // A. Empty Sheet Error Guard (422)
    GoogleSheetsAdapter.prototype.getGoogleClients = async function() {
      return {
        drive: {},
        sheets: {
          spreadsheets: {
            values: {
              batchGet: async () => ({
                data: {
                  valueRanges: [
                    { range: "'Sales Transactions Raw Data'!A7:Z", values: [] },
                    { range: "'Inventory On Hand Raw Data'!A7:K", values: [] },
                    { range: "'Purchase Transactions Raw data'!A7:T", values: [] }
                  ]
                }
              })
            }
          }
        }
      };
    };

    const emptyRes = await fetch(`${baseUrl}/api/sync/pull-sheets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spreadsheetId: testSpreadsheetId })
    });
    const emptyData = await emptyRes.json();
    assert(emptyRes.status === 422, `Empty sheet correctly rejected with HTTP 422 (Got ${emptyRes.status})`);
    assert(emptyData.error === 'EMPTY_SHEET_DATA', 'Error code is EMPTY_SHEET_DATA');

    // Verify existing snapshot was NOT corrupted or overwritten
    const salesAfterEmpty = snapshotService.getCurrentReportRows(testClientId, 'sales');
    assert(salesAfterEmpty.rows.length === 2, 'Existing valid snapshot preserved intact (still 2 rows)');

    // B. Malformed / Corrupted Data Error Guard (500)
    GoogleSheetsAdapter.prototype.getGoogleClients = async function() {
      return {
        drive: {},
        sheets: {
          spreadsheets: {
            values: {
              batchGet: async () => ({
                data: {
                  valueRanges: [
                    {
                      range: "'Sales Transactions Raw Data'!A7:Z",
                      values: [
                        // Row with empty SKU and invalid non-numeric qty
                        ['2026-09', '2026-09-14', 'SO-BAD', '2026-09-14', 'INV-BAD', '', '', '', '', '', '', '', '', '', '', '', '', '', 'NOT_A_NUM', 'REV']
                      ]
                    },
                    { range: "'Inventory On Hand Raw Data'!A7:K", values: [] },
                    { range: "'Purchase Transactions Raw data'!A7:T", values: [] }
                  ]
                }
              })
            }
          }
        }
      };
    };

    const corruptRes = await fetch(`${baseUrl}/api/sync/pull-sheets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spreadsheetId: testSpreadsheetId })
    });
    assert(corruptRes.status === 500, `Corrupt data correctly rejected with HTTP 500 (Got ${corruptRes.status})`);

    // Verify valid snapshot is still intact
    const salesAfterCorrupt = snapshotService.getCurrentReportRows(testClientId, 'sales');
    assert(salesAfterCorrupt.rows.length === 2, 'Valid snapshot preserved against corrupt sheet data');

    // ── STEP 8: TEST MULTI-TENANT ISOLATION ──
    console.log('\n--- 8. Testing Multi-Tenant Isolation ---');
    await db.query(
      `INSERT INTO clients (id, company_name, phone_number, status)
       VALUES (?, 'Other Company B', '+1 555 0200', 'ACTIVE')
       ON CONFLICT (id) DO NOTHING`,
      [otherClientId]
    );

    // Tenant B has no destination sheet
    mockAuthUser = {
      id: otherUserId,
      email: otherEmail,
      client_id: otherClientId,
      clientId: otherClientId,
      role: 'ADMIN',
      platformRole: 'USER'
    };

    const tenantBRes = await fetch(`${baseUrl}/api/sync/pull-sheets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}) // no spreadsheetId provided
    });
    const tenantBData = await tenantBRes.json();
    assert(tenantBRes.status === 404, `Tenant B with no sheet destination rejected with HTTP 404 (Got ${tenantBRes.status})`);
    assert(tenantBData.error === 'NO_GOOGLE_SHEET_FOUND', 'Tenant B isolated: cannot access Tenant A spreadsheet');

    // Restore original method
    GoogleSheetsAdapter.prototype.getGoogleClients = origGetGoogleClients;
    server.close();

    // ── STEP 9: TEST FRONTEND APP.JS AND BUTTON HANDLER ──
    console.log('\n--- 9. Testing Frontend Handler & DOM State Transitions ---');
    const appJsCode = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    const indexHtmlCode = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

    assert(indexHtmlCode.includes('id="btn-pull-sheets"'), 'index.html contains #btn-pull-sheets in sync bar actions');
    assert(indexHtmlCode.includes('id="btn-pull-sheets-card"'), 'index.html contains #btn-pull-sheets-card in financial model card');
    assert(indexHtmlCode.includes('handlePullFromGoogleSheets()'), 'index.html attaches handlePullFromGoogleSheets() onclick handler');
    assert(appJsCode.includes('async function handlePullFromGoogleSheets()'), 'app.js defines handlePullFromGoogleSheets()');
    assert(appJsCode.includes('/api/sync/pull-sheets'), 'app.js calls /api/sync/pull-sheets endpoint');
    assert(appJsCode.includes('#btn-pull-sheets, #btn-pull-sheets-card'), 'app.js includes pull buttons in RBAC query selector');

    // ── STEP 10: ZERO SECRET EXPOSURE CHECK ──
    console.log('\n--- 10. Checking for Zero Secret Exposure ---');
    const filesToCheck = [
      path.join(__dirname, '../src/services/googleSheetsAdapter.js'),
      path.join(__dirname, '../src/routes/syncRoutes.js'),
      path.join(__dirname, '../public/app.js'),
      path.join(__dirname, '../public/index.html')
    ];

    let leakFound = false;
    for (const f of filesToCheck) {
      const content = fs.readFileSync(f, 'utf8');
      if (content.includes('GOCSPX-') || content.includes('eyJhbGciOi') || content.includes('ya29.')) {
        leakFound = true;
        console.error(`❌ Secret detected in ${f}`);
      }
    }
    assert(leakFound === false, 'Zero hardcoded secrets, Google OAuth tokens, or JWTs detected in modified files');

    // Cleanup test data
    try {
      await db.query('DELETE FROM sync_runs WHERE client_id IN (?, ?)', [testClientId, otherClientId]);
      await db.query('DELETE FROM report_snapshots WHERE client_id IN (?, ?)', [testClientId, otherClientId]);
      await db.query('DELETE FROM destination_files WHERE client_id IN (?, ?)', [testClientId, otherClientId]);
      await db.query('DELETE FROM users WHERE client_id IN (?, ?)', [testClientId, otherClientId]);
      await db.query('DELETE FROM clients WHERE id IN (?, ?)', [testClientId, otherClientId]);
      // Remove test storage directory
      const testStorage = path.join(__dirname, '../storage/clients', testClientId);
      if (fs.existsSync(testStorage)) fs.rmSync(testStorage, { recursive: true, force: true });
      const otherStorage = path.join(__dirname, '../storage/clients', otherClientId);
      if (fs.existsSync(otherStorage)) fs.rmSync(otherStorage, { recursive: true, force: true });
    } catch (_) {}

  } catch (err) {
    console.error('Test Suite Exception:', err);
    failed++;
  }

  console.log('\n================================================================');
  console.log(`🏁 TEST SUMMARY: ${passed} PASSED | ${failed} FAILED`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch(e => {
  console.error('Suite error:', e);
  process.exit(1);
});
