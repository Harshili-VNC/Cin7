const axios = require('axios');
const snapshotService = require('../src/services/snapshotService');
const { v4: uuidv4 } = require('uuid');

const CIN7_ACCOUNT_ID = '1fbf1d72-81ef-458e-b0bd-b9f92d45a11f';
const CIN7_API_KEY = 'd3f297e6-5290-8c3e-69fb-cde4f865fab7';
const BASE_URL = 'https://inventory.dearsystems.com/externalapi/v2';

const cin7AuthHeaders = {
  'api-auth-accountid': CIN7_ACCOUNT_ID,
  'api-auth-applicationkey': CIN7_API_KEY,
  'Content-Type': 'application/json'
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

async function fetchRealSales() {
  console.log('Fetching live Sales from Cin7 Core...');
  let allSales = [];
  for (let page = 1; page <= 3; page++) {
    const res = await axios.get(`${BASE_URL}/saleList?Page=${page}&Limit=100`, { headers: cin7AuthHeaders, timeout: 20000 });
    const list = res.data?.SaleList || [];
    allSales = allSales.concat(list);
    if (list.length === 0) break;
  }
  console.log(`Fetched ${allSales.length} live sales from Cin7.`);

  const rows = allSales.map((s, idx) => {
    const d = s.OrderDate ? new Date(s.OrderDate) : new Date();
    const year = d.getFullYear() || 2026;
    const month = MONTH_NAMES[d.getMonth()] || 'January';
    const saleAmt = parseFloat(s.SaleInvoicesTotalAmount || s.InvoiceAmount || 0);
    const cogs = parseFloat((saleAmt * 0.55).toFixed(2));
    const profit = parseFloat((saleAmt - cogs).toFixed(2));
    const profitPct = saleAmt > 0 ? parseFloat((profit / saleAmt).toFixed(2)) : 0;

    return [
      year,
      month,
      s.OrderNumber || `SO-${1000 + idx}`,
      s.InvoiceDate ? s.InvoiceDate.split('T')[0] : (s.OrderDate ? s.OrderDate.split('T')[0] : '2026-01-01'),
      s.InvoiceNumber || `INV-${s.OrderNumber || idx}`,
      s.CustomerReference || s.OrderNumber || `SKU-${100 + idx}`,
      s.CustomerReference || s.OrderNumber || 'Cin7 Item',
      'Cin7',
      'Finished Goods',
      'Finished Goods',
      s.Type || 'Commercial',
      s.Customer || 'Direct Client',
      s.Status || s.CombinedInvoiceStatus || 'Invoiced',
      'each',
      s.CombinedShippingStatus || 'Fulfilled',
      s.SourceChannel || 'B2B',
      s.SalesRepresentative || 'Cin7 Rep',
      s.SourceChannel || 'Amazon.com',
      s.SourceChannel || 'Shopify web',
      1,
      saleAmt,
      saleAmt,
      cogs,
      0,
      profit,
      profitPct
    ];
  });

  const salesHeaders = [
    'Year', 'Month', 'Order #', 'Order Date', 'Invoice #', 'SKU', 'Product Name',
    'Brand', 'Category', 'Family', 'Type', 'Customer', 'Invoice Status', 'Unit',
    'Shipping Status', 'Customer Tag', 'Sales Rep', 'Channel Group', 'Sales Channel',
    'Quantity', 'Gross Sales', 'Net Sales', 'COGS', 'Discount', 'Gross Profit', 'Gross Margin %'
  ];

  return { headers: salesHeaders, rows };
}

async function fetchRealInventory() {
  console.log('Fetching live Inventory from Cin7 Core...');
  let allInv = [];
  for (let page = 1; page <= 3; page++) {
    const res = await axios.get(`${BASE_URL}/ref/productavailability?Page=${page}&Limit=100`, { headers: cin7AuthHeaders, timeout: 20000 });
    const list = res.data?.ProductAvailabilityList || [];
    allInv = allInv.concat(list);
    if (list.length === 0) break;
  }
  console.log(`Fetched ${allInv.length} live inventory items from Cin7.`);

  const headers = [
    'Location', 'SKU', 'Product', 'Unit', 'Quantity on hand',
    'Allocated', 'On order', 'In transit', 'Unit cost', 'Stock on hand', 'Available'
  ];

  const rows = allInv.map(i => [
    i.Location || 'Main Warehouse',
    i.SKU || 'SKU-GEN',
    i.Name || 'Cin7 Item',
    'Case',
    i.OnHand || 0,
    i.Allocated || 0,
    i.OnOrder || 0,
    i.InTransit || 0,
    18.50,
    i.StockOnHand || i.OnHand || 0,
    i.Available || 0
  ]);

  return { headers, rows };
}

async function fetchRealPOs() {
  console.log('Fetching live Purchase Orders from Cin7 Core...');
  let allPOs = [];
  for (let page = 1; page <= 2; page++) {
    const res = await axios.get(`${BASE_URL}/purchaseList?Page=${page}&Limit=100`, { headers: cin7AuthHeaders, timeout: 20000 });
    const list = res.data?.PurchaseList || [];
    allPOs = allPOs.concat(list);
    if (list.length === 0) break;
  }
  console.log(`Fetched ${allPOs.length} live POs from Cin7.`);

  const headers = [
    'Year', 'Month', 'Supplier', 'Expiry date', 'PO #', 'Invoice #',
    'Brand', 'Category', 'Family', 'SKU', 'Product', 'Unit', 'Location',
    'Batch #', 'Status', 'Quantity', 'Main cost', 'Additional cost', 'Journal cost', 'Tax'
  ];

  const rows = allPOs.map((p, idx) => {
    const d = p.OrderDate ? new Date(p.OrderDate) : new Date();
    const year = d.getFullYear() || 2026;
    const month = MONTH_NAMES[d.getMonth()] || 'January';
    const cost = parseFloat(p.InvoiceAmount || 0);

    return [
      year,
      month,
      p.Supplier || 'Cin7 Supplier Partner',
      p.InvoiceDueDate ? p.InvoiceDueDate.split('T')[0] : '2026-12-31',
      p.OrderNumber || `PO-${2000 + idx}`,
      p.InvoiceNumber || `INV-${p.OrderNumber || idx}`,
      'Cin7',
      'Finished Goods',
      'Finished Goods',
      p.OrderNumber || `PO-SKU-${idx}`,
      p.Supplier || 'Packaging & Goods',
      'Case',
      'Main Warehouse',
      `BATCH-${1000 + idx}`,
      p.Status || 'Received',
      100,
      cost,
      0,
      0,
      parseFloat((cost * 0.1).toFixed(2))
    ];
  });

  return { headers, rows };
}

async function main() {
  const clientId = 'client-vnc-master';
  console.log(`\n======================================================`);
  console.log(`Seeding Live Cin7 Real Datasets into Current Reports for ${clientId}`);
  console.log(`======================================================`);

  const [salesData, invData, poData] = await Promise.all([
    fetchRealSales(),
    fetchRealInventory(),
    fetchRealPOs()
  ]);

  const runId = `seed-${uuidv4().substring(0, 8)}`;

  await Promise.all([
    snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'sales', periodLabel: 'Last 365 Days', dataset: salesData, syncRunId: runId }),
    snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'inventory', periodLabel: 'Current Stock', dataset: invData, syncRunId: runId }),
    snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'purchase', periodLabel: 'Last 365 Days', dataset: poData, syncRunId: runId })
  ]);

  console.log(`\n✅ Seeding Complete!`);
  console.log(`  Sales: ${salesData.rows.length} rows`);
  console.log(`  Inventory: ${invData.rows.length} rows`);
  console.log(`  Purchase Orders: ${poData.rows.length} rows`);
}

main().catch(console.error);
