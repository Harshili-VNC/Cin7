const assert = require('assert');
const { mapSaleLineToRow } = require('../src/services/cin7Engine');

const sale = {
  OrderDate: '2026-08-01T00:00:00',
  OrderNumber: 'SO-00169',
  InvoiceDate: '2026-08-01T00:00:00',
  InvoiceNumber: 'INV-00169',
  Customer: 'Real Cin7 Customer',
  SourceChannel: 'Shopify web',
  Status: 'INVOICED'
};

const line = {
  SKU: '100118',
  Name: 'Lattice Back',
  Quantity: 6,
  Total: 13500,
  AverageCost: 700
};

const row = mapSaleLineToRow(sale, line);

assert.strictEqual(row[2], 'SO-00169', 'Sales Order remains in Order #');
assert.strictEqual(row[5], '100118', 'Raw SKU column uses Cin7 line SKU');
assert.strictEqual(row[6], '100118', 'Existing report key column uses Cin7 line SKU');
assert.notStrictEqual(row[5], row[2], 'SKU is not the Sales Order ID');
assert.strictEqual(row[19], 6, 'Quantity comes from Cin7 line');
assert.strictEqual(row[21], 13500, 'Revenue comes from Cin7 line total');
assert.strictEqual(row[22], 4200, 'COGS equals Cin7 quantity times AverageCost');
assert.strictEqual(row[24], 9300, 'Gross profit is revenue less COGS');
assert.strictEqual(row[25], 0.6889, 'Margin is gross profit divided by revenue');

console.log('PASS: Product margin mapping uses Cin7 Order.Lines[].SKU and line economics.');
