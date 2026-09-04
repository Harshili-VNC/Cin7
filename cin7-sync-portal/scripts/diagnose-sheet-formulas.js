const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
require('dotenv').config();

async function diagnose() {
  const credPath = path.resolve('../cin7-sheets/oauth-credentials.json');
  const tokenPath = path.resolve('../cin7-sheets/token.json');
  const rawCreds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const config = rawCreds.installed || rawCreds.web;
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris[0]);
  oauth2Client.setCredentials(token);
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

  // Use the last generated spreadsheet from previous test
  const spreadsheetId = '18Hcax7XtgDyYi2nZI4vryE6OpErABGdwCAnVhMdLQ8o';

  console.log('====================================================');
  console.log('DIAGNOSING SPREADSHEET:', spreadsheetId);
  console.log('====================================================\n');

  // STEP 1: CHECK RAW DATA
  console.log('--- STEP 1: CHECK RAW DATA ---');
  const salesRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Sales Transactions Raw Data'!A7:Z400"
  });
  const invRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Inventory On Hand Raw Data'!A7:Z400"
  });
  const poRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Purchase Transactions Raw data'!A7:Z400"
  });

  const salesRows = salesRes.data.values || [];
  const invRows = invRes.data.values || [];
  const poRows = poRes.data.values || [];

  console.log(`Sales actual populated rows: ${salesRows.length}`);
  console.log(`Inventory actual populated rows: ${invRows.length}`);
  console.log(`Purchase actual populated rows: ${poRows.length}\n`);

  console.log('Sample Sales rows (first 3):');
  salesRows.slice(0, 3).forEach((r, i) => console.log(`[Sales ${i+1}]`, r.slice(0, 10)));

  console.log('\nSample Inventory rows (first 3):');
  invRows.slice(0, 3).forEach((r, i) => console.log(`[Inv ${i+1}]`, r.slice(0, 8)));

  console.log('\nSample PO rows (first 3):');
  poRows.slice(0, 3).forEach((r, i) => console.log(`[PO ${i+1}]`, r.slice(0, 8)));

  // STEP 2 & 3: INSPECT REPORTING / CALCULATION TABS & FORMULAS
  console.log('\n--- STEP 2 & 3: INSPECT REPORTING TABS & FORMULAS ---');
  const targetTabs = [
    'COGS & Profitability by Channel',
    'Product Margin Analysis',
    'KPI Dashboard',
    'Sales Dashboard'
  ];

  for (const tab of targetTabs) {
    try {
      // Get formulas
      const formulaRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${tab}'!A1:Z30`,
        valueRenderOption: 'FORMULA'
      });
      // Get formatted values
      const valueRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${tab}'!A1:Z30`,
        valueRenderOption: 'FORMATTED_VALUE'
      });

      const formulaGrid = formulaRes.data.values || [];
      const valueGrid = valueRes.data.values || [];

      console.log(`\n========================================`);
      console.log(`TAB: "${tab}"`);
      console.log(`========================================`);

      let formulasFound = 0;
      for (let r = 0; r < formulaGrid.length; r++) {
        const rowFormulas = formulaGrid[r] || [];
        const rowValues = valueGrid[r] || [];
        for (let c = 0; c < rowFormulas.length; c++) {
          const f = String(rowFormulas[c] || '');
          if (f.startsWith('=')) {
            formulasFound++;
            if (formulasFound <= 8) {
              const colLetter = String.fromCharCode(65 + c);
              const cellCoord = `${colLetter}${r+1}`;
              console.log(`Cell ${cellCoord}:`);
              console.log(`  Formula: ${f}`);
              console.log(`  Value:   ${rowValues[c]}`);
            }
          }
        }
      }
      console.log(`Total formulas found in top 30 rows: ${formulasFound}`);
    } catch(err) {
      console.log(`Error reading tab "${tab}":`, err.message);
    }
  }
}

diagnose().catch(console.error);
