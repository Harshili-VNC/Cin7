const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

const downloadsDir = 'C:\\Users\\Harshili Patni\\OneDrive - VNC Global Business Edge Pvt Ltd\\Downloads';
const cin7File = path.join(downloadsDir, 'Sales by Product Details Report (6).xlsx');
const portalFile = path.join(downloadsDir, 'Controller Reporting - Western Mixers - Synced by VNC Automation - 2026-09-24 11-57-15.xlsx');

function normalizeStr(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function normalizeSku(v) {
  if (v === null || v === undefined) return '';
  let s = String(v).trim();
  if (s.startsWith("'")) s = s.slice(1);
  return s.trim();
}

function normalizeDate(v) {
  if (!v) return '';
  if (v instanceof Date) {
    return v.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  const dreg = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/;
  const m = s.match(dreg);
  if (m) {
    const day = m[1].padStart(2, '0');
    const monMap = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    const month = monMap[m[2]];
    const year = m[3];
    if (month) return `${year}-${month}-${day}`;
  }
  return s.slice(0, 10);
}

function normalizeNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'object' && v.result !== undefined) v = v.result;
  const n = Number(v);
  return isNaN(n) ? 0 : Number(n.toFixed(2));
}

async function run() {
  console.log('Loading Cin7 export:', cin7File);
  const wbCin7 = new ExcelJS.Workbook();
  await wbCin7.xlsx.readFile(cin7File);
  const wsCin7 = wbCin7.worksheets[0];

  // Cin7 headers on Row 6
  // Col 1: Order # | Col 2: SKU | Col 3: Sales representative | Col 4: Invoice date | Col 5: Invoice status | Col 6: Unit | Col 7: Product | Col 8: City | Col 9: Shipment status | Col 10: Order date | Col 11: Customer | Col 12: Profit | Col 13: Journals | Col 14: COGS | Col 15: Tax | Col 16: Quantity | Col 17: Sale | Col 18: Invoice
  const cin7Rows = [];
  for (let r = 7; r <= wsCin7.rowCount; r++) {
    const row = wsCin7.getRow(r);
    const orderNo = normalizeStr(row.getCell(1).value);
    if (!orderNo || orderNo.startsWith('Grand Total')) continue;
    cin7Rows.push({
      rowNum: r,
      orderNo: normalizeStr(row.getCell(1).value),
      sku: normalizeSku(row.getCell(2).value),
      salesRep: normalizeStr(row.getCell(3).value),
      invoiceDate: normalizeDate(row.getCell(4).value),
      invoiceStatus: normalizeStr(row.getCell(5).value).toUpperCase(),
      unit: normalizeStr(row.getCell(6).value),
      product: normalizeStr(row.getCell(7).value),
      city: normalizeStr(row.getCell(8).value),
      shipmentStatus: normalizeStr(row.getCell(9).value),
      orderDate: normalizeDate(row.getCell(10).value),
      customer: normalizeStr(row.getCell(11).value),
      profit: normalizeNum(row.getCell(12).value),
      journals: normalizeNum(row.getCell(13).value),
      cogs: normalizeNum(row.getCell(14).value),
      tax: normalizeNum(row.getCell(15).value),
      qty: normalizeNum(row.getCell(16).value),
      sale: normalizeNum(row.getCell(17).value),
      invoice: normalizeNum(row.getCell(18).value)
    });
  }
  console.log(`Cin7 native rows parsed: ${cin7Rows.length}`);

  console.log('Loading Portal export:', portalFile);
  const wbPortal = new ExcelJS.Workbook();
  await wbPortal.xlsx.readFile(portalFile);
  const wsPortal = wbPortal.getWorksheet('Sales Transactions Raw Data');

  // Correct 1-based indexing for Portal columns:
  // Col 1: Year
  // Col 2: Order Month
  // Col 3: Order #
  // Col 4: Invoice date
  // Col 5: Document #
  // Col 6: SKU
  // Col 7: Product
  // Col 8: Brand
  // Col 9: Category
  // Col 10: Family
  // Col 11: Product tags
  // Col 12: Customer
  // Col 13: Invoice status
  // Col 14: Unit
  // Col 15: Shipment status
  // Col 16: Customer tags
  // Col 17: Sales representative
  // Col 18: Sales Channel
  // Col 19: Quantity
  // Col 20: Invoice
  // Col 21: Sale
  // Col 22: COGS
  // Col 23: Profit less journals
  // Col 24: Journals
  // Col 25: Profit
  // Col 26: Profit %
  // Col 27: Document date
  const portalRows = [];
  for (let r = 7; r <= wsPortal.rowCount; r++) {
    const row = wsPortal.getRow(r);
    const orderNo = normalizeStr(row.getCell(3).value);
    if (!orderNo) continue;
    portalRows.push({
      rowNum: r,
      year: normalizeStr(row.getCell(1).value),
      orderMonth: normalizeStr(row.getCell(2).value),
      orderNo: normalizeStr(row.getCell(3).value),
      invoiceDate: normalizeDate(row.getCell(4).value),
      docNo: normalizeStr(row.getCell(5).value),
      sku: normalizeSku(row.getCell(6).value),
      product: normalizeStr(row.getCell(7).value),
      brand: normalizeStr(row.getCell(8).value),
      category: normalizeStr(row.getCell(9).value),
      family: normalizeStr(row.getCell(10).value),
      productTags: normalizeStr(row.getCell(11).value),
      customer: normalizeStr(row.getCell(12).value),
      invoiceStatus: normalizeStr(row.getCell(13).value).toUpperCase(),
      unit: normalizeStr(row.getCell(14).value),
      shipmentStatus: normalizeStr(row.getCell(15).value),
      customerTags: normalizeStr(row.getCell(16).value),
      salesRep: normalizeStr(row.getCell(17).value),
      salesChannel: normalizeStr(row.getCell(18).value),
      qty: normalizeNum(row.getCell(19).value),
      invoice: normalizeNum(row.getCell(20).value),
      sale: normalizeNum(row.getCell(21).value),
      cogs: normalizeNum(row.getCell(22).value),
      profitLessJournals: normalizeNum(row.getCell(23).value),
      journals: normalizeNum(row.getCell(24).value),
      profit: normalizeNum(row.getCell(25).value),
      margin: normalizeNum(row.getCell(26).value)
    });
  }
  console.log(`Portal rows parsed: ${portalRows.length}`);

  // Summary Totals
  const cin7Totals = cin7Rows.reduce((acc, r) => {
    acc.qty += r.qty;
    acc.sale += r.sale;
    acc.tax += r.tax;
    acc.cogs += r.cogs;
    acc.journals += r.journals;
    acc.profit += r.profit;
    acc.invoice += r.invoice;
    return acc;
  }, { qty: 0, sale: 0, tax: 0, cogs: 0, journals: 0, profit: 0, invoice: 0 });

  const portalTotals = portalRows.reduce((acc, r) => {
    acc.qty += r.qty;
    acc.sale += r.sale;
    acc.cogs += r.cogs;
    acc.journals += r.journals;
    acc.profit += r.profit;
    acc.invoice += r.invoice;
    return acc;
  }, { qty: 0, sale: 0, cogs: 0, journals: 0, profit: 0, invoice: 0 });

  console.log('\n=== TOTALS COMPARISON (CORRECT COLUMN INDEXES) ===');
  console.log('CIN7 NATIVE TOTALS:', cin7Totals);
  console.log('PORTAL TOTALS:', portalTotals);

  function makeKey(r) {
    return `${r.orderNo}___${r.sku}___${r.customer}`;
  }

  const cin7Pool = cin7Rows.map((r, idx) => ({ ...r, cin7Index: idx, matched: false }));
  const portalPool = portalRows.map((r, idx) => ({ ...r, portalIndex: idx, matched: false }));

  const cin7KeyMap = new Map();
  for (const c of cin7Pool) {
    const k = makeKey(c);
    if (!cin7KeyMap.has(k)) cin7KeyMap.set(k, []);
    cin7KeyMap.get(k).push(c);
  }

  const matches = [];
  const fieldMismatches = [];
  const missingInPortal = [];
  const extraInPortal = [];

  // Pass 1: Match Key (Order # + SKU + Customer) + matching Quantity & Sale
  for (const p of portalPool) {
    const k = makeKey(p);
    const candidates = cin7KeyMap.get(k);
    if (candidates && candidates.length > 0) {
      let bestIdx = -1;
      let minDiff = Infinity;
      for (let i = 0; i < candidates.length; i++) {
        if (!candidates[i].matched) {
          const diff = Math.abs(candidates[i].qty - p.qty) + Math.abs(candidates[i].sale - p.sale);
          if (diff < minDiff) {
            minDiff = diff;
            bestIdx = i;
          }
        }
      }
      if (bestIdx !== -1 && minDiff < 0.05) {
        const c = candidates[bestIdx];
        c.matched = true;
        p.matched = true;
        const diffs = [];
        if (Math.abs(c.qty - p.qty) > 0.01) diffs.push({ field: 'Quantity', cin7: c.qty, portal: p.qty });
        if (Math.abs(c.sale - p.sale) > 0.01) diffs.push({ field: 'Sale', cin7: c.sale, portal: p.sale });
        if (Math.abs(c.invoice - p.invoice) > 0.01) diffs.push({ field: 'Invoice', cin7: c.invoice, portal: p.invoice });
        if (Math.abs(c.cogs - p.cogs) > 0.01) diffs.push({ field: 'COGS', cin7: c.cogs, portal: p.cogs });
        if (Math.abs(c.journals - p.journals) > 0.01) diffs.push({ field: 'Journals', cin7: c.journals, portal: p.journals });
        if (Math.abs(c.profit - p.profit) > 0.01) diffs.push({ field: 'Profit', cin7: c.profit, portal: p.profit });
        if (c.invoiceDate !== p.invoiceDate) diffs.push({ field: 'InvoiceDate', cin7: c.invoiceDate, portal: p.invoiceDate });
        
        if (diffs.length === 0) {
          matches.push({ type: 'MATCH', cin7: c, portal: p });
        } else {
          fieldMismatches.push({ type: 'FIELD_VALUE_MISMATCH', cin7: c, portal: p, diffs });
        }
      }
    }
  }

  // Pass 2: Match remaining in Order # + SKU
  for (const p of portalPool) {
    if (p.matched) continue;
    const k = makeKey(p);
    const candidates = cin7KeyMap.get(k);
    if (candidates) {
      const unmatchedCandidate = candidates.find(c => !c.matched);
      if (unmatchedCandidate) {
        unmatchedCandidate.matched = true;
        p.matched = true;
        const diffs = [];
        if (Math.abs(unmatchedCandidate.qty - p.qty) > 0.01) diffs.push({ field: 'Quantity', cin7: unmatchedCandidate.qty, portal: p.qty });
        if (Math.abs(unmatchedCandidate.sale - p.sale) > 0.01) diffs.push({ field: 'Sale', cin7: unmatchedCandidate.sale, portal: p.sale });
        if (Math.abs(unmatchedCandidate.invoice - p.invoice) > 0.01) diffs.push({ field: 'Invoice', cin7: unmatchedCandidate.invoice, portal: p.invoice });
        if (Math.abs(unmatchedCandidate.cogs - p.cogs) > 0.01) diffs.push({ field: 'COGS', cin7: unmatchedCandidate.cogs, portal: p.cogs });
        if (Math.abs(unmatchedCandidate.journals - p.journals) > 0.01) diffs.push({ field: 'Journals', cin7: unmatchedCandidate.journals, portal: p.journals });
        if (Math.abs(unmatchedCandidate.profit - p.profit) > 0.01) diffs.push({ field: 'Profit', cin7: unmatchedCandidate.profit, portal: p.profit });
        if (unmatchedCandidate.invoiceDate !== p.invoiceDate) diffs.push({ field: 'InvoiceDate', cin7: unmatchedCandidate.invoiceDate, portal: p.invoiceDate });
        fieldMismatches.push({ type: 'FIELD_VALUE_MISMATCH', cin7: unmatchedCandidate, portal: p, diffs });
      }
    }
  }

  // Unmatched
  for (const p of portalPool) {
    if (!p.matched) extraInPortal.push(p);
  }
  for (const c of cin7Pool) {
    if (!c.matched) missingInPortal.push(c);
  }

  console.log('\n=== RECONCILIATION SUMMARY ===');
  console.log(`Total Cin7 records: ${cin7Pool.length}`);
  console.log(`Total Portal records: ${portalPool.length}`);
  console.log(`Exact Matches: ${matches.length}`);
  console.log(`Field Mismatches: ${fieldMismatches.length}`);
  console.log(`Missing in Portal: ${missingInPortal.length}`);
  console.log(`Extra in Portal: ${extraInPortal.length}`);

  // Breakdown of Field Mismatches
  const mismatchFieldsCount = {};
  fieldMismatches.forEach(m => {
    m.diffs.forEach(d => {
      mismatchFieldsCount[d.field] = (mismatchFieldsCount[d.field] || 0) + 1;
    });
  });
  console.log('\nMismatch breakdown by field:', mismatchFieldsCount);

  // Breakdown of Missing rows by reason / SKU pattern
  const missingByReason = { shipping: 0, zeroSKU: 0, dateOutOfRange: 0, other: 0 };
  missingInPortal.forEach(m => {
    if (m.sku.toLowerCase().includes('shipping') || m.sku.toLowerCase().includes('ups') || m.sku.toLowerCase().includes('freight')) {
      missingByReason.shipping++;
    } else if (!m.sku) {
      missingByReason.zeroSKU++;
    } else {
      missingByReason.other++;
    }
  });
  console.log('\nMissing in portal breakdown:', missingByReason);

  // Breakdown of Extra rows in Portal
  const extraByStatus = {};
  extraInPortal.forEach(e => {
    extraByStatus[e.invoiceStatus] = (extraByStatus[e.invoiceStatus] || 0) + 1;
  });
  console.log('\nExtra in portal breakdown by Invoice Status:', extraByStatus);

  fs.writeFileSync('reconciliation_full_results.json', JSON.stringify({
    cin7Totals,
    portalTotals,
    summary: {
      totalCin7: cin7Pool.length,
      totalPortal: portalPool.length,
      exactMatches: matches.length,
      fieldMismatches: fieldMismatches.length,
      missingInPortal: missingInPortal.length,
      extraInPortal: extraInPortal.length
    },
    mismatchFieldsCount,
    missingByReason,
    extraByStatus,
    missingInPortal: missingInPortal,
    extraInPortal: extraInPortal,
    fieldMismatches: fieldMismatches
  }, null, 2));

  console.log('\nResults saved to reconciliation_full_results.json');
}

run().catch(console.error);
