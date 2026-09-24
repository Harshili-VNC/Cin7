const db = require('../src/db');
const { buildSaleV2Records, mapSaleV2RecordToRow } = require('../src/services/cin7Engine');

async function testParity() {
  const { rows: r1 } = await db.queryWithTenant('SELECT detail_json FROM cin7_order_cache', [], 'client-dbb196ec');
  const { rows: r2 } = await db.queryWithTenant('SELECT detail_json FROM cin7_order_cache', [], 'client-039ede71');
  const rows = [...r1, ...r2];
  
  const window = { start: '2026-06-26', end: '2026-09-24' };
  
  let tQty = 0, tSale = 0, tTax = 0, tInvoice = 0, tCogs = 0, tJournals = 0, tProfit = 0;
  
  console.log(`Analyzing ${rows.length} cached orders...\n`);

  const rawChecks = ['SO-41557', 'SO-38134', 'SO-46249', 'SO-00113'];
  const testResults = [];

  for (const r of rows) {
    const detail = JSON.parse(r.detail_json);
    const sale = detail.Order || {};
    const orderNo = sale.OrderNumber || sale.SaleOrderNumber;
    
    // Fix API payload typo for Fulfilments to Fulfillments if needed
    // Not strictly necessary since we fixed the logic in cin7Engine.js to use Fulfillments
    // wait, cin7Engine.js uses Fulfillments nowhere in buildSaleV2Records, only InventoryMovements!
    
    const records = buildSaleV2Records(sale, detail, window);
    
    for (const rec of records) {
      const row = mapSaleV2RecordToRow(sale, detail, rec, new Map());
      
      // Accumulate totals
      // Row indexes mapped in mapSaleV2RecordToRow:
      // 18 = Quantity, 19 = Invoice, 20 = Sale, 21 = COGS, 22 = Profit less journals, 23 = Journals, 24 = Profit
      
      const qty = typeof row[18] === 'number' ? row[18] : 0;
      const inv = typeof row[19] === 'number' ? row[19] : 0;
      const sal = typeof row[20] === 'number' ? row[20] : 0;
      const cogs = typeof row[21] === 'number' ? row[21] : 0;
      const plj = typeof row[22] === 'number' ? row[22] : 0;
      const jour = typeof row[23] === 'number' ? row[23] : 0;
      const prof = typeof row[24] === 'number' ? row[24] : 0;
      
      tQty += qty;
      tInvoice += inv;
      tSale += sal;
      tCogs += cogs;
      tJournals += jour;
      tProfit += prof;
      
      if (rawChecks.includes(orderNo)) {
         testResults.push({
            Order: orderNo,
            SKU: row[5] || row[4], // Item Name or Code
            Qty: qty,
            Invoice: inv,
            Sale: sal,
            COGS: cogs,
            Journals: jour,
            Profit: prof,
            RowType: rec.rowType
         });
      }
    }
  }

  console.log('=== NEW PORTAL TOTALS (After all 3 Fixes) ===');
  console.log(`Quantity : ${tQty}`);
  console.log(`Invoice  : $${tInvoice.toFixed(2)}`);
  console.log(`Sale     : $${tSale.toFixed(2)}`);
  console.log(`COGS     : $${tCogs.toFixed(2)}`);
  console.log(`Journals : $${tJournals.toFixed(2)}`);
  console.log(`Profit   : $${tProfit.toFixed(2)}\n`);

  console.log('=== RAW DATA CHECKS ===');
  for (const chk of testResults) {
     console.log(JSON.stringify(chk));
  }
}

testParity().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
