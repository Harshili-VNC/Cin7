const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
require('dotenv').config();
const GoogleSheetsAdapter = require('../src/services/googleSheetsAdapter');
const cin7 = require('../src/services/cin7Engine');

async function testDynamicReports() {
  console.log('====================================================');
  console.log('TESTING DYNAMIC REPORT CALCULATION ON NEW CLONE');
  console.log('====================================================');

  const adapter = new GoogleSheetsAdapter();
  const clientId = 'client-vnc-master';

  // 1. Fetch fresh live Cin7 data
  console.log('1. Fetching live Cin7 data...');
  const [salesData, invData, poData] = await Promise.all([
    cin7.fetchSales(clientId),
    cin7.fetchInventory(clientId),
    cin7.fetchPurchaseOrders(clientId)
  ]);

  console.log(`Fetched: ${salesData.rows.length} Sales, ${invData.rows.length} Inventory, ${poData.rows.length} POs`);

  // 2. Clone Master Template
  console.log('\n2. Cloning Master Template 1Qnx6RdCgI7krHtZru10J6r11ZpIkubCSR1jzUbs5G9Q...');
  const cloned = await adapter.createGoogleSheetFromTemplate('harshili.patni@vnc.global');
  const spreadsheetId = cloned.file_id;
  console.log('NEW Spreadsheet ID:', spreadsheetId);
  console.log('NEW Spreadsheet URL:', cloned.web_view_link);

  // 3. Populate raw data
  console.log('\n3. Populating Raw Data tabs...');
  await adapter.syncSales(salesData, 'harshili.patni@vnc.global', cloned);
  await adapter.syncInventory(invData, 'harshili.patni@vnc.global', cloned);
  await adapter.syncPurchaseOrders(poData, 'harshili.patni@vnc.global', cloned);

  // 4. Now apply dynamic reporting logic to make the product criteria match actual Cin7 products
  console.log('\n4. Updating cloned reporting sheets with dynamic Cin7 criteria...');
  const { sheets } = await adapter.getGoogleClients();

  // Find top 6 products by sales volume from real Cin7 sales data
  const salesByProduct = {};
  salesData.rows.forEach(r => {
    const sku = r[5] || 'SKU';
    const name = r[6] || sku;
    const saleAmt = parseFloat(r[20] || 0);
    const cogs = parseFloat(r[21] || 0);
    const qty = parseInt(r[19] || 1);

    if (!salesByProduct[sku]) {
      salesByProduct[sku] = { sku, name, revenue: 0, cogs: 0, qty: 0, count: 0 };
    }
    salesByProduct[sku].revenue += saleAmt;
    salesByProduct[sku].cogs += cogs;
    salesByProduct[sku].qty += qty;
    salesByProduct[sku].count += 1;
  });

  const topProducts = Object.values(salesByProduct)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 6);

  console.log('Top Cin7 Products for Dynamic Reporting:');
  topProducts.forEach((p, idx) => console.log(`  ${idx+1}. SKU: "${p.sku}" | Rev: $${p.revenue.toFixed(2)}`));

  // Determine top channels
  const activeChannels = ['Shopify', 'Shopify web', 'Amazon.com', 'API'];

  // A. Update "COGS & Profitability by Channel"
  const cogsUpdates = [];
  topProducts.forEach((p, i) => {
    const rowNum = 5 + i; // Rev rows 5 to 10
    const cogsRowNum = 14 + i; // COGS rows 14 to 19

    // Update Product Name label in Col A
    cogsUpdates.push({ range: `'COGS & Profitability by Channel'!A${rowNum}`, values: [[p.name || p.sku]] });
    cogsUpdates.push({ range: `'COGS & Profitability by Channel'!A${cogsRowNum}`, values: [[p.name || p.sku]] });

    // Update formulas for each channel column (B to M)
    const channelCols = [
      { col: 'B', channel: 'amazon' },
      { col: 'C', channel: 'amazon-us' },
      { col: 'D', channel: 'Shopify web' },
      { col: 'E', channel: 'Shopify POS' },
      { col: 'F', channel: 'Shopify admin' },
      { col: 'G', channel: 'subscription_contract' },
      { col: 'H', channel: 'subscription_contract_checkout_one' },
      { col: 'I', channel: '296827748353' },
      { col: 'J', channel: 'faire' },
      { col: 'K', channel: 'tiktok' },
      { col: 'L', channel: 'Shopify' },
      { col: 'M', channel: 'API' }
    ];

    channelCols.forEach(({ col, channel }) => {
      // Rev formula
      const revForm = `=SUMIFS('Sales Transactions Raw Data'!V:V,'Sales Transactions Raw Data'!G:G,"${p.sku}",'Sales Transactions Raw Data'!S:S,"*${channel}*",'Sales Transactions Raw Data'!J:J,"Finished Goods")`;
      cogsUpdates.push({ range: `'COGS & Profitability by Channel'!${col}${rowNum}`, values: [[revForm]] });

      // COGS formula
      const cogsForm = `=SUMIFS('Sales Transactions Raw Data'!W:W,'Sales Transactions Raw Data'!G:G,"${p.sku}",'Sales Transactions Raw Data'!S:S,"*${channel}*",'Sales Transactions Raw Data'!J:J,"Finished Goods")`;
      cogsUpdates.push({ range: `'COGS & Profitability by Channel'!${col}${cogsRowNum}`, values: [[cogsForm]] });
    });
  });

  // B. Update "Product Margin Analysis"
  const marginUpdates = [];
  topProducts.forEach((p, i) => {
    const rowNum = 5 + i;
    marginUpdates.push({ range: `'Product Margin Analysis'!A${rowNum}`, values: [[p.name || p.sku]] });
    marginUpdates.push({
      range: `'Product Margin Analysis'!B${rowNum}:D${rowNum}`,
      values: [[
        `=SUMIFS('Sales Transactions Raw Data'!T:T,'Sales Transactions Raw Data'!G:G,"${p.sku}",'Sales Transactions Raw Data'!J:J,"Finished Goods")`,
        `=SUMIFS('Sales Transactions Raw Data'!V:V,'Sales Transactions Raw Data'!G:G,"${p.sku}",'Sales Transactions Raw Data'!J:J,"Finished Goods")`,
        `=SUMIFS('Sales Transactions Raw Data'!W:W,'Sales Transactions Raw Data'!G:G,"${p.sku}",'Sales Transactions Raw Data'!J:J,"Finished Goods")`
      ]]
    });
  });

  // Execute batch updates
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [...cogsUpdates, ...marginUpdates]
    }
  });

  console.log('Dynamic formulas successfully applied!');

  // 5. Read back calculated cells
  console.log('\n5. Reading back calculated values from Google Sheets API...');

  const cogsRead = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'COGS & Profitability by Channel'!A11:M22",
    valueRenderOption: 'FORMATTED_VALUE'
  });

  const marginRead = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Product Margin Analysis'!A5:H11",
    valueRenderOption: 'FORMATTED_VALUE'
  });

  const kpiRead = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'KPI Dashboard'!A5:D10",
    valueRenderOption: 'FORMATTED_VALUE'
  });

  console.log('\n--- COGS & Profitability by Channel Read-Back ---');
  cogsRead.data.values?.slice(0, 5).forEach((r, i) => console.log(`Row ${i+11} (${r[0]}):`, r.slice(1, 6)));

  console.log('\n--- Product Margin Analysis Read-Back ---');
  marginRead.data.values?.forEach((r, i) => console.log(`Product ${i+1} [${r[0]}]: Units=${r[1]}, Rev=${r[2]}, COGS=${r[3]}, Profit=${r[4]}, Margin=${r[5]}`));

  console.log('\n--- KPI Dashboard Read-Back ---');
  kpiRead.data.values?.forEach((r, i) => console.log(`KPI Row ${i+5}: [${r[0]}] = ${r[1]} | [${r[2]}] = ${r[3]}`));
}

testDynamicReports().catch(console.error);
