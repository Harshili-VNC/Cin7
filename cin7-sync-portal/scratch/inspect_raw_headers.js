const ExcelJS = require('exceljs');

async function inspectRawDataHeaders() {
  const file = 'c:/Users/Harshili Patni/OneDrive - VNC Global Business Edge Pvt Ltd/Desktop/Microsoft/Controller_Reporting_Master_Template.xlsx';
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  ['Sales Transactions Raw Data', 'Inventory On Hand Raw Data', 'Purchase Transactions Raw data', 'Cost Inputs', 'Sync Log'].forEach(name => {
    const sheet = wb.getWorksheet(name);
    if (!sheet) {
      console.log(`Sheet not found: ${name}`);
      return;
    }

    console.log(`\n========================================`);
    console.log(`SHEET: ${name}`);
    console.log(`========================================`);

    const r6 = sheet.getRow(6);
    const headers = [];
    r6.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      headers[colNumber] = cell.value;
    });

    console.log('Row 6 Headers:');
    headers.forEach((h, idx) => {
      if (h !== undefined) {
        console.log(`  Col ${idx}: "${h}"`);
      }
    });
  });
}

inspectRawDataHeaders();
