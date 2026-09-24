const fs = require('fs');
const data = JSON.parse(fs.readFileSync('reconciliation_full_results.json', 'utf8'));

console.log('=== SAMPLE MISSING IN PORTAL (10) ===');
data.missingInPortal.slice(0, 10).forEach(m => {
  console.log(`Order: ${m.orderNo}, SKU: ${m.sku}, Date: ${m.invoiceDate}, Customer: ${m.customer}, Status: ${m.invoiceStatus}, Sale: ${m.sale}, Qty: ${m.qty}`);
});

console.log('\n=== SAMPLE EXTRA IN PORTAL (10) ===');
data.extraInPortal.slice(0, 10).forEach(e => {
  console.log(`Order: ${e.orderNo}, SKU: ${e.sku}, Date: ${e.invoiceDate}, Customer: ${e.customer}, Status: ${e.invoiceStatus}, Sale: ${e.sale}, Qty: ${e.qty}`);
});

console.log('\n=== SAMPLE FIELD MISMATCHES (10) ===');
data.fieldMismatches.slice(0, 10).forEach(f => {
  console.log(`Order: ${f.cin7.orderNo}, SKU: ${f.cin7.sku}, Diff:`, JSON.stringify(f.diffs));
});
