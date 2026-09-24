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
  if (v instanceof Date) return v.toISOString().slice(0, 10);
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
  const wbCin7 = new ExcelJS.Workbook();
  await wbCin7.xlsx.readFile(cin7File);
  const wsCin7 = wbCin7.worksheets[0];

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

  const wbPortal = new ExcelJS.Workbook();
  await wbPortal.xlsx.readFile(portalFile);
  const wsPortal = wbPortal.getWorksheet('Sales Transactions Raw Data');

  const portalRows = [];
  for (let r = 7; r <= wsPortal.rowCount; r++) {
    const row = wsPortal.getRow(r);
    const orderNo = normalizeStr(row.getCell(3).value);
    if (!orderNo) continue;
    portalRows.push({
      rowNum: r,
      year: normalizeStr(row.getCell(1).value),
      month: normalizeStr(row.getCell(2).value),
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
      // In current portal export:
      // Col 20: Qty, Col 21: Invoice, Col 22: Sale, Col 23: COGS, Col 24: Profit less journals, Col 25: Journals, Col 26: Profit
      qty: normalizeNum(row.getCell(20).value),
      invoice: normalizeNum(row.getCell(21).value),
      sale: normalizeNum(row.getCell(22).value),
      cogs: normalizeNum(row.getCell(23).value),
      profitLessJournals: normalizeNum(row.getCell(24).value),
      journals: normalizeNum(row.getCell(25).value),
      profit: normalizeNum(row.getCell(26).value)
    });
  }

  console.log(`Cin7 count: ${cin7Rows.length}, Portal count: ${portalRows.length}`);

  // Categorization
  const categories = {
    MATCH: [],
    MISSING_IN_PORTAL: [],
    EXTRA_IN_PORTAL: [],
    FIELD_VALUE_MISMATCH: [],
    DATE_MISMATCH: [],
    STATUS_MISMATCH: [],
    SKU_MISMATCH: [],
    CREDIT_NOTE_MISMATCH: [],
    CALCULATION_MISMATCH: []
  };

  const cin7Pool = cin7Rows.map((r, i) => ({ ...r, idx: i, matched: false }));
  const portalPool = portalRows.map((r, i) => ({ ...r, idx: i, matched: false }));

  // Index Cin7 rows by Order #
  const cin7ByOrder = new Map();
  for (const c of cin7Pool) {
    if (!cin7ByOrder.has(c.orderNo)) cin7ByOrder.set(c.orderNo, []);
    cin7ByOrder.get(c.orderNo).push(c);
  }

  // Pass 1: Exact match on Order # + SKU + Qty + Sale
  for (const p of portalPool) {
    const orderCand = cin7ByOrder.get(p.orderNo);
    if (!orderCand) continue;
    const match = orderCand.find(c => !c.matched && c.sku === p.sku && Math.abs(c.qty - p.qty) < 0.01 && Math.abs(c.sale - p.sale) < 0.05);
    if (match) {
      match.matched = true;
      p.matched = true;
      // Compare rest of fields
      const diffs = [];
      if (Math.abs(match.invoice - p.invoice) > 0.05) diffs.push({ field: 'Invoice', cin7: match.invoice, portal: p.invoice });
      if (Math.abs(match.cogs - p.cogs) > 0.05) diffs.push({ field: 'COGS', cin7: match.cogs, portal: p.cogs });
      if (Math.abs(match.journals - p.journals) > 0.05) diffs.push({ field: 'Journals', cin7: match.journals, portal: p.journals });
      if (Math.abs(match.profit - p.profit) > 0.05) diffs.push({ field: 'Profit', cin7: match.profit, portal: p.profit });
      if (match.invoiceDate !== p.invoiceDate) diffs.push({ field: 'InvoiceDate', cin7: match.invoiceDate, portal: p.invoiceDate });
      if (match.invoiceStatus !== p.invoiceStatus) diffs.push({ field: 'InvoiceStatus', cin7: match.invoiceStatus, portal: p.invoiceStatus });

      if (diffs.length === 0) {
        categories.MATCH.push({ cin7: match, portal: p });
      } else {
        const isDateMismatch = diffs.every(d => d.field === 'InvoiceDate');
        const isStatusMismatch = diffs.every(d => d.field === 'InvoiceStatus');
        const isCalcMismatch = diffs.some(d => d.field === 'COGS' || d.field === 'Journals' || d.field === 'Profit');
        
        if (isDateMismatch) categories.DATE_MISMATCH.push({ cin7: match, portal: p, diffs });
        else if (isStatusMismatch) categories.STATUS_MISMATCH.push({ cin7: match, portal: p, diffs });
        else if (isCalcMismatch) categories.CALCULATION_MISMATCH.push({ cin7: match, portal: p, diffs });
        else categories.FIELD_VALUE_MISMATCH.push({ cin7: match, portal: p, diffs });
      }
    }
  }

  // Pass 2: Match remaining rows within the same Order # by SKU or Qty
  for (const p of portalPool) {
    if (p.matched) continue;
    const orderCand = cin7ByOrder.get(p.orderNo);
    if (!orderCand) continue;
    // Check if same SKU
    let match = orderCand.find(c => !c.matched && c.sku === p.sku);
    if (match) {
      match.matched = true;
      p.matched = true;
      const diffs = [
        { field: 'Quantity', cin7: match.qty, portal: p.qty },
        { field: 'Sale', cin7: match.sale, portal: p.sale }
      ];
      if (p.docNo.startsWith('CR-') || match.invoiceStatus.includes('CREDIT')) {
        categories.CREDIT_NOTE_MISMATCH.push({ cin7: match, portal: p, diffs });
      } else {
        categories.FIELD_VALUE_MISMATCH.push({ cin7: match, portal: p, diffs });
      }
      continue;
    }
    // Check if SKU mismatch in same order
    match = orderCand.find(c => !c.matched && Math.abs(c.qty - p.qty) < 0.01 && Math.abs(c.sale - p.sale) < 0.05);
    if (match) {
      match.matched = true;
      p.matched = true;
      categories.SKU_MISMATCH.push({ cin7: match, portal: p, diffs: [{ field: 'SKU', cin7: match.sku, portal: p.sku }] });
    }
  }

  // Pass 3: Unmatched rows
  for (const c of cin7Pool) {
    if (!c.matched) {
      categories.MISSING_IN_PORTAL.push(c);
    }
  }
  for (const p of portalPool) {
    if (!p.matched) {
      categories.EXTRA_IN_PORTAL.push(p);
    }
  }

  console.log('\n=== COMPLETE 9-WAY CLASSIFICATION ===');
  for (const [k, v] of Object.entries(categories)) {
    console.log(`${k}: ${v.length}`);
  }

  fs.writeFileSync('reconciliation_9way_breakdown.json', JSON.stringify(categories, null, 2));
}

run().catch(console.error);
