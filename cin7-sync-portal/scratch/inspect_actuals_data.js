const ExcelJS = require('exceljs');

async function inspectActualsData() {
  const file = 'c:/Users/Harshili Patni/OneDrive - VNC Global Business Edge Pvt Ltd/Desktop/Microsoft/Controller_Reporting_Model_v5_Cin7_Actuals.xlsx';
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  console.log(`Workbook: ${file}`);

  ['Sales Transactions Raw Data', 'Inventory On Hand Raw Data', 'Purchase Transactions Raw data', 'Cost Inputs', 'Sync Log'].forEach(name => {
    const sheet = wb.getWorksheet(name);
    if (!sheet) {
      console.log(`Sheet not found: ${name}`);
      return;
    }

    console.log(`\n========================================`);
    console.log(`SHEET: ${name}`);
    console.log(`RowCount: ${sheet.rowCount}`);
    console.log(`========================================`);

    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
      if (rowNum >= 6 && rowNum <= 12) {
        const vals = [];
        row.eachCell({ includeEmpty: true }, (cell, colNum) => {
          vals[colNum] = cell.value;
        });
        rows.push({ rowNum, vals: vals.filter(v => v !== undefined).slice(0, 10) });
      }
    });

    console.log(`Data preview (rows 6-12):`);
    console.dir(rows, { depth: null });
  });
}

inspectActualsData();
