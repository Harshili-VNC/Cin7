const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

async function listTabsWithOla() {
  const credPath = path.resolve('../cin7-sheets/oauth-credentials.json');
  const tokenPath = path.resolve('../cin7-sheets/token.json');
  const rawCreds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const config = rawCreds.installed || rawCreds.web;
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris[0]);
  oauth2Client.setCredentials(token);
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  const spreadsheetId = '1Qnx6RdCgI7krHtZru10J6r11ZpIkubCSR1jzUbs5G9Q';

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetTitles = meta.data.sheets.map(s => s.properties.title);

  for (const title of sheetTitles) {
    if (title.includes('Raw Data') || title.includes('Cover') || title.includes('Cost Inputs')) continue;
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${title}'!A1:Z100`,
        valueRenderOption: 'FORMULA'
      });
      const values = res.data.values || [];
      let found = 0;
      const matchingCells = [];
      values.forEach((r, rIdx) => r.forEach((c, cIdx) => {
        if (typeof c === 'string' && c.toLowerCase().includes('ola-mate')) {
          found++;
          matchingCells.push({ row: rIdx + 1, col: cIdx + 1, formula: c.slice(0, 80) });
        }
      }));
      if (found > 0) {
        console.log(`\n==============================================`);
        console.log(`[TAB WITH OLA-MATE] "${title}": ${found} occurrences`);
        console.log(`==============================================`);
        matchingCells.slice(0, 10).forEach(m => console.log(`  Row ${m.row}, Col ${m.col}: ${m.formula}`));
      } else {
        console.log(`[OK] "${title}": 0 occurrences`);
      }
    } catch (e) {
      console.log(`[ERROR] "${title}": ${e.message}`);
    }
  }
}
listTabsWithOla().catch(console.error);
