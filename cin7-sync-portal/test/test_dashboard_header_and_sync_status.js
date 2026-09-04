/**
 * VNC CIN7 SYNC — DASHBOARD HEADER & SYNC STATUS SECTION TEST SUITE
 * Validates company name hierarchy, reporting model subtitle, report-window dropdown,
 * and 4 distinct dynamic sync states (SUCCESS, SYNCING, ERROR, NEVER_SYNCED).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');
const appJsCode = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function runTests() {
  console.log('================================================================');
  console.log('📊 VNC DASHBOARD HEADER & SYNC STATUS SECTION TEST SUITE');
  console.log('================================================================\n');

  let passed = 0;
  let total = 0;

  function test(desc, fn) {
    total++;
    try {
      fn();
      console.log(`  ✅ PASS: ${desc}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${desc}`);
      console.error(`     Error: ${err.message}\n`);
    }
  }

  // --- 1. DOM Hierarchy & Company Header Elements ---
  console.log('--- 1. Company / Report Header Structure ---');
  
  test('Dashboard contains prominent company name header element (#dashboard-company-name)', () => {
    assert(html.includes('id="dashboard-company-name"'), 'Element #dashboard-company-name exists');
  });

  test('Dashboard contains dynamic report model subtitle (#dashboard-report-subtitle)', () => {
    assert(html.includes('id="dashboard-report-subtitle"'), 'Element #dashboard-report-subtitle exists');
    assert(html.includes('Monthly Controller Reporting Master Model'), 'Contains model title');
  });

  test('Dashboard displays live model metadata badges (14 Master Sheets, Cin7 Core, Google Sheets)', () => {
    assert(html.includes('14 Master Sheets'), 'Contains 14 Master Sheets badge');
    assert(html.includes('Cin7 Core Connected'), 'Contains Cin7 Core Connected badge');
    assert(html.includes('Sheets &amp; Excel Live') || html.includes('Sheets & Excel Live'), 'Contains Sheets & Excel Live badge');
  });

  // --- 2. Report Window Selector ---
  console.log('\n--- 2. Date / Report Window Selector ---');

  test('Sync status bar contains report window dropdown (#sync-timeline-select)', () => {
    assert(html.includes('id="sync-timeline-select"'), '#sync-timeline-select element exists');
  });

  test('Report window selector contains 30d, 90d, 365d, 7d, ytd, all options', () => {
    assert(html.includes('value="30d"'), 'Contains 30d');
    assert(html.includes('value="90d"'), 'Contains 90d');
    assert(html.includes('value="365d"'), 'Contains 365d');
    assert(html.includes('value="7d"'), 'Contains 7d');
    assert(html.includes('value="ytd"'), 'Contains ytd');
    assert(html.includes('value="all"'), 'Contains all');
  });

  test('Report window selector has custom dropdown chevron SVG', () => {
    assert(html.includes('select-chevron-icon'), 'select-chevron-icon SVG is rendered');
  });

  // --- 3. Dynamic Sync Status Bar Rendering in app.js ---
  console.log('\n--- 3. Dynamic Sync State Component (SUCCESS, SYNCING, ERROR, NEVER_SYNCED) ---');

  // Set up mock browser environment
  const mockElements = {};
  function createMockElement(id = '', tag = 'div') {
    return {
      id,
      tagName: tag.toUpperCase(),
      innerText: '',
      innerHTML: '',
      className: '',
      classList: {
        add: () => {},
        remove: () => {},
        contains: () => false
      },
      style: {},
      disabled: false,
      value: '30d',
      options: [{ value: '30d', text: 'Last 30 days' }],
      selectedIndex: 0,
      querySelector: () => null,
      querySelectorAll: () => []
    };
  }

  global.window = { location: { origin: 'http://localhost:2005' }, addEventListener: () => {} };
  global.document = {
    getElementById: (id) => {
      if (!mockElements[id]) mockElements[id] = createMockElement(id);
      return mockElements[id];
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {}
  };

  (0, eval)(appJsCode + '\nglobal.state = state; global.renderSyncStatusBar = renderSyncStatusBar; global.handleTimelineChange = handleTimelineChange; global.updateDashboardData = updateDashboardData;');

  test('renderSyncStatusBar handles SUCCESS state with humanized last synced time', () => {
    renderSyncStatusBar('SUCCESS', { lastSyncAt: new Date(Date.now() - 120000).toISOString() });
    const container = document.getElementById('sync-state-display');
    assert(container.innerHTML.includes('Synced successfully'), 'Displays Synced successfully');
    assert(container.innerHTML.includes('2 mins ago') || container.innerHTML.includes('Just now'), 'Displays humanized relative time');
  });

  test('renderSyncStatusBar handles SYNCING state with rotating spinner and live stage detail', () => {
    renderSyncStatusBar('SYNCING', { message: 'Enriching Sales Orders (45/269)...' });
    const container = document.getElementById('sync-state-display');
    assert(container.innerHTML.includes('Syncing in progress...'), 'Displays Syncing in progress');
    assert(container.innerHTML.includes('Enriching Sales Orders (45/269)...'), 'Displays live stage detail message');
    assert(container.innerHTML.includes('rotating'), 'Applies rotating CSS animation class');
  });

  test('renderSyncStatusBar handles ERROR state with dynamic error and Retry Sync button', () => {
    renderSyncStatusBar('ERROR', { errorDetail: 'Server connection unavailable.' });
    const container = document.getElementById('sync-state-display');
    assert(container.innerHTML.includes('Sync failed'), 'Displays Sync failed');
    assert(container.innerHTML.includes('Server connection unavailable.'), 'Displays dynamic backend error');
    assert(container.innerHTML.includes('Retry Sync'), 'Displays Retry Sync button');
    assert(container.innerHTML.includes('triggerSyncFlow()'), 'Retry button is hooked to triggerSyncFlow()');
  });

  test('renderSyncStatusBar handles NEVER_SYNCED state with informative setup prompt', () => {
    renderSyncStatusBar('NEVER_SYNCED');
    const container = document.getElementById('sync-state-display');
    assert(container.innerHTML.includes('Not synced yet'), 'Displays Not synced yet');
    assert(container.innerHTML.includes('Run your first sync'), 'Displays prompt to run initial sync');
  });

  // --- 4. Dynamic Company Name from Authenticated Session ---
  console.log('\n--- 4. Authenticated Session & Dynamic Company Name ---');

  test('updateDashboardData updates company name from state.client.companyName', () => {
    state.client = { id: 'client-acme-prod', companyName: 'Acme Global Enterprise Inc.' };
    state.user = { email: 'controller@acme.com', fullName: 'Jane Controller' };
    updateDashboardData();
    const companyEl = document.getElementById('dashboard-company-name');
    assert.strictEqual(companyEl.innerText, 'Acme Global Enterprise Inc.');
  });

  test('updateDashboardData populates client identifier pill', () => {
    const clientPill = document.getElementById('dashboard-client-id');
    assert.strictEqual(clientPill.innerText, 'client-acme-prod');
  });

  // --- 5. Responsive CSS Design & Breakpoints ---
  console.log('\n--- 5. CSS Responsive Design & Mobile Breakpoints ---');

  test('CSS defines .dashboard-hero-header with fluid typography and padding', () => {
    assert(css.includes('.dashboard-hero-header'), '.dashboard-hero-header is defined in CSS');
    assert(css.includes('.dashboard-company-title'), '.dashboard-company-title is defined in CSS');
    assert(css.includes('clamp('), 'Uses CSS clamp() for fluid scaling');
  });

  test('CSS defines .sync-status-bar-card and .sync-status-bar-inner', () => {
    assert(css.includes('.sync-status-bar-card'), '.sync-status-bar-card is defined');
    assert(css.includes('.sync-status-bar-inner'), '.sync-status-bar-inner is defined');
  });

  test('CSS provides responsive flex column wrap on mobile viewports for sync status bar', () => {
    assert(css.includes('@media (min-width: 960px)'), 'Desktop 960px+ media query exists for row alignment');
    assert(css.includes('@media (max-width: 640px)'), 'Mobile 640px media query exists');
  });

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} PASSED | ${total - passed} FAILED (TOTAL: ${total})`);
  console.log('================================================================\n');

  if (passed !== total) {
    process.exit(1);
  }
}

runTests();
