const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

async function checkSheets() {
  const credPath = path.resolve('../cin7-sheets/oauth-credentials.json');
  const tokenPath = path.resolve('../cin7-sheets/token.json');
  const rawCreds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const config = rawCreds.installed || rawCreds.web;
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris[0]);
  oauth2Client.setCredentials(token);
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

  const id1 = '1_FFOq0FtpzRJiJ_J1MML-vegL7OWCM1KwWnvLA1-enc';
  const id2 = '1yqzp596TBAQkppa5FuGXq76kuu9nFVk7WWf-kll3Ib0';

  for (const id of [id1, id2]) {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: id,
        range: "'Sales Transactions Raw Data'!A7:F8"
      });
      console.log('ID:', id, 'Rows found:', res.data.values ? res.data.values.length : 0);
      if (res.data.values) console.log('Data:', res.data.values[0]);
    } catch(e) {
      console.log('ID:', id, 'ERROR:', e.message);
    }
  }
}
checkSheets();
