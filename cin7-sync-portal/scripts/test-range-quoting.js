const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
require('dotenv').config();

async function testRangeQuoting() {
  const credPath = path.resolve('../cin7-sheets/oauth-credentials.json');
  const tokenPath = path.resolve('../cin7-sheets/token.json');
  const rawCreds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const config = rawCreds.installed || rawCreds.web;
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris[0]);
  oauth2Client.setCredentials(token);

  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

  const masterId = process.env.GoogleMasterTemp || '1dc6swegTyminEZJ_sI9NO6_cLg2BYjxrjkjdvitF04k';
  console.log('1. Cloning master template...');
  const copyRes = await drive.files.copy({
    fileId: masterId,
    requestBody: { name: 'Test_Quoting_Sheet' }
  });
  const fileId = copyRes.data.id;
  console.log('Cloned fileId:', fileId);

  const testValues = [['Test 1', 'Test 2', 'Test 3']];
  
  const unquotedRange = 'Sales Transactions Raw Data!A7';
  console.log('\nTesting unquoted range:', unquotedRange);
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: fileId,
      range: unquotedRange,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: testValues }
    });
    console.log('✅ SUCCESS UNQUOTED');
  } catch (err) {
    console.error('❌ FAILED UNQUOTED:', err.message);
  }

  const quotedRange = "'Sales Transactions Raw Data'!A7";
  console.log('\nTesting quoted range:', quotedRange);
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: fileId,
      range: quotedRange,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: testValues }
    });
    console.log('✅ SUCCESS QUOTED');
  } catch (err) {
    console.error('❌ FAILED QUOTED:', err.message);
  }

  // Read back
  console.log('\nReading back from quoted range...');
  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId: fileId,
    range: "'Sales Transactions Raw Data'!A7:C7"
  });
  console.log('Read back values:', readRes.data.values);
}

testRangeQuoting().catch(console.error);
