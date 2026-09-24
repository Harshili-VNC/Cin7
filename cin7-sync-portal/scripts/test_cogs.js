const fs = require('fs');
const db = require('../src/db');
const { buildSaleV2Records } = require('../src/services/cin7Engine');

async function testOrder() {
  const { rows } = await db.queryWithTenant('SELECT detail_json FROM cin7_order_cache', [], 'client-dbb196ec');
  const target = rows.find(r => r.detail_json.includes('SO-00113'));
  if (!target) {
     console.log('SO-00113 not found.'); return;
  }
  const detail = JSON.parse(target.detail_json);
  const sale = detail.Order || {};
  
  console.log('InventoryMovements:', detail.InventoryMovements?.length);
  const records = buildSaleV2Records(sale, detail, { start: '2000-01-01', end: '2030-01-01' });
  
  for (const r of records) {
    console.log(`SKU: ${r.sku}, Qty: ${r.qty}, COGS: ${r.cogs}, SaleAmt: ${r.saleAmt}`);
  }
}

testOrder().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
