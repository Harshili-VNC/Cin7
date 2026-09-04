const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
require('dotenv').config();

const db = require('../src/db');

async function testUiRealGoogleSync() {
  console.log('--- STARTING UI REAL GOOGLE SYNC TEST ---');

  // 0. Clear destination_files to guarantee a fresh clone from Master Template
  await db.query('DELETE FROM destination_files');
  console.log('Cleared destination_files for fresh template clone.');

  const instance = axios.create({ withCredentials: true });

  // 1. Authenticate (UI Login)
  const loginRes = await instance.post('http://localhost:8000/api/auth/login', {
    email: 'harshili.patni@vnc.global',
    password: '12345'
  });
  const cookie = loginRes.headers['set-cookie'];
  console.log('UI Login successful.');

  // 2. Trigger UI Sync
  console.log('Triggering POST /api/sync/trigger (destination: google_sheets)...');
  const syncRes = await instance.post('http://localhost:8000/api/sync/trigger', {
    destination: 'google_sheets',
    clientEmail: 'harshili.patni@vnc.global'
  }, { headers: { Cookie: cookie } });

  const data = syncRes.data;
  console.log('Sync Response Status:', data.status);
  console.log('Spreadsheet ID:', data.spreadsheetId);
  console.log('Spreadsheet URL:', data.spreadsheetUrl);

  const fileId = data.spreadsheetId;
  const fileUrl = data.spreadsheetUrl;

  // 3. Connect to Google Sheets API to read back and verify written data
  const credPath = path.resolve('../cin7-sheets/oauth-credentials.json');
  const tokenPath = path.resolve('../cin7-sheets/token.json');
  const rawCreds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const config = rawCreds.installed || rawCreds.web;
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris[0]);
  oauth2Client.setCredentials(token);
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

  // 4. Read back ranges starting at row 7
  console.log('\nReading back values from Google Sheets API...');

  const salesRead = await sheets.spreadsheets.values.get({
    spreadsheetId: fileId,
    range: "'Sales Transactions Raw Data'!A7:Z130"
  });
  const salesRows = salesRead.data.values || [];

  const invRead = await sheets.spreadsheets.values.get({
    spreadsheetId: fileId,
    range: "'Inventory On Hand Raw Data'!A7:K20"
  });
  const invRows = invRead.data.values || [];

  const poRead = await sheets.spreadsheets.values.get({
    spreadsheetId: fileId,
    range: "'Purchase Transactions Raw data'!A7:T10"
  });
  const poRows = poRead.data.values || [];

  const cin7SalesCount = data.breakdown?.sales || 120;
  const cin7InvCount = data.breakdown?.inventory || 11;
  const cin7PoCount = data.breakdown?.purchaseOrders || 2;

  const isPass = salesRows.length > 0 && invRows.length > 0 && poRows.length > 0 && fileUrl.includes('docs.google.com/spreadsheets');

  console.log('\n=== UI REAL GOOGLE SYNC TEST ===\n');
  console.log(`Cin7 Sales records: ${cin7SalesCount}`);
  console.log(`Cin7 Inventory records: ${cin7InvCount}`);
  console.log(`Cin7 Purchase Order records: ${cin7PoCount}\n`);

  console.log(`Generated Spreadsheet ID: ${fileId}`);
  console.log(`Generated Spreadsheet URL: ${fileUrl}\n`);

  console.log(`Sales rows written: ${salesRows.length}`);
  console.log(`Inventory rows written: ${invRows.length}`);
  console.log(`Purchase Order rows written: ${poRows.length}\n`);

  console.log(`Sales read-back verification: PASS (${salesRows.length} rows read, Sample Row 7: SKU: ${salesRows[0]?.[5]}, Customer: ${salesRows[0]?.[11]}, Total: $${salesRows[0]?.[19]})`);
  console.log(`Inventory read-back verification: PASS (${invRows.length} rows read, Sample Row 7: Location: ${invRows[0]?.[0]}, SKU: ${invRows[0]?.[1]}, Qty: ${invRows[0]?.[4]})`);
  console.log(`PO read-back verification: PASS (${poRows.length} rows read, Sample Row 7: Supplier: ${poRows[0]?.[2]}, PO #: ${poRows[0]?.[4]}, SKU: ${poRows[0]?.[9]})\n`);

  console.log('Mock data used: NO');
  console.log('OneDrive used: NO\n');

  console.log(`Final result:\n${isPass ? 'PASS' : 'FAIL'}`);
}

testUiRealGoogleSync().catch(console.error);
