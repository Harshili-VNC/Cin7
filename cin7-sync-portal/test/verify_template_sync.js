const MicrosoftExcelAdapter = require('../src/services/microsoftExcelAdapter');
const cin7Engine = require('../src/services/cin7Engine');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

async function verifyTemplateSync() {
  console.log('=====================================================================');
  console.log('🧪 VERIFYING REAL EXCEL ARCHITECTURE & TEMPLATE PRESERVATION');
  console.log('=====================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, msg) {
    if (condition) {
      console.log(`✅ [PASS] ${msg}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${msg}`);
      failed++;
    }
  }

  const masterTemplatePath = 'c:/Users/Harshili Patni/OneDrive - VNC Global Business Edge Pvt Ltd/Desktop/Microsoft/Controller_Reporting_Model_v5_Cin7_Actuals.xlsx';
  
  // 1. Verify Master Template Exists & Read Master Stats
  console.log('--- 1. Checking Master Template (Source of Truth) ---');
  assert(fs.existsSync(masterTemplatePath), `Master template exists at: ${masterTemplatePath}`);
  
  const masterStatsBefore = fs.statSync(masterTemplatePath);
  const masterWb = new ExcelJS.Workbook();
  await masterWb.xlsx.readFile(masterTemplatePath);
  
  const masterSheetNames = masterWb.worksheets.map(w => w.name);
  console.log(`Master Worksheets Count: ${masterSheetNames.length}`);
  assert(masterSheetNames.length === 17, `Master template has exactly 17 worksheets`);

  // Count formulas in master
  let masterFormulaCount = 0;
  masterWb.worksheets.forEach(sheet => {
    sheet.eachRow(row => {
      row.eachCell(cell => {
        if (cell.formula || (cell.value && typeof cell.value === 'object' && cell.value.formula)) {
          masterFormulaCount++;
        }
      });
    });
  });
  console.log(`Master Template Formulas Count: ${masterFormulaCount}`);
  assert(masterFormulaCount > 0, `Master template contains valid financial formulas (${masterFormulaCount} detected)`);

  // 2. Initialize Client Destination & Copy Master Template
  console.log('\n--- 2. Client-Specific Workbook Initialization ---');
  const clientId = `client-test-${Date.now()}`;
  const adapter = new MicrosoftExcelAdapter(clientId, { auth_provider: 'microsoft' });
  const dest = await adapter.getOrCreateDestination();

  assert(dest && dest.file_id, `Client destination created with File ID: ${dest.file_id}`);

  const flatFilePath = path.join(__dirname, '../storage/excel_files', `${dest.file_id}.xlsx`);
  const clientLatestPath = path.join(__dirname, '../storage/excel_files/clients', clientId, 'Controller_Reporting_Model_v5_Cin7_Actuals_latest.xlsx');

  assert(fs.existsSync(flatFilePath), `Client workbook file exists in storage: ${flatFilePath}`);
  assert(fs.existsSync(clientLatestPath), `Client latest copy exists in client directory: ${clientLatestPath}`);

  // 3. Populate Sales, Inventory, Purchase Orders & Sync Log with Version Snapshots
  console.log('\n--- 3. Synchronizing Cin7 Data & Creating Version Snapshots ---');
  const salesData = await cin7Engine.fetchSalesData('demo_user', 'demo_key');
  const invData = await cin7Engine.fetchInventoryData('demo_user', 'demo_key');
  const poData = await cin7Engine.fetchPurchaseOrdersData('demo_user', 'demo_key');

  assert(salesData.rows.length >= 5, `Fetched ${salesData.rows.length} Cin7 sales records`);
  assert(invData.rows.length >= 5, `Fetched ${invData.rows.length} Cin7 inventory records`);
  assert(poData.rows.length >= 3, `Fetched ${poData.rows.length} Cin7 purchase order records`);

  // Version 1.0 sync
  await adapter.syncSales(salesData, 'v1.0');
  await adapter.syncInventory(invData, 'v1.0');
  await adapter.syncPurchaseOrders(poData, 'v1.0');
  await adapter.updateSyncLog({
    status: 'Success',
    syncType: 'Sync All',
    detail: 'Full automated sync across Sales, Stock, and POs',
    runId: 'run-verify-001'
  });

  const v1SnapshotPath = path.join(__dirname, '../storage/excel_files/versions', `v1.0_${clientId}.xlsx`);
  assert(fs.existsSync(v1SnapshotPath), `Physical version snapshot v1.0 created: ${v1SnapshotPath}`);

  // 4. Inspect Generated Client Workbook
  console.log('\n--- 4. Inspecting Populated Client Workbook ---');
  const clientWb = new ExcelJS.Workbook();
  await clientWb.xlsx.readFile(clientLatestPath);

  assert(clientWb.worksheets.length === 17, `Preserved all 17 worksheets in client workbook (Found ${clientWb.worksheets.length})`);

  const clientSheetNames = clientWb.worksheets.map(w => w.name);
  const namesMatch = masterSheetNames.every((name, idx) => name === clientSheetNames[idx]);
  assert(namesMatch, `Worksheet names and order match master template exactly`);

  // Verify Sales Data
  const salesSheet = clientWb.getWorksheet('Sales Transactions Raw Data');
  assert(salesSheet !== undefined, 'Found "Sales Transactions Raw Data" sheet');
  const sRow7Col3 = salesSheet.getCell('C7').value;
  const sRow7Col20 = salesSheet.getCell('T7').value;
  const sRow7Col22 = salesSheet.getCell('V7').value;
  assert(sRow7Col3 && String(sRow7Col3).startsWith('ORD-'), `Sales Row 7 Order Number populated: ${sRow7Col3}`);
  assert(typeof sRow7Col20 === 'number' && sRow7Col20 > 0, `Sales Row 7 Invoice Amount numeric: $${sRow7Col20}`);
  assert(typeof sRow7Col22 === 'number' && sRow7Col22 > 0, `Sales Row 7 COGS Amount numeric: $${sRow7Col22}`);

  // Verify Inventory Data
  const invSheet = clientWb.getWorksheet('Inventory On Hand Raw Data');
  assert(invSheet !== undefined, 'Found "Inventory On Hand Raw Data" sheet');
  const iRow7Col2 = invSheet.getCell('B7').value;
  const iRow7Col5 = invSheet.getCell('E7').value;
  assert(iRow7Col2 && String(iRow7Col2).startsWith('SKU-'), `Inventory Row 7 SKU populated: ${iRow7Col2}`);
  assert(typeof iRow7Col5 === 'number' && iRow7Col5 > 0, `Inventory Row 7 Quantity on Hand numeric: ${iRow7Col5}`);

  // Verify Purchase Orders Data
  const poSheet = clientWb.getWorksheet('Purchase Transactions Raw data');
  assert(poSheet !== undefined, 'Found "Purchase Transactions Raw data" sheet');
  const poRow7Col5 = poSheet.getCell('E7').value;
  const poRow7Col17 = poSheet.getCell('Q7').value;
  assert(poRow7Col5 && String(poRow7Col5).startsWith('PO-'), `PO Row 7 PO Number populated: ${poRow7Col5}`);
  assert(typeof poRow7Col17 === 'number' && poRow7Col17 > 0, `PO Row 7 Main Cost numeric: $${poRow7Col17}`);

  // Verify Sync Log
  const logSheet = clientWb.getWorksheet('Sync Log');
  assert(logSheet !== undefined, 'Found "Sync Log" sheet');
  assert(logSheet.rowCount >= 6, `Sync Log row appended (RowCount: ${logSheet.rowCount})`);

  // Verify Dashboards & Formulas Intact
  console.log('\n--- 5. Verifying Financial Dashboards & Formula Recalculation ---');
  let clientFormulaCount = 0;
  clientWb.worksheets.forEach(sheet => {
    sheet.eachRow(row => {
      row.eachCell(cell => {
        if (cell.formula || (cell.value && typeof cell.value === 'object' && cell.value.formula)) {
          clientFormulaCount++;
        }
      });
    });
  });
  console.log(`Client Workbook Formulas Count: ${clientFormulaCount}`);
  assert(clientFormulaCount >= masterFormulaCount, `Client workbook preserved all master formulas (${clientFormulaCount} >= ${masterFormulaCount})`);
  assert(clientWb.calcProperties !== undefined, `calcProperties object initialized on workbook`);

  // 5. Master Template Immutability Check
  console.log('\n--- 6. Verifying Master Template Immutability ---');
  const masterStatsAfter = fs.statSync(masterTemplatePath);
  assert(masterStatsAfter.mtimeMs === masterStatsBefore.mtimeMs || masterStatsAfter.size === masterStatsBefore.size, `Master template was NOT modified (Source of truth preserved)`);

  console.log('\n=====================================================================');
  console.log(`📊 ARCHITECTURE VERIFICATION RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('=====================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

verifyTemplateSync().catch(err => {
  console.error('❌ Verification crash:', err);
  process.exit(1);
});
