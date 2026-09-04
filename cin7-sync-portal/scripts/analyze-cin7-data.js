const cin7 = require('../src/services/cin7Engine');

async function analyze() {
  const [salesData, invData, poData] = await Promise.all([
    cin7.fetchSales('client-vnc-master'),
    cin7.fetchInventory('client-vnc-master'),
    cin7.fetchPurchaseOrders('client-vnc-master')
  ]);

  console.log('====================================================');
  console.log('CIN7 REAL DATA ANALYSIS');
  console.log('====================================================');

  console.log(`Total Sales: ${salesData.rows.length}`);
  console.log(`Total Inventory: ${invData.rows.length}`);
  console.log(`Total POs: ${poData.rows.length}`);

  // Sales analysis
  const salesByProduct = {};
  const channels = new Set();
  const months = new Set();
  const years = new Set();
  const invoiceStatuses = new Set();

  salesData.rows.forEach(r => {
    // r[0]: Month/Year, r[1]: Month/Date, etc. Let's see what's in each column of cin7Engine output
    // Let's print the first row with indices
  });

  console.log('\nSales Headers & Sample Row 1:');
  salesData.headers.forEach((h, i) => {
    console.log(`Index ${i} (${String.fromCharCode(65+i)}): [${h}] = "${salesData.rows[0]?.[i]}"`);
  });

  // Calculate top products by total sales revenue
  salesData.rows.forEach(r => {
    const sku = r[5] || 'Unknown';
    const prodName = r[6] || sku;
    const channel = r[17] || r[18] || 'Direct';
    const month = r[1] || r[0];
    const year = r[0];
    const saleAmt = parseFloat(r[20] || r[21] || 0);
    const cogs = parseFloat(r[21] || r[22] || 0);
    const status = r[12] || 'Invoiced';

    channels.add(channel);
    months.add(month);
    years.add(year);
    invoiceStatuses.add(status);

    const key = `${sku}:::${prodName}`;
    if (!salesByProduct[key]) {
      salesByProduct[key] = { sku, prodName, count: 0, revenue: 0, cogs: 0 };
    }
    salesByProduct[key].count += 1;
    salesByProduct[key].revenue += saleAmt;
    salesByProduct[key].cogs += cogs;
  });

  const sortedProducts = Object.values(salesByProduct).sort((a, b) => b.revenue - a.revenue);
  console.log('\nTop 10 Products by Sales Revenue:');
  sortedProducts.slice(0, 10).forEach((p, idx) => {
    console.log(`${idx+1}. SKU: "${p.sku}" | Name: "${p.prodName}" | Orders: ${p.count} | Rev: $${p.revenue.toFixed(2)} | COGS: $${p.cogs.toFixed(2)}`);
  });

  console.log('\nUnique Sales Channels:', Array.from(channels));
  console.log('Unique Years:', Array.from(years));
  console.log('Unique Months:', Array.from(months));
  console.log('Unique Invoice Statuses:', Array.from(invoiceStatuses));

  // Inventory analysis
  console.log('\nInventory Headers & Sample Row 1:');
  invData.headers.forEach((h, i) => {
    console.log(`Index ${i} (${String.fromCharCode(65+i)}): [${h}] = "${invData.rows[0]?.[i]}"`);
  });

  const invLocations = new Set();
  invData.rows.forEach(r => {
    invLocations.add(r[0]);
  });
  console.log('\nUnique Inventory Locations:', Array.from(invLocations));
}

analyze().catch(console.error);
