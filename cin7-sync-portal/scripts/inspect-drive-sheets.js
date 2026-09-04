const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

async function inspectFiles() {
  const credentials = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../cin7-sheets/oauth-credentials.json'), 'utf8'));
  const config = credentials.installed || credentials.web || credentials;
  const tokens = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../cin7-sheets/token.json'), 'utf8'));

  const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, 'http://localhost');
  oauth2Client.setCredentials(tokens);

  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  const targetId = '1Qnx6RdCgI7krHtZru10J6r11ZpIkubCSR1jzUbs5G9Q';
  try {
    const file = await drive.files.get({
      fileId: targetId,
      fields: 'id, name, mimeType'
    });
    console.log('TARGET_FILE_INFO:', JSON.stringify(file.data));
  } catch(e) {
    console.log('TARGET_ERROR:', e.message);
  }

  try {
    const list = await drive.files.list({
      q: "mimeType = 'application/vnd.google-apps.spreadsheet'",
      fields: 'files(id, name, mimeType, createdTime, modifiedTime)',
      pageSize: 10
    });
    console.log('RECENT_SPREADSHEETS:', JSON.stringify(list.data.files, null, 2));
  } catch(e) {
    console.log('LIST_ERROR:', e.message);
  }
}

inspectFiles().catch(console.error);
