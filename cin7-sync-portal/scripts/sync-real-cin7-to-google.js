const cin7Engine = require('../src/services/cin7Engine');
const GoogleSheetsAdapter = require('../src/services/googleSheetsAdapter');
require('dotenv').config();

async function syncRealData() {
  console.log('==============================================');
  console.log('STARTING REAL LIVE CIN7 -> GOOGLE SHEETS SYNC');
  console.log('==============================================\n');

  // 1. Fetch Real Datasets from Live Cin7 Core API
  const [salesData, invData, poData] = await Promise.all([
    cin7Engine.fetchSales('client-vnc-master'),
    cin7Engine.fetchInventory('client-vnc-master'),
    cin7Engine.fetchPurchaseOrders('client-vnc-master')
  ]);

  console.log(`\nReal Cin7 Records Fetched:`);
  console.log(`- Sales Orders:   ${salesData.rows.length} rows`);
  console.log(`- Inventory SKUs: ${invData.rows.length} rows`);
  console.log(`- Purchase Orders: ${poData.rows.length} rows\n`);

  // 2. Inject into live Google Sheets using GoogleSheetsAdapter
  const adapter = new GoogleSheetsAdapter('client-vnc-master', { email: 'harshili.patni@vnc.global' });
  const dest = await adapter.syncSales(salesData, 'harshili.patni@vnc.global');
  await adapter.syncInventory(invData, 'harshili.patni@vnc.global');
  await adapter.syncPurchaseOrders(poData, 'harshili.patni@vnc.global');
  await adapter.updateSyncLog({
    syncType: 'google_sheets_live_cin7',
    status: 'Success',
    detail: `Live Cin7 Sync: ${salesData.rows.length + invData.rows.length + poData.rows.length} real records injected`
  }, 'harshili.patni@vnc.global');

  console.log('\n==============================================');
  console.log('REAL LIVE CIN7 SYNC COMPLETED SUCCESSFULLY!');
  console.log('Spreadsheet ID:  ', dest.file_id);
  console.log('Spreadsheet URL: ', dest.file_url);
  console.log('==============================================');
}

syncRealData().catch(console.error);
