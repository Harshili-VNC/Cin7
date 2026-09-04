const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

async function checkCols() {
  const credPath = path.resolve('../cin7-sheets/oauth-credentials.json');
  const tokenPath = path.resolve('../cin7-sheets/token.json');
  const rawCreds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const config = rawCreds.installed || rawCreds.web;
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris[0]);
  oauth2Client.setCredentials(token);
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  const spreadsheetId = '18Hcax7XtgDyYi2nZI4vryE6OpErABGdwCAnVhMdLQ8o';

  // Check headers on row 6
  const hRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Sales Transactions Raw Data'!A6:Z6"
  });
  console.log('HEADERS ROW 6:');
  (hRes.data.values[0] || []).forEach((h, i) => {
    console.log(`Col ${String.fromCharCode(65 + i)} (${i + 1}): ${h}`);
  });

  // Check unique values in Column G, Column S, Column J
  const dataRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Sales Transactions Raw Data'!A7:Z400"
  });
  const rows = dataRes.data.values || [];
  const colG = new Set();
  const colS = new Set();
  const colJ = new Set();
  rows.forEach(r => {
    if (r[6]) colG.add(r[6]); // G is index 6
    if (r[18]) colS.add(r[18]); // S is index 18
    if (r[9]) colJ.add(r[9]); // J is index 9
  });
  console.log('\nUnique values in Col G (Product Name / SKU):', Array.from(colG).slice(0, 15));
  console.log('Unique values in Col S (Sales Channel):', Array.from(colS));
  console.log('Unique values in Col J (Family / Category):', Array.from(colJ));

  // Also check column A of "COGS & Profitability by Channel"
  const cogsRows = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'COGS & Profitability by Channel'!A1:B25"
  });
  console.log('\nCOGS & Profitability by Channel (First 15 rows of Col A and Col B):');
  cogsRows.data.values?.slice(0, 15).forEach((r, idx) => console.log(`Row ${idx+1}: [${r[0]}] | [${r[1]}]`));
}
checkCols().catch(console.error);
