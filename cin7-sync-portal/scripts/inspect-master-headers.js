const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

async function inspectMasterHeaders() {
  const credPath = path.resolve('../cin7-sheets/oauth-credentials.json');
  const tokenPath = path.resolve('../cin7-sheets/token.json');
  const rawCreds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const config = rawCreds.installed || rawCreds.web;
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris[0]);
  oauth2Client.setCredentials(token);
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  const masterId = '1Qnx6RdCgI7krHtZru10J6r11ZpIkubCSR1jzUbs5G9Q';

  const sH = await sheets.spreadsheets.values.get({ spreadsheetId: masterId, range: "'Sales Transactions Raw Data'!A1:Z6" });
  const iH = await sheets.spreadsheets.values.get({ spreadsheetId: masterId, range: "'Inventory On Hand Raw Data'!A1:Z6" });
  const pH = await sheets.spreadsheets.values.get({ spreadsheetId: masterId, range: "'Purchase Transactions Raw data'!A1:Z6" });

  console.log('MASTER TEMPLATE SALES HEADERS (Row 6):');
  const sRow6 = sH.data.values ? sH.data.values[sH.data.values.length - 1] : [];
  sRow6.forEach((h, i) => console.log(`Col ${String.fromCharCode(65 + i)} (${i + 1}): "${h}"`));

  console.log('\nMASTER TEMPLATE INVENTORY HEADERS (Row 6):');
  const iRow6 = iH.data.values ? iH.data.values[iH.data.values.length - 1] : [];
  iRow6.forEach((h, i) => console.log(`Col ${String.fromCharCode(65 + i)} (${i + 1}): "${h}"`));

  console.log('\nMASTER TEMPLATE PO HEADERS (Row 6):');
  const pRow6 = pH.data.values ? pH.data.values[pH.data.values.length - 1] : [];
  pRow6.forEach((h, i) => console.log(`Col ${String.fromCharCode(65 + i)} (${i + 1}): "${h}"`));
}

inspectMasterHeaders().catch(console.error);
