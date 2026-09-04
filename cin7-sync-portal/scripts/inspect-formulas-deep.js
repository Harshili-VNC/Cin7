const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

async function inspectFormulasInDepth() {
  const credPath = path.resolve('../cin7-sheets/oauth-credentials.json');
  const tokenPath = path.resolve('../cin7-sheets/token.json');
  const rawCreds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const config = rawCreds.installed || rawCreds.web;
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris[0]);
  oauth2Client.setCredentials(token);
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  const masterId = '1Qnx6RdCgI7krHtZru10J6r11ZpIkubCSR1jzUbs5G9Q';

  const tabsToCheck = [
    'COGS & Profitability by Channel',
    'Product Margin Analysis',
    'Weekly Order Tracker',
    'Sales Trend Analysis',
    'Inventory & MOS Analysis'
  ];

  for (const tab of tabsToCheck) {
    console.log(`\n======================================================`);
    console.log(`ANALYZING TAB: "${tab}"`);
    console.log(`======================================================`);

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: masterId,
      range: `'${tab}'!A1:N40`,
      valueRenderOption: 'FORMULA'
    });

    const rows = res.data.values || [];
    let samples = 0;
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < (rows[r] || []).length; c++) {
        const val = String(rows[r][c] || '');
        if (val.startsWith('=')) {
          samples++;
          if (samples <= 10) {
            console.log(`Cell ${String.fromCharCode(65+c)}${r+1}: ${val}`);
          }
        }
      }
    }
    console.log(`Total formulas found in range A1:N40: ${samples}`);
  }
}

inspectFormulasInDepth().catch(console.error);
