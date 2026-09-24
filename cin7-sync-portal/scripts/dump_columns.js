const ExcelJS = require('exceljs');
const path = require('path');
const downloadsDir = 'C:\\Users\\Harshili Patni\\OneDrive - VNC Global Business Edge Pvt Ltd\\Downloads';
const portalFile = path.join(downloadsDir, 'Controller Reporting - Western Mixers - Synced by VNC Automation - 2026-09-24 11-57-15.xlsx');

async function dumpRow() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(portalFile);
  const ws = wb.getWorksheet('Sales Transactions Raw Data');
  const r6 = ws.getRow(6);
  const r7 = ws.getRow(7);
  console.log('=== ROW 6 vs ROW 7 COLUMN BY COLUMN ===');
  for (let c = 1; c <= 28; c++) {
    const h = r6.getCell(c).value;
    const v = r7.getCell(c).value;
    console.log(`Col ${c} (${String.fromCharCode(64 + c)}): Header = '${h}' | Row 7 Value = '${v}' (type: ${typeof v})`);
  }
}
dumpRow();
