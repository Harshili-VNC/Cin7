const ExcelJS = require('exceljs');
const path = require('path');

async function inspectMasterTemplate() {
  const file = 'c:/Users/Harshili Patni/OneDrive - VNC Global Business Edge Pvt Ltd/Desktop/Microsoft/Controller_Reporting_Master_Template.xlsx';
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  console.log(`Workbook: ${file}`);
  console.log(`Total Worksheets: ${wb.worksheets.length}`);

  let totalFormulas = 0;
  const sheetStats = [];

  wb.worksheets.forEach((sheet, index) => {
    let sheetFormulas = 0;
    let maxRow = sheet.rowCount;

    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        if (cell.formula || (cell.value && typeof cell.value === 'object' && cell.value.formula)) {
          sheetFormulas++;
        }
      });
    });

    totalFormulas += sheetFormulas;

    // Get header preview if raw data sheet
    let headerRow = [];
    if (sheet.rowCount >= 6) {
      const r6 = sheet.getRow(6);
      r6.eachCell((cell, col) => {
        headerRow[col] = cell.value;
      });
    }

    sheetStats.push({
      index: index + 1,
      name: sheet.name,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      formulas: sheetFormulas,
      headerRow6: headerRow.filter(Boolean).slice(0, 10)
    });
  });

  console.log('\n--- Worksheet Summary ---');
  console.table(sheetStats);
  console.log(`Total Formulas in Workbook: ${totalFormulas}`);
}

inspectMasterTemplate();
