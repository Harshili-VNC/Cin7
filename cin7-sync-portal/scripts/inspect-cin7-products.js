const axios = require('axios');
require('dotenv').config();

const headers = {
  'api-auth-accountid': process.env.CIN7_ACCOUNT_ID,
  'api-auth-applicationkey': process.env.CIN7_API_KEY,
  'Content-Type': 'application/json'
};
const BASE_URL = process.env.CIN7_BASE_URL;

async function checkProducts() {
  const res = await axios.get(BASE_URL + '/product', {
    headers,
    params: { Page: 1, Limit: 50 }
  });
  console.log('Total Products in Cin7:', res.data.Total);
  console.log('First 15 Products:');
  (res.data.Products || []).slice(0, 15).forEach(p => {
    console.log(`SKU: "${p.SKU}" | Name: "${p.Name}" | Brand: "${p.Brand}" | Category: "${p.Category}"`);
  });

  // Also check if any product has 'Ola' or 'Mate'
  const hasOla = (res.data.Products || []).filter(p => (p.Name + p.SKU).toLowerCase().includes('ola') || (p.Name + p.SKU).toLowerCase().includes('mate'));
  console.log('\nProducts matching "ola" or "mate":', hasOla.length);
}
checkProducts().catch(console.error);
