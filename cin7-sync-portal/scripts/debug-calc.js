const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

async function checkRows() {
  const credPath = path.resolve('../cin7-sheets/oauth-credentials.json');
  const tokenPath = path.resolve('../cin7-sheets/token.json');
  const rawCreds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const config = rawCreds.installed || rawCreds.web;
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris[0]);
  oauth2Client.setCredentials(token);
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  const spreadsheetId = '1eKsjnWLawao2bwkibOAtJGBOKM8-VLKZbH4v4e_8gl0';

  const rawRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Sales Transactions Raw Data'!A7:Z400"
  });
  const rows = rawRes.data.values || [];
  
  const targetSkus = ['4TB115-P', 'L1001140409', '9CS22-B'];

  targetSkus.forEach(sku => {
    const targetRows = rows.filter(r => r[6] === sku);
    console.log(`\n========================================`);
    console.log(`Product SKU: "${sku}" (${targetRows.length} matching rows)`);
    console.log(`========================================`);
    let sumUnits = 0;
    let sumRev = 0;
    let sumCogs = 0;
    targetRows.forEach((r, i) => {
      const units = parseFloat(r[19] || 0);
      const rev = parseFloat(r[21] || 0);
      const cogs = parseFloat(r[22] || 0);
      sumUnits += units;
      sumRev += rev;
      sumCogs += cogs;
      console.log(`  Row ${i+1}: Order=${r[2]} | Col T (idx 19)=${units} | Col V (idx 21)=${rev} | Col W (idx 22)=${cogs} | Col J=${r[9]}`);
    });
    console.log(`TOTAL SUM: Units=${sumUnits}, Rev=$${sumRev.toFixed(2)}, COGS=$${sumCogs.toFixed(2)}, Profit=$${(sumRev-sumCogs).toFixed(2)}, Margin=${((sumRev-sumCogs)/sumRev*100).toFixed(1)}%`);
  });
}

checkRows().catch(console.error);
