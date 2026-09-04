const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

async function inspectCogsSheet() {
  const credPath = path.resolve('../cin7-sheets/oauth-credentials.json');
  const tokenPath = path.resolve('../cin7-sheets/token.json');
  const rawCreds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const config = rawCreds.installed || rawCreds.web;
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris[0]);
  oauth2Client.setCredentials(token);
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  const masterId = '1Qnx6RdCgI7krHtZru10J6r11ZpIkubCSR1jzUbs5G9Q';

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: masterId,
    range: "'COGS & Profitability by Channel'!A4:M18",
    valueRenderOption: 'FORMULA'
  });

  console.log('COGS & Profitability by Channel rows 4-18:');
  (res.data.values || []).forEach((row, i) => {
    console.log(`\n--- Row ${i + 4} (Label: "${row[0]}") ---`);
    console.log(`Col B (Amazon): ${row[1]}`);
    console.log(`Col C (Amazon-US): ${row[2]}`);
    console.log(`Col D (Shopify Web): ${row[3]}`);
  });
}
inspectCogsSheet().catch(console.error);
