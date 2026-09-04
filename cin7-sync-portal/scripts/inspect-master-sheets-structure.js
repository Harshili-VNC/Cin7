const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

async function inspectAllReportingSheets() {
  const credPath = path.resolve('../cin7-sheets/oauth-credentials.json');
  const tokenPath = path.resolve('../cin7-sheets/token.json');
  const rawCreds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const config = rawCreds.installed || rawCreds.web;
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris[0]);
  oauth2Client.setCredentials(token);
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  const masterId = '1Qnx6RdCgI7krHtZru10J6r11ZpIkubCSR1jzUbs5G9Q';

  const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId: masterId });
  const allTabs = sheetMeta.data.sheets.map(s => s.properties.title);
  console.log('ALL TABS IN MASTER TEMPLATE:', allTabs);

  for (const tab of allTabs) {
    if (tab.includes('Raw Data') || tab.includes('Raw data') || tab.includes('Cover')) continue;
    
    console.log(`\n======================================================`);
    console.log(`TAB: "${tab}"`);
    console.log(`======================================================`);

    const resFormulas = await sheets.spreadsheets.values.get({
      spreadsheetId: masterId,
      range: `'${tab}'!A1:N25`,
      valueRenderOption: 'FORMULA'
    });

    const resValues = await sheets.spreadsheets.values.get({
      spreadsheetId: masterId,
      range: `'${tab}'!A1:N25`,
      valueRenderOption: 'FORMATTED_VALUE'
    });

    const fRows = resFormulas.data.values || [];
    const vRows = resValues.data.values || [];

    for (let r = 0; r < Math.min(fRows.length, 25); r++) {
      const rowF = fRows[r] || [];
      const rowV = vRows[r] || [];
      const label = rowV[0] || '';
      const formulasInRow = rowF.map((cell, c) => ({ col: String.fromCharCode(65+c), f: cell, v: rowV[c] })).filter(item => String(item.f).startsWith('='));
      if (label || formulasInRow.length > 0) {
        console.log(`Row ${r+1}: [Col A: "${label}"]`);
        if (formulasInRow.length > 0) {
          console.log(`   Formulas (${formulasInRow.length}):`, formulasInRow.slice(0, 4));
        }
      }
    }
  }
}

inspectAllReportingSheets().catch(console.error);
