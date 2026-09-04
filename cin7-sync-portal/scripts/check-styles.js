const JSZip = require('jszip');
const fs = require('fs');

const MASTER_PATH = 'C:/Users/Harshili Patni/OneDrive - VNC Global Business Edge Pvt Ltd/Desktop/Cin7/cin7-sync-portal/storage/master/Controller_Reporting_Model_v5_Cin7_Actuals.xlsx';

async function checkStyles() {
  const data = fs.readFileSync(MASTER_PATH);
  const zip = await JSZip.loadAsync(data);

  const sheets = [
    { name: 'Sales', file: 'xl/worksheets/sheet11.xml' },
    { name: 'Inventory', file: 'xl/worksheets/sheet12.xml' },
    { name: 'Purchases', file: 'xl/worksheets/sheet13.xml' }
  ];

  for (const s of sheets) {
    const xml = await zip.file(s.file).async('string');
    const r7Match = xml.match(/<row[^>]*r="7"[^>]*>([\s\S]*?)<\/row>/);
    if (!r7Match) {
      console.log(`${s.name}: Row 7 not found`);
      continue;
    }
    const cellsXml = r7Match[1];
    const cellRe = /<c\s+r="([A-Z]+)7"\s*(?:s="(\d+)")?[^>]*>/g;
    const styles = {};
    let m;
    while ((m = cellRe.exec(cellsXml)) !== null) {
      styles[m[1]] = m[2] || null;
    }
    console.log(`\n${s.name} (${s.file}) Col Styles:`);
    console.log(styles);
  }
}

checkStyles().catch(e => console.error(e));
