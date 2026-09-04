const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
require('dotenv').config();

const spreadsheetId = process.env.VERIFY_SPREADSHEET_ID || '1Oo_fQJ_fOHIRkV4W1Cdmml2GiYbXIrn4gxuG6ahGHYw';

function number(value) {
  const parsed = Number(String(value ?? '').replace(/[$,% ,]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function main() {
  const credPath = path.resolve('../cin7-sheets/oauth-credentials.json');
  const tokenPath = path.resolve('../cin7-sheets/token.json');
  const rawCreds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const config = rawCreds.installed || rawCreds.web;
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  const auth = new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris[0]);
  auth.setCredentials(token);
  const sheets = google.sheets({ version: 'v4', auth });

  const [rawRead, marginRead, channelRead] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId, range: "'Sales Transactions Raw Data'!A7:Z5000" }),
    sheets.spreadsheets.values.get({ spreadsheetId, range: "'Product Margin Analysis'!A5:H10", valueRenderOption: 'UNFORMATTED_VALUE' }),
    sheets.spreadsheets.values.get({ spreadsheetId, range: "'COGS & Profitability by Channel'!A5:M19", valueRenderOption: 'UNFORMATTED_VALUE' })
  ]);

  const rawRows = rawRead.data.values || [];
  const grouped = {};
  for (const row of rawRows) {
    const sku = row[5];
    if (!sku || /^SO[-_]/i.test(String(sku))) continue;
    if (!grouped[sku]) grouped[sku] = { sku, units: 0, revenue: 0, cogs: 0, profit: 0, name: row[6] };
    grouped[sku].units += number(row[19]);
    grouped[sku].revenue += number(row[21]);
    grouped[sku].cogs += number(row[22]);
    grouped[sku].profit += number(row[24]);
  }

  const topThree = Object.values(grouped).sort((a, b) => b.revenue - a.revenue).slice(0, 3);
  const marginRows = marginRead.data.values || [];
  const marginBySku = Object.fromEntries(marginRows.map(row => [row[0], row]));
  const channelRows = channelRead.data.values || [];
  const channelLabels = channelRows.map(row => row[0]).filter(Boolean);
  console.log(`Channel raw labels: ${JSON.stringify(channelRows.map(row => row[0]))}`);
  console.log(`Top three SKUs: ${topThree.map(product => product.sku).join(', ')}`);

  assert(rawRows.length > 0, 'Fresh sheet contains raw Cin7 sales rows');
  assert(topThree.length === 3, 'At least three real product SKUs are present');
  assert(channelLabels.length >= 6, 'Channel report contains product identifier rows');

  console.log(`Spreadsheet: ${spreadsheetId}`);
  console.log(`Raw product-line rows: ${rawRows.length}`);
  console.log('\nSKU reconciliation (raw tab -> Product Margin Analysis):');
  for (const expected of topThree) {
    const actual = marginBySku[expected.sku];
    assert(actual, `Margin report contains SKU ${expected.sku}`);
    const expectedMargin = expected.revenue > 0 ? expected.profit / expected.revenue : 0;
    const checks = [
      ['Units', expected.units, number(actual[1])],
      ['Revenue', expected.revenue, number(actual[2])],
      ['COGS', expected.cogs, number(actual[3])],
      ['Gross Profit', expected.profit, number(actual[4])],
      ['Margin %', expectedMargin * 100, number(actual[5]) * 100]
    ];
    checks.forEach(([label, expectedValue, actualValue]) => {
      const tolerance = label === 'Margin %' ? 0.05 : 0.02;
      assert(Math.abs(expectedValue - actualValue) < tolerance, `${expected.sku} ${label}: ${expectedValue.toFixed(2)} == ${actualValue.toFixed(2)}`);
    });
    console.log(`${expected.sku} (${expected.name}): raw Units=${expected.units}, Revenue=${expected.revenue.toFixed(2)}, COGS=${expected.cogs.toFixed(2)}, Gross Profit=${expected.profit.toFixed(2)}, Margin %=${(expectedMargin * 100).toFixed(2)}; sheet Units=${number(actual[1])}, Revenue=${number(actual[2]).toFixed(2)}, COGS=${number(actual[3]).toFixed(2)}, Gross Profit=${number(actual[4]).toFixed(2)}, Margin %=${(number(actual[5]) * 100).toFixed(2)}`);
  }

  assert(channelLabels.every(label => !/^SO[-_]/i.test(String(label))), 'COGS & Profitability by Channel labels use product identifiers, not Sales Order IDs');
  const normalizedChannelLabels = channelLabels.map(label => String(label));
  assert(topThree.every(product => normalizedChannelLabels.includes(String(product.sku))), 'COGS & Profitability by Channel includes the actual top product identifiers');
  console.log(`Channel identifiers checked: ${channelLabels.slice(0, 6).join(', ')}`);
  console.log('\nPASS: live Product Margin Analysis and channel identifiers reconcile to the fresh raw Cin7 line data.');
}

main().catch(error => {
  console.error('FAIL:', error.message);
  process.exit(1);
});
