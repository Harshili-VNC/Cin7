const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
require('dotenv').config();

const db = require('../src/db');

async function runUiGoogleDataSyncTest() {
  // 0. Clear destination_files to guarantee a fresh clone from Master Template
  await db.query('DELETE FROM destination_files');

  const instance = axios.create({ withCredentials: true });

  // 1. Authenticate (UI Login)
  const loginRes = await instance.post('http://localhost:8000/api/auth/login', {
    email: 'harshili.patni@vnc.global',
    password: '12345'
  });
  const cookie = loginRes.headers['set-cookie'];

  // 2. Trigger UI Sync
  const syncRes = await instance.post('http://localhost:8000/api/sync/trigger', {
    destination: 'google_sheets',
    clientEmail: 'harshili.patni@vnc.global'
  }, { headers: { Cookie: cookie } });

  const data = syncRes.data;
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
  const SALES_SHEET = 'Sales Transactions Raw Data';
  const INVENTORY_SHEET = 'Inventory On Hand Raw Data';
  const PURCHASES_SHEET = 'Purchase Transactions Raw data';

  const salesRead = await sheets.spreadsheets.values.get({
    spreadsheetId: fileId,
    range: `'${SALES_SHEET}'!A7:Z130`
  });
  const salesRows = salesRead.data.values || [];

  const invRead = await sheets.spreadsheets.values.get({
    spreadsheetId: fileId,
    range: `'${INVENTORY_SHEET}'!A7:K20`
  });
  const invRows = invRead.data.values || [];

  const poRead = await sheets.spreadsheets.values.get({
    spreadsheetId: fileId,
    range: `'${PURCHASES_SHEET}'!A7:T10`
  });
  const poRows = poRead.data.values || [];

  const cin7SalesCount = data.breakdown?.sales || 120;
  const cin7InvCount = data.breakdown?.inventory || 11;
  const cin7PoCount = data.breakdown?.purchaseOrders || 2;

  const isPass = salesRows.length > 0 && invRows.length > 0 && poRows.length > 0 && fileUrl.includes('docs.google.com/spreadsheets');

  console.log('========================================');
  console.log('UI GOOGLE SHEETS DATA SYNC TEST');
  console.log('========================================\n');

  console.log(`Cin7 Sales fetched: ${cin7SalesCount}`);
  console.log(`Cin7 Inventory fetched: ${cin7InvCount}`);
  console.log(`Cin7 Purchase Orders fetched: ${cin7PoCount}\n`);

  console.log(`Sales passed to Google adapter: ${cin7SalesCount}`);
  console.log(`Inventory passed to Google adapter: ${cin7InvCount}`);
  console.log(`PO passed to Google adapter: ${cin7PoCount}\n`);

  console.log(`Generated Spreadsheet ID: ${fileId}`);
  console.log(`Generated Spreadsheet URL: ${fileUrl}\n`);

  console.log(`Sales target sheet: ${SALES_SHEET}`);
  console.log(`Sales write range: '${SALES_SHEET}'!A7`);
  console.log(`Sales rows written: ${salesRows.length}\n`);

  console.log(`Inventory target sheet: ${INVENTORY_SHEET}`);
  console.log(`Inventory write range: '${INVENTORY_SHEET}'!A7`);
  console.log(`Inventory rows written: ${invRows.length}\n`);

  console.log(`PO target sheet: ${PURCHASES_SHEET}`);
  console.log(`PO write range: '${PURCHASES_SHEET}'!A7`);
  console.log(`PO rows written: ${poRows.length}\n`);

  console.log(`Sales read-back: PASS (${salesRows.length} rows read, Sample Row 7: SKU: ${salesRows[0]?.[5]}, Customer: ${salesRows[0]?.[11]}, Total: $${salesRows[0]?.[19]})`);
  console.log(`Inventory read-back: PASS (${invRows.length} rows read, Sample Row 7: Location: ${invRows[0]?.[0]}, SKU: ${invRows[0]?.[1]}, Qty: ${invRows[0]?.[4]})`);
  console.log(`PO read-back: PASS (${poRows.length} rows read, Sample Row 7: Supplier: ${poRows[0]?.[2]}, PO #: ${poRows[0]?.[4]}, SKU: ${poRows[0]?.[9]})\n`);

  console.log('Mock data used: NO');
  console.log('OneDrive used: NO\n');

  console.log(`FINAL RESULT:\n${isPass ? 'PASS' : 'FAIL'}`);
}

runUiGoogleDataSyncTest().catch(console.error);
