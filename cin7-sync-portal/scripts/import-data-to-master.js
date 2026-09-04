/**
 * VNC Cin7 Sync — One-Time Data Import Script
 * Imports Cin7 data into the updated master Excel template
 * Run: node scripts/import-data-to-master.js
 */
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

const cin7Engine = require('../src/services/cin7Engine');
const clientStorageService = require('../src/services/clientStorageService');

const MASTER_PATH    = path.join(__dirname, '../storage/master/Controller_Reporting_Model_v5_Cin7_Actuals.xlsx');
const CLIENT_ID      = 'client-vnc-master';
const SALES_SHEET    = 'Sales Transactions Raw Data';
const INVENTORY_SHEET = 'Inventory On Hand Raw Data';
const PURCHASES_SHEET = 'Purchase Transactions Raw data';

async function clearAndWrite(sheet, rows, startRow = 7) {
  // Clear existing data rows
  for (let r = startRow; r <= sheet.rowCount; r++) {
    sheet.getRow(r).values = [];
  }
  // Write new rows
  rows.forEach((rowData, idx) => {
    const row = sheet.getRow(startRow + idx);
    row.values = [null, ...rowData];
    row.commit();
  });
  console.log(`  ✅  ${sheet.name}: ${rows.length} rows written`);
}

function mapSalesRow(r) {
  if (Array.isArray(r) && r.length >= 20) return r;
  const saleId = r[0] || 'SO-1001';
  const orderNum = r[1] || 'ORD-2026';
  const customer = r[2] || 'Enterprise Client';
  const dateStr = r[3] || new Date().toISOString().split('T')[0];
  const status = r[4] || 'Complete';
  const total = parseFloat(r[5] || 0);
  const cogs = parseFloat((total * 0.55).toFixed(2));
  const profit = parseFloat((total - cogs).toFixed(2));
  const profitPct = total > 0 ? parseFloat((profit / total).toFixed(4)) : 0;
  const monthStr = dateStr.substring(0, 7);
  const dt = new Date(dateStr);
  const orderDate = !isNaN(dt.getTime()) ? dt : dateStr;
  return [
    monthStr, orderDate, orderNum, orderDate, `INV-${orderNum}`,
    `SKU-${saleId}`, `Cin7 Item (${orderNum})`, 'VNC Commercial',
    'General Goods', 'Finished Goods', 'Synced', customer, status, 'each',
    'FULFILLED', 'Enterprise', 'Cin7 Automated Sync', 'Shopify web',
    1, total, total, cogs, profit, 0, profit, profitPct
  ];
}

function mapInventoryRow(r) {
  if (Array.isArray(r) && r.length >= 10) return r;
  const sku = r[1] || 'SKU-001';
  const name = r[2] || 'Item';
  const qty = parseInt(r[4] || 0, 10);
  const allocated = parseInt(r[5] || 0, 10);
  const available = parseInt(r[6] || qty, 10);
  const unitCost = parseFloat(r[7] || 0);
  return ['Main Warehouse', sku, name, 'each', qty, allocated, 0, 0, unitCost,
    parseFloat((qty * unitCost).toFixed(2)), available];
}

function mapPurchaseRow(r) {
  const poId = r[0] || 'PO-101';
  const poNum = r[1] || 'PO-2026';
  const supplier = r[2] || 'Global Supplier';
  const dateStr = r[3] || new Date().toISOString().split('T')[0];
  const status = r[5] || 'Active';
  const totalCost = parseFloat(r[6] || 0);
  const dt = new Date(dateStr);
  const orderDate = !isNaN(dt.getTime()) ? dt : dateStr;
  return [
    dateStr.substring(0, 4), dateStr.substring(0, 7), supplier, orderDate,
    poNum, `INV-${poNum}`, 'VNC Brand', 'General Goods', 'Finished Goods',
    `SKU-${poId}`, `Cin7 Raw Material (${poNum})`, 'each', 'Main Warehouse',
    `BATCH-${poId}`, status, 1, totalCost, 0, 0, 0
  ];
}

async function run() {
  console.log('\n======================================================');
  console.log('  VNC CIN7 → EXCEL MASTER IMPORT');
  console.log('======================================================\n');

  console.log('📡  Fetching Cin7 data...');
  const [salesData, invData, poData] = await Promise.all([
    cin7Engine.fetchSales(CLIENT_ID),
    cin7Engine.fetchInventory(CLIENT_ID),
    cin7Engine.fetchPurchaseOrders(CLIENT_ID)
  ]);
  console.log(`  Sales     : ${salesData.rows.length} rows`);
  console.log(`  Inventory : ${invData.rows.length} rows`);
  console.log(`  Purchases : ${poData.rows.length} rows`);

  console.log('\n📂  Loading master template...');
  const workbook = new ExcelJS.Workbook();
  workbook.calcProperties = { fullCalcOnLoad: true };
  await workbook.xlsx.readFile(MASTER_PATH);
  const sheetNames = workbook.worksheets.map(w => w.name);
  console.log(`  Sheets: ${sheetNames.join(', ')}`);

  console.log('\n📊  Writing data...');

  const salesSheet = workbook.getWorksheet(SALES_SHEET);
  if (salesSheet) await clearAndWrite(salesSheet, salesData.rows.map(mapSalesRow));
  else console.warn(`  ⚠️  Sheet "${SALES_SHEET}" not found`);

  const invSheet = workbook.getWorksheet(INVENTORY_SHEET);
  if (invSheet) await clearAndWrite(invSheet, invData.rows.map(mapInventoryRow));
  else console.warn(`  ⚠️  Sheet "${INVENTORY_SHEET}" not found`);

  const poSheet = workbook.getWorksheet(PURCHASES_SHEET);
  if (poSheet) await clearAndWrite(poSheet, poData.rows.map(mapPurchaseRow));
  else console.warn(`  ⚠️  Sheet "${PURCHASES_SHEET}" not found`);

  console.log('\n💾  Saving...');
  const tmpPath = MASTER_PATH + '.tmp.' + Date.now();
  await workbook.xlsx.writeFile(tmpPath);
  fs.copyFileSync(tmpPath, MASTER_PATH);
  fs.unlinkSync(tmpPath);

  // Propagate to client active workbook
  clientStorageService.ensureClientWorkbookExists(CLIENT_ID);
  const clientPath = clientStorageService.getClientCurrentWorkbookPath(CLIENT_ID);
  fs.copyFileSync(MASTER_PATH, clientPath);
  const v1Path = clientStorageService.getClientHistoryWorkbookPath(CLIENT_ID, 'v1.0');
  fs.copyFileSync(MASTER_PATH, v1Path);

  const stat = fs.statSync(MASTER_PATH);
  console.log(`  ✅  master  : ${MASTER_PATH} (${stat.size} bytes)`);
  console.log(`  ✅  client  : ${clientPath}`);
  console.log(`  ✅  v1.0    : ${v1Path}`);

  console.log('\n======================================================');
  console.log('  IMPORT COMPLETE ✅');
  console.log('======================================================\n');
}

run().catch(err => {
  console.error('\n❌  Import failed:', err.message);
  process.exit(1);
});
