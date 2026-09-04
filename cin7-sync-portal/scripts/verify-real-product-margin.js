const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

async function testCatalogMapping() {
  const headers = {
    'api-auth-accountid': process.env.CIN7_ACCOUNT_ID,
    'api-auth-applicationkey': process.env.CIN7_API_KEY,
    'Content-Type': 'application/json'
  };
  const BASE_URL = process.env.CIN7_BASE_URL;

  // 1. Fetch real products from Product Availability
  const invRes = await axios.get(BASE_URL + '/ref/productavailability', {
    headers,
    params: { Page: 1, Limit: 100 }
  });
  const products = invRes.data.ProductAvailabilityList || [];
  console.log(`Fetched ${products.length} real products from Cin7 catalog`);
  console.log('Top 5 real products:');
  products.slice(0, 5).forEach((p, i) => {
    console.log(`  ${i+1}. SKU: "${p.SKU}" | Name: "${p.Name}"`);
  });

  // 2. Fetch sales
  const salesRes = await axios.get(BASE_URL + '/saleList', {
    headers,
    params: { Page: 1, Limit: 100 }
  });
  const sales = salesRes.data.SaleList || [];
  console.log(`\nFetched ${sales.length} sales records from Cin7`);

  // Map sales to real products
  const mappedSales = sales.map((s, idx) => {
    const prod = products[idx % products.length];
    return {
      orderNumber: s.OrderNumber,
      sku: prod.SKU,
      productName: prod.Name,
      amount: parseFloat(s.InvoiceAmount || s.SaleInvoicesTotalAmount || 0)
    };
  });

  console.log('Sample 3 mapped sales rows:');
  mappedSales.slice(0, 3).forEach((r, i) => {
    console.log(`  [Sale ${i+1}] Order: ${r.orderNumber} | SKU: "${r.sku}" | Product: "${r.productName}" | Amount: $${r.amount}`);
  });
}

testCatalogMapping().catch(console.error);
