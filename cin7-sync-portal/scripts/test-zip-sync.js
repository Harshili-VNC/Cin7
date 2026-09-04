const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');

const cin7Engine = require('../src/services/cin7Engine');
const clientStorageService = require('../src/services/clientStorageService');

const MASTER_PATH = path.join(__dirname, '../storage/master/Controller_Reporting_Model_v5_Cin7_Actuals.xlsx');
const CLIENT_ID = 'client-vnc-master';

const COLUMNS = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z'];

// Helper to escape XML special characters
function escapeXml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Generate cell XML given column letter, row number, style ID, and value
function buildCellXml(col, rowNum, styleId, val) {
  const cellRef = `${col}${rowNum}`;
  const sAttr = styleId ? ` s="${styleId}"` : '';

  if (val === null || val === undefined || val === '') {
    return `<c r="${cellRef}"${sAttr}/>`;
  }

  if (typeof val === 'number') {
    return `<c r="${cellRef}"${sAttr}><v>${val}</v></c>`;
  }

  // String / Date / text
  const strVal = escapeXml(val);
  return `<c r="${cellRef}"${sAttr} t="inlineStr"><is><t>${strVal}</t></is></c>`;
}

// Replaces rows 7+ in a worksheet XML string with new row XMLs
function updateSheetXmlData(xmlContent, dataRows, colStyles, startRow = 7) {
  // Find where row 7 starts or where sheetData ends
  const sheetDataStart = xmlContent.indexOf('<sheetData>');
  const sheetDataEnd = xmlContent.indexOf('</sheetData>');

  if (sheetDataStart === -1 || sheetDataEnd === -1) {
    throw new Error('Invalid worksheet XML: missing <sheetData>');
  }

  const prefix = xmlContent.substring(0, sheetDataStart + 11);
  const existingSheetData = xmlContent.substring(sheetDataStart + 11, sheetDataEnd);
  const suffix = xmlContent.substring(sheetDataEnd);

  // Preserve rows 1 to 6 (headers and grand total)
  const preservedRows = [];
  const rowRegex = /<row[^>]*r="(\d+)"[^>]*>[\s\S]*?<\/row>/g;
  let match;
  while ((match = rowRegex.exec(existingSheetData)) !== null) {
    const rNum = parseInt(match[1], 10);
    if (rNum < startRow) {
      preservedRows.push(match[0]);
    }
  }

  // Build new XML rows for dataRows
  const newRowXmls = dataRows.map((rowArray, idx) => {
    const rowNum = startRow + idx;
    const cellXmls = COLUMNS.map((col, cIdx) => {
      const styleId = colStyles[col] || null;
      const val = rowArray[cIdx];
      return buildCellXml(col, rowNum, styleId, val);
    });
    return `<row r="${rowNum}" spans="1:26" x14ac:dyDescent="0.25">${cellXmls.join('')}</row>`;
  });

  const combinedSheetData = [...preservedRows, ...newRowXmls].join('\n');
  return prefix + '\n' + combinedSheetData + '\n' + suffix;
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

  return [
    monthStr, dateStr, orderNum, dateStr, `INV-${orderNum}`,
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
  return [
    'Main Warehouse', sku, name, 'each', qty, allocated, 0, 0, unitCost,
    parseFloat((qty * unitCost).toFixed(2)), available
  ];
}

function mapPurchaseRow(r) {
  const poId = r[0] || 'PO-101';
  const poNum = r[1] || 'PO-2026';
  const supplier = r[2] || 'Global Supplier';
  const dateStr = r[3] || new Date().toISOString().split('T')[0];
  const status = r[5] || 'Active';
  const totalCost = parseFloat(r[6] || 0);
  return [
    dateStr.substring(0, 4), dateStr.substring(0, 7), supplier, dateStr,
    poNum, `INV-${poNum}`, 'VNC Brand', 'General Goods', 'Finished Goods',
    `SKU-${poId}`, `Cin7 Raw Material (${poNum})`, 'each', 'Main Warehouse',
    `BATCH-${poId}`, status, 1, totalCost, 0, 0, 0
  ];
}

async function runZipSync() {
  console.log('\n======================================================');
  console.log('  ZIP OPENXML INJECTION SYNC TEST');
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

  console.log('\n📂  Loading pristine master zip...');
  const templateBuffer = fs.readFileSync(MASTER_PATH);
  const zip = await JSZip.loadAsync(templateBuffer);

  const salesStyles = { A: '138', B: '138', C: '139', D: '138', E: '138', F: '138', G: '138', H: '138', I: '138', J: '138', K: '137', L: '137', M: '138', N: '138', O: '138', P: '138', Q: '137', R: '138', S: '138', T: '140', U: '140', V: '140', W: '140', X: '140', Y: '141', Z: '140' };
  const invStyles = { A: '138', B: '138', C: '138', D: '138', E: '140', F: '140', G: '140', H: '140', I: '157', J: '157', K: '140', L: '2', M: '2', N: '2', O: '2', P: '2', Q: '2', R: '2', S: '2', T: '2', U: '2', V: '2', W: '2', X: '2', Y: '2', Z: '2' };
  const poStyles = { A: '138', B: '138', C: '138', D: '138', E: '138', F: '138', G: '138', H: '138', I: '137', J: '138', K: '138', L: '138', M: '138', N: '137', O: '138', P: '140', Q: '158', R: '157', S: '158', T: '159', U: '2', V: '2', W: '2', X: '2', Y: '2', Z: '2' };

  // 1. Update sheet11.xml (Sales)
  console.log('📝  Injecting Sales sheet (sheet11.xml)...');
  const salesXml = await zip.file('xl/worksheets/sheet11.xml').async('string');
  const updatedSalesXml = updateSheetXmlData(salesXml, salesData.rows.map(mapSalesRow), salesStyles);
  zip.file('xl/worksheets/sheet11.xml', updatedSalesXml);

  // 2. Update sheet12.xml (Inventory)
  console.log('📝  Injecting Inventory sheet (sheet12.xml)...');
  const invXml = await zip.file('xl/worksheets/sheet12.xml').async('string');
  const updatedInvXml = updateSheetXmlData(invXml, invData.rows.map(mapInventoryRow), invStyles);
  zip.file('xl/worksheets/sheet12.xml', updatedInvXml);

  // 3. Update sheet13.xml (Purchases)
  console.log('📝  Injecting Purchases sheet (sheet13.xml)...');
  const poXml = await zip.file('xl/worksheets/sheet13.xml').async('string');
  const updatedPoXml = updateSheetXmlData(poXml, poData.rows.map(mapPurchaseRow), poStyles);
  zip.file('xl/worksheets/sheet13.xml', updatedPoXml);

  // Generate output buffer
  console.log('\n💾  Generating pristine XLSX zip...');
  const newBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  
  fs.writeFileSync(MASTER_PATH, newBuffer);

  clientStorageService.ensureClientWorkbookExists(CLIENT_ID);
  const clientPath = clientStorageService.getClientCurrentWorkbookPath(CLIENT_ID);
  fs.writeFileSync(clientPath, newBuffer);

  const v1Path = clientStorageService.getClientHistoryWorkbookPath(CLIENT_ID, 'v1.0');
  fs.writeFileSync(v1Path, newBuffer);

  console.log(`  ✅  Master saved  : ${MASTER_PATH} (${newBuffer.length} bytes)`);
  console.log(`  ✅  Client saved  : ${clientPath}`);
  console.log(`  ✅  Snapshot saved: ${v1Path}`);
  console.log('\n======================================================');
  console.log('  ZIP OPENXML INJECTION COMPLETE ✅');
  console.log('======================================================\n');
}

runZipSync().catch(e => console.error(e));
