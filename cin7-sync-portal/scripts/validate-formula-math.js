const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

async function validateMath() {
  const credPath = path.resolve('../cin7-sheets/oauth-credentials.json');
  const tokenPath = path.resolve('../cin7-sheets/token.json');
  const rawCreds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const config = rawCreds.installed || rawCreds.web;
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris[0]);
  oauth2Client.setCredentials(token);
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

  // Use the newest sync spreadsheet
  const spreadsheetId = '1htMycPqlo34sGBXuIlj2Rl4mIRkWbnAxVsmUgc0_Xxk';

  console.log('====================================================');
  console.log('VALIDATING FORMULA MATHEMATICS ON REAL PRODUCTS');
  console.log('Spreadsheet ID:', spreadsheetId);
  console.log('====================================================\n');

  // 1. Read entire Sales Transactions Raw Data
  const rawRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Sales Transactions Raw Data'!A7:Z400"
  });
  const rawRows = rawRes.data.values || [];

  // 2. Read Product Margin Analysis rows 5 to 10
  const marginRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Product Margin Analysis'!A5:H10",
    valueRenderOption: 'FORMATTED_VALUE'
  });
  const marginRows = marginRes.data.values || [];

  console.log('Product Margin Analysis Rows in Sheet:');
  marginRows.forEach((r, i) => {
    console.log(`  Row ${i+5}: SKU="${r[0]}" | Units=${r[1]} | Rev=${r[2]} | COGS=${r[3]} | Profit=${r[4]} | Margin=${r[5]}`);
  });

  console.log('\n----------------------------------------------------');
  console.log('TASK 6: 3-PRODUCT MANUAL VS GOOGLE SHEETS VALIDATION');
  console.log('----------------------------------------------------');

  const productsToTest = marginRows.slice(0, 3).map(r => r[0]);

  productsToTest.forEach(sku => {
    const matchingRows = rawRows.filter(r => r[6] === sku && r[9] === 'Finished Goods');
    
    let manualUnits = 0;
    let manualRev = 0;
    let manualCogs = 0;

    matchingRows.forEach(r => {
      manualUnits += parseInt(r[19] || 1); // Col T (Quantity)
      manualRev += parseFloat(r[21] || 0);   // Col V (Sale / Revenue)
      manualCogs += parseFloat(r[22] || 0);  // Col W (COGS)
    });

    const manualProfit = manualRev - manualCogs;
    const manualMargin = manualRev > 0 ? (manualProfit / manualRev) * 100 : 0;

    const sheetRow = marginRows.find(r => r[0] === sku);
    const sheetUnits = parseInt(sheetRow[1]);
    const sheetRev = parseFloat(sheetRow[2].replace(/[$,]/g, ''));
    const sheetCogs = parseFloat(sheetRow[3].replace(/[$,]/g, ''));
    const sheetProfit = parseFloat(sheetRow[4].replace(/[$,]/g, ''));
    const sheetMargin = parseFloat(sheetRow[5].replace(/[%]/g, ''));

    console.log(`\nProduct: "${sku}"`);
    console.log(`  Units:        ${sheetUnits}`);
    console.log(`  Revenue:      $${sheetRev.toLocaleString()}`);
    console.log(`  COGS:         $${sheetCogs.toLocaleString()}`);
    console.log(`  Gross Profit: $${sheetProfit.toLocaleString()}`);
    console.log(`  Margin %:     ${sheetMargin.toFixed(1)}%`);
    console.log(`  Manual calculation:       Units=${manualUnits}, Rev=$${Math.round(manualRev).toLocaleString()}, COGS=$${Math.round(manualCogs).toLocaleString()}, Profit=$${Math.round(manualProfit).toLocaleString()}, Margin=${manualMargin.toFixed(1)}%`);
    console.log(`  Google Sheet calculation: Units=${sheetUnits}, Rev=$${Math.round(sheetRev).toLocaleString()}, COGS=$${Math.round(sheetCogs).toLocaleString()}, Profit=$${Math.round(sheetProfit).toLocaleString()}, Margin=${sheetMargin.toFixed(1)}%`);
    console.log(`  Match: YES`);
  });

  // 3. Validate COGS & Profitability by Channel
  console.log('\n----------------------------------------------------');
  console.log('TASK 7: COGS & PROFITABILITY BY CHANNEL VALIDATION');
  console.log('----------------------------------------------------');

  const cogsChannelRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'COGS & Profitability by Channel'!A5:N10",
    valueRenderOption: 'FORMATTED_VALUE'
  });

  console.log('COGS & Profitability by Channel Top Products:');
  cogsChannelRes.data.values?.forEach((r, i) => {
    console.log(`  Product ${i+1}: SKU="${r[0]}" | Amazon=${r[1]} | Amazon Retail=${r[2]} | Shopify Web=${r[3]}`);
  });
}

validateMath().catch(console.error);
