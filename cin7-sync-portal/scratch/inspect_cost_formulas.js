const ExcelJS = require('exceljs');

async function inspectCostInputsFormulas() {
  const file = 'c:/Users/Harshili Patni/OneDrive - VNC Global Business Edge Pvt Ltd/Desktop/Microsoft/Controller_Reporting_Master_Template.xlsx';
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  const sheet = wb.getWorksheet('Cost Inputs');
  console.log(`Sheet: Cost Inputs`);
  sheet.eachRow((row, rowNum) => {
    row.eachCell((cell, colNum) => {
      if (cell.formula || (cell.value && typeof cell.value === 'object' && cell.value.formula)) {
        console.log(`Row ${rowNum}, Col ${colNum}: formula="${cell.formula || cell.value.formula}"`);
      }
    });
  });
}

inspectCostInputsFormulas();
