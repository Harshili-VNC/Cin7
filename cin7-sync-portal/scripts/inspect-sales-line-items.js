const axios = require('axios');
require('dotenv').config();

const headers = {
  'api-auth-accountid': process.env.CIN7_ACCOUNT_ID,
  'api-auth-applicationkey': process.env.CIN7_API_KEY,
  'Content-Type': 'application/json'
};
const BASE_URL = process.env.CIN7_BASE_URL;

async function checkAllSalesProducts() {
  console.log('Fetching sales list...');
  let allSales = [];
  let page = 1;
  while (true) {
    const res = await axios.get(BASE_URL + '/saleList', {
      headers,
      params: { Page: page, Limit: 100 }
    });
    const list = res.data.SaleList || [];
    allSales = allSales.concat(list);
    if (list.length === 0 || allSales.length >= res.data.Total || page >= 10) break;
    page++;
  }
  console.log('Total sales orders fetched:', allSales.length);

  // Check how many have amounts > 0
  const activeSales = allSales.filter(s => s.InvoiceAmount > 0 || s.SaleInvoicesTotalAmount > 0);
  console.log('Active sales with amount > 0:', activeSales.length);

  // Fetch line items for first 20 active sales
  console.log('\nFetching line items for sample active sales...');
  const productSummary = {};

  for (let i = 0; i < Math.min(activeSales.length, 15); i++) {
    const s = activeSales[i];
    try {
      const detail = await axios.get(BASE_URL + '/sale', {
        headers,
        params: { ID: s.SaleID }
      });
      const lines = detail.data.Order?.Lines || [];
      console.log(`Sale ${s.OrderNumber} (${lines.length} lines, $${s.InvoiceAmount}):`);
      lines.forEach(line => {
        console.log(`   - SKU: "${line.SKU}" | Name: "${line.Name}" | Qty: ${line.Quantity} | Price: $${line.Price} | Total: $${line.Total}`);
        if (!productSummary[line.SKU]) {
          productSummary[line.SKU] = { sku: line.SKU, name: line.Name, totalRev: 0, totalQty: 0, orderCount: 0 };
        }
        productSummary[line.SKU].totalRev += line.Total || 0;
        productSummary[line.SKU].totalQty += line.Quantity || 0;
        productSummary[line.SKU].orderCount += 1;
      });
    } catch(err) {
      console.log(`Error fetching sale ${s.OrderNumber}:`, err.message);
    }
  }

  console.log('\nTop products found in sampled sales:');
  console.log(JSON.stringify(Object.values(productSummary), null, 2));

  // Also fetch product catalog from /product
  const prodRes = await axios.get(BASE_URL + '/product', {
    headers,
    params: { Page: 1, Limit: 50 }
  });
  console.log('\nSample products from Cin7 Product Catalog (/product):');
  (prodRes.data.Products || []).slice(0, 10).forEach(p => {
    console.log(`- SKU: "${p.SKU}" | Name: "${p.Name}" | Category: "${p.Category}" | Price: $${p.PriceTier1}`);
  });
}

checkAllSalesProducts().catch(console.error);
