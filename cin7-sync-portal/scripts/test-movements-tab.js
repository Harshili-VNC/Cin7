const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

async function testMovementsSync() {
  console.log('Triggering fresh Sync...');
  const res = await axios.post('http://localhost:8000/api/sync/trigger', {
    clientId: 'client-vnc-master',
    destination: 'google_sheets'
  });
  console.log('Sync Success:', res.data.success);
  console.log('Spreadsheet ID:', res.data.spreadsheetId);
  console.log('Spreadsheet URL:', res.data.spreadsheetUrl);
  const spreadsheetId = res.data.spreadsheetId;

  const credPath = path.resolve('../cin7-sheets/oauth-credentials.json');
  const tokenPath = path.resolve('../cin7-sheets/token.json');
  const rawCreds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const config = rawCreds.installed || rawCreds.web;
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris[0]);
  oauth2Client.setCredentials(token);
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

  const moveRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Inventory Movements'!A4:H20",
    valueRenderOption: 'FORMATTED_VALUE'
  });

  console.log('\n==============================================');
  console.log('INVENTORY MOVEMENTS IN NEW SHEET:');
  console.log('==============================================');
  moveRes.data.values?.forEach((r, i) => {
    console.log(`Row ${i+4}: [${r.map(c => `"${c}"`).join(', ')}]`);
  });

  const mosRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Inventory & MOS Analysis'!A4:K12",
    valueRenderOption: 'FORMATTED_VALUE'
  });

  console.log('\n==============================================');
  console.log('INVENTORY & MOS ANALYSIS IN NEW SHEET:');
  console.log('==============================================');
  mosRes.data.values?.forEach((r, i) => {
    console.log(`Row ${i+4}: [${r.map(c => `"${c}"`).join(', ')}]`);
  });
}

testMovementsSync().catch(console.error);
