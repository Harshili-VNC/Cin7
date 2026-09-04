const cin7Engine = require('../src/services/cin7Engine');
const GoogleSheetsAdapter = require('../src/services/googleSheetsAdapter');
require('dotenv').config();

const spreadsheetId = process.argv[2] || '1z6t3BS59WAxqJ1-ZLmQ86T88RqpcfVllQ84-YjfOHr8';
const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

async function main() {
  console.log(`Refreshing provided Google Sheet with all-time live Cin7 data: ${spreadsheetId}`);

  const [salesData, inventoryData, purchaseData] = await Promise.all([
    cin7Engine.fetchSales('client-vnc-master'),
    cin7Engine.fetchInventory('client-vnc-master'),
    cin7Engine.fetchPurchaseOrders('client-vnc-master')
  ]);

  const adapter = new GoogleSheetsAdapter('client-vnc-master', { email: 'harshili.patni@vnc.global' });
  const { sheets } = await adapter.getGoogleClients();

  // Remove only old raw-tab values below the existing headers. The template,
  // tabs, formatting, and formulas remain unchanged.
  await sheets.spreadsheets.values.batchClear({
    spreadsheetId,
    requestBody: {
      ranges: [
        "'Sales Transactions Raw Data'!A7:Z",
        "'Inventory On Hand Raw Data'!A7:K",
        "'Purchase Transactions Raw data'!A7:T"
      ]
    }
  });

  const destination = { file_id: spreadsheetId, file_url: spreadsheetUrl };
  await adapter.syncSales(salesData, null, destination);
  await adapter.syncInventory(inventoryData, null, destination);
  await adapter.syncPurchaseOrders(purchaseData, null, destination);
  await adapter.updateClonedReportFormulas(spreadsheetId, salesData, inventoryData);

  console.log(`All-time refresh complete: Sales=${salesData.rows.length}, Inventory=${inventoryData.rows.length}, Purchase Orders=${purchaseData.rows.length}`);
  console.log(`Spreadsheet: ${spreadsheetUrl}`);
}

main().catch(error => {
  console.error('SYNC_FAILED:', error.response?.data?.error?.message || error.response?.status || error.message);
  process.exit(1);
});
