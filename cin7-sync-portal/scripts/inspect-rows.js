const JSZip = require('jszip');
const fs = require('fs');

const TEMPLATE = 'C:/Users/Harshili Patni/OneDrive - VNC Global Business Edge Pvt Ltd/Desktop/Cin7/Controller_Reporting_Master_Template_Updated.xlsx';

async function main() {
  const data = fs.readFileSync(TEMPLATE);
  const zip = await JSZip.loadAsync(data);

  const xml11 = await zip.file('xl/worksheets/sheet11.xml').async('string');
  
  // Find rows 6, 7, 8
  const r7 = xml11.match(/<row[^>]*r="7"[^>]*>[\s\S]*?<\/row>/);
  if (r7) console.log('Row 7:\n', r7[0]);
  
  const r8 = xml11.match(/<row[^>]*r="8"[^>]*>[\s\S]*?<\/row>/);
  if (r8) console.log('\nRow 8:\n', r8[0]);
}

main().catch(e => console.error(e));
