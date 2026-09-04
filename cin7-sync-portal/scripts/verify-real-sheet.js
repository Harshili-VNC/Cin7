const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

async function readRealData() {
  const credPath = path.resolve('../cin7-sheets/oauth-credentials.json');
  const tokenPath = path.resolve('../cin7-sheets/token.json');
  const rawCreds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const config = rawCreds.installed || rawCreds.web;
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris[0]);
  oauth2Client.setCredentials(token);
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

  const id = '1yqzp596TBAQkppa5FuGXq76kuu9nFVk7WWf-kll3Ib0';

  const s = await sheets.spreadsheets.values.get({
    spreadsheetId: id,
    range: "'Sales Transactions Raw Data'!A7:M8"
  });
  console.log('REAL SALES ROW 7:');
  console.log(s.data.values[0]);

  const inv = await sheets.spreadsheets.values.get({
    spreadsheetId: id,
    range: "'Inventory On Hand Raw Data'!A7:E8"
  });
  console.log('\nREAL INVENTORY ROW 7:');
  console.log(inv.data.values[0]);

  const po = await sheets.spreadsheets.values.get({
    spreadsheetId: id,
    range: "'Purchase Transactions Raw data'!A7:F8"
  });
  console.log('\nREAL PO ROW 7:');
  console.log(po.data.values[0]);
}

readRealData().catch(console.error);
