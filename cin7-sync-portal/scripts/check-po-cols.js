const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

async function checkPoCols() {
  const credPath = path.resolve('../cin7-sheets/oauth-credentials.json');
  const tokenPath = path.resolve('../cin7-sheets/token.json');
  const rawCreds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const config = rawCreds.installed || rawCreds.web;
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris[0]);
  oauth2Client.setCredentials(token);
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  const spreadsheetId = '1Qnx6RdCgI7krHtZru10J6r11ZpIkubCSR1jzUbs5G9Q';

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Purchase Transactions Raw data'!A6:T6"
  });

  console.log('Purchase Transactions Raw data Headers (Row 6):');
  res.data.values?.[0]?.forEach((h, i) => {
    const colLetter = String.fromCharCode(65 + i);
    console.log(`Col ${colLetter} (index ${i}): "${h}"`);
  });
}

checkPoCols().catch(console.error);
