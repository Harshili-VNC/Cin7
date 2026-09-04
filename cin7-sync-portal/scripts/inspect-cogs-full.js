const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

async function inspectCogsFull() {
  const credPath = path.resolve('../cin7-sheets/oauth-credentials.json');
  const tokenPath = path.resolve('../cin7-sheets/token.json');
  const rawCreds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const config = rawCreds.installed || rawCreds.web;
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris[0]);
  oauth2Client.setCredentials(token);
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  const masterId = '1Qnx6RdCgI7krHtZru10J6r11ZpIkubCSR1jzUbs5G9Q';

  const resF = await sheets.spreadsheets.values.get({
    spreadsheetId: masterId,
    range: "'COGS & Profitability by Channel'!A1:M45",
    valueRenderOption: 'FORMULA'
  });

  const resV = await sheets.spreadsheets.values.get({
    spreadsheetId: masterId,
    range: "'COGS & Profitability by Channel'!A1:M45",
    valueRenderOption: 'FORMATTED_VALUE'
  });

  const fRows = resF.data.values || [];
  const vRows = resV.data.values || [];

  for (let r = 0; r < fRows.length; r++) {
    console.log(`\nRow ${r+1}: [A: "${vRows[r]?.[0] || ''}"]`);
    for (let c = 1; c < (fRows[r] || []).length; c++) {
      const colLetter = String.fromCharCode(65 + c);
      const val = vRows[r]?.[c];
      const form = fRows[r]?.[c];
      if (form && String(form).startsWith('=')) {
        console.log(`   Col ${colLetter}: ${form} => ${val}`);
      } else if (val) {
        console.log(`   Col ${colLetter}: "${val}"`);
      }
    }
  }
}

inspectCogsFull().catch(console.error);
