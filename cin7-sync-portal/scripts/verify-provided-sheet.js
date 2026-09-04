const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const cin7 = require('../src/services/cin7Engine');
require('dotenv').config();

const spreadsheetId = process.argv[2] || '1z6t3BS59WAxqJ1-ZLmQ86T88RqpcfVllQ84-YjfOHr8';

function n(value) {
  const valueNumber = Number(String(value ?? '').replace(/[$,% ,]/g, ''));
  return Number.isFinite(valueNumber) ? valueNumber : 0;
}

function aggregate(rows) {
  const bySku = {};
  for (const row of rows) {
    const sku = String(row[6] || row[5] || '').trim();
    if (!sku || /^SO[-_]/i.test(sku)) continue;
    if (!bySku[sku]) bySku[sku] = { sku, units: 0, revenue: 0, cogs: 0, profit: 0 };
    bySku[sku].units += n(row[19]);
    bySku[sku].revenue += n(row[21]);
    bySku[sku].cogs += n(row[22]);
    bySku[sku].profit += n(row[24]);
  }
  return Object.values(bySku);
}

async function getSheetsClient() {
  const root = path.resolve('..', 'cin7-sheets');
  const rawCredentials = JSON.parse(fs.readFileSync(path.join(root, 'oauth-credentials.json'), 'utf8'));
  const config = rawCredentials.installed || rawCredentials.web;
  const token = JSON.parse(fs.readFileSync(path.join(root, 'token.json'), 'utf8'));
  const auth = new google.auth.OAuth2(config.client_id, config.client_secret, (config.redirect_uris || [])[0]);
  auth.setCredentials(token);
  return google.sheets({ version: 'v4', auth });
}

async function readRange(sheets, range, valueRenderOption = 'UNFORMATTED_VALUE') {
  const result = await sheets.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption });
  return result.data.values || [];
}

async function main() {
  const sheets = await getSheetsClient();
  const metadata = await sheets.spreadsheets.get({ spreadsheetId, includeGridData: false });
  console.log(`Sheet: ${metadata.data.properties?.title || spreadsheetId}`);
  console.log(`Tabs: ${(metadata.data.sheets || []).map(sheet => sheet.properties.title).join(' | ')}`);

  const [salesRows, inventoryRows, poRows, marginRows, channelRows] = await Promise.all([
    readRange(sheets, "'Sales Transactions Raw Data'!A7:Z"),
    readRange(sheets, "'Inventory On Hand Raw Data'!A7:K"),
    readRange(sheets, "'Purchase Transactions Raw data'!A7:T"),
    readRange(sheets, "'Product Margin Analysis'!A5:H10"),
    readRange(sheets, "'COGS & Profitability by Channel'!A5:M19")
  ]);
  console.log(`Current rows: Sales=${salesRows.length}, Inventory=${inventoryRows.length}, Purchase Orders=${poRows.length}`);
  console.log(`Current Product Margin labels: ${marginRows.map(row => row[0]).filter(Boolean).join(', ')}`);
  console.log(`Current Channel labels: ${channelRows.map(row => row[0]).filter(Boolean).join(', ')}`);

  console.log('Fetching complete all-time Cin7 data...');
  const [liveSales, liveInventory, livePurchaseOrders] = await Promise.all([
    cin7.fetchSales('client-vnc-master'),
    cin7.fetchInventory('client-vnc-master'),
    cin7.fetchPurchaseOrders('client-vnc-master')
  ]);

  const currentProducts = aggregate(salesRows);
  const liveProducts = aggregate(liveSales.rows);
  const currentBySku = Object.fromEntries(currentProducts.map(product => [product.sku, product]));
  const liveBySku = Object.fromEntries(liveProducts.map(product => [product.sku, product]));
  const topProducts = liveProducts.sort((a, b) => b.revenue - a.revenue).slice(0, 3);

  console.log(`All-time Cin7 rows: Sales=${liveSales.rows.length}, Inventory=${liveInventory.rows.length}, Purchase Orders=${livePurchaseOrders.rows.length}`);
  console.log(`All-time totals: Units=${liveSales.rows.reduce((sum, row) => sum + n(row[19]), 0)}, Revenue=${liveSales.rows.reduce((sum, row) => sum + n(row[21]), 0).toFixed(2)}, COGS=${liveSales.rows.reduce((sum, row) => sum + n(row[22]), 0).toFixed(2)}`);
  console.log('\nTop 3 SKU reconciliation (provided sheet vs live Cin7):');
  for (const expected of topProducts) {
    const current = currentBySku[expected.sku] || {};
    const actual = marginRows.find(row => String(row[0]) === expected.sku) || [];
    console.log(`${expected.sku}: sheet raw U=${current.units || 0}, Rev=${(current.revenue || 0).toFixed(2)}, COGS=${(current.cogs || 0).toFixed(2)}; live U=${expected.units}, Rev=${expected.revenue.toFixed(2)}, COGS=${expected.cogs.toFixed(2)}; report U=${n(actual[1])}, Rev=${n(actual[2]).toFixed(2)}, COGS=${n(actual[3]).toFixed(2)}, GP=${n(actual[4]).toFixed(2)}, Margin=${(n(actual[5]) * 100).toFixed(2)}%`);
  }
}

main().catch(error => {
  console.error('VERIFY_FAILED:', error.response?.data?.error?.message || error.response?.status || error.message);
  process.exit(1);
});
