const JSZip = require('jszip');
const fs = require('fs');

const TEMPLATE = 'C:/Users/Harshili Patni/OneDrive - VNC Global Business Edge Pvt Ltd/Desktop/Cin7/Controller_Reporting_Master_Template_Updated.xlsx';

async function main() {
  const data = fs.readFileSync(TEMPLATE);
  const zip = await JSZip.loadAsync(data);

  // Debug: print raw rels XML
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  console.log('=== RELS XML ===');
  console.log(relsXml.substring(0, 2000));
  console.log('================\n');

  // Parse rels - try broader regex
  const rels = {};
  const relRe = /Id="(rId\d+)"[^>]*Target="([^"]+)"/g;
  let m;
  while ((m = relRe.exec(relsXml)) !== null) {
    rels[m[1]] = m[2];
  }
  console.log('Rels found:', Object.keys(rels).length);
  Object.entries(rels).forEach(([k, v]) => console.log(`  ${k} -> ${v}`));

  // Parse workbook.xml
  const wbXml = await zip.file('xl/workbook.xml').async('string');
  // Try simpler parsing - just find <sheet> elements
  const sheetRe = /<sheet[^>]+name="([^"]+)"[^>]+sheetId="(\d+)"[^>]+r:id="(rId\d+)"/g;
  const sheets = [];
  while ((m = sheetRe.exec(wbXml)) !== null) {
    sheets.push({ name: m[1], sheetId: m[2], rId: m[3] });
  }

  // If no match, try alternate attribute order
  if (sheets.length === 0) {
    const altRe = /<sheet[^>]*name="([^"]+)"[^>]*/g;
    let am;
    while ((am = altRe.exec(wbXml)) !== null) {
      // Extract rId from same element
      const elem = wbXml.substring(am.index, wbXml.indexOf('>', am.index) + 1);
      const ridM = elem.match(/r:id="(rId\d+)"/);
      sheets.push({ name: am[1], rId: ridM ? ridM[1] : '???' });
    }
  }

  console.log('\nSheet mappings:');
  sheets.forEach(s => {
    const file = rels[s.rId] || '???';
    console.log(`  ${s.name}  ->  ${s.rId}  ->  ${file}`);
  });

  // For each raw data sheet, count rows
  const targets = ['Sales Transactions Raw Data', 'Inventory On Hand Raw Data', 'Purchase Transactions Raw data'];
  for (const name of targets) {
    const sheet = sheets.find(s => s.name === name || s.name.includes(name));
    if (!sheet) { console.log(`\n${name}: NOT FOUND`); continue; }
    const file = rels[sheet.rId];
    if (!file) { console.log(`\n${name}: no file mapping`); continue; }
    const fullPath = 'xl/' + file;
    const zf = zip.file(fullPath);
    if (!zf) { console.log(`\n${name}: file ${fullPath} not in ZIP`); continue; }
    const xml = await zf.async('string');
    const rowCount = (xml.match(/<row /g) || []).length;
    console.log(`\n${name} (${file}): ${rowCount} rows in XML`);
    // Show snippet of row 6
    const r6 = xml.match(/<row[^>]*r="6"[^>]*>[\s\S]*?<\/row>/);
    if (r6) console.log('  Row 6 snippet:', r6[0].substring(0, 300));
  }
}

main().catch(e => console.error(e));
