const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const cin7Engine = require('../src/services/cin7Engine');

async function populateBothSheets() {
  const credPath = path.resolve('../cin7-sheets/oauth-credentials.json');
  const tokenPath = path.resolve('../cin7-sheets/token.json');
  const rawCreds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const config = rawCreds.installed || rawCreds.web;
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris[0]);
  oauth2Client.setCredentials(token);
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  const salesData = cin7Engine.getCanonicalSalesData();
  const invData = cin7Engine.getCanonicalInventoryData();
  const poData = cin7Engine.getCanonicalPurchaseOrdersData();

  const id1 = '1_FFOq0FtpzRJiJ_J1MML-vegL7OWCM1KwWnvLA1-enc';
  const id2 = '1yqzp596TBAQkppa5FuGXq76kuu9nFVk7WWf-kll3Ib0';

  const sheetsToSync = [id1, id2];

  for (const sheetId of sheetsToSync) {
    console.log(`\n========================================`);
    console.log(`Syncing Data to Sheet: ${sheetId}`);
    console.log(`========================================`);

    // Grant viewer permission to harshili.patni@vnc.global
    try {
      await drive.permissions.create({
        fileId: sheetId,
        sendNotificationEmail: false,
        requestBody: { role: 'reader', type: 'user', emailAddress: 'harshili.patni@vnc.global' }
      });
      console.log(`Viewer permission granted for ${sheetId}`);
    } catch (e) {
      console.log(`Viewer permission notice: ${e.message}`);
    }

    // Write Sales
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: "'Sales Transactions Raw Data'!A7",
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: salesData.rows }
    });
    console.log(`Injected ${salesData.rows.length} Sales rows into ${sheetId}`);

    // Write Inventory
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: "'Inventory On Hand Raw Data'!A7",
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: invData.rows }
    });
    console.log(`Injected ${invData.rows.length} Inventory rows into ${sheetId}`);

    // Write POs
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: "'Purchase Transactions Raw data'!A7",
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: poData.rows }
    });
    console.log(`Injected ${poData.rows.length} PO rows into ${sheetId}`);
  }

  console.log('\nAll sheets populated with 100% real Cin7 data successfully!');
}

populateBothSheets().catch(console.error);
