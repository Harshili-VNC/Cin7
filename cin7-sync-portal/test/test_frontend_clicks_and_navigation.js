/**
 * End-to-End Frontend Click & Navigation Automated Test Suite
 * Simulates complete browser DOM lifecycle, button click events, view switching,
 * Client Portal tabs, and Super Admin Portal navigation.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

async function runClickTests() {
  console.log('================================================================');
  console.log('🖱️ VNC SAAS HOME SCREEN BUTTONS & NAVIGATION CLICK TEST SUITE');
  console.log('================================================================\n');

  // 1. Verify app.js syntax compiles cleanly
  console.log('--- 1. Frontend JavaScript Syntax & Compilation ---');
  const appJsCode = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  let parseSuccess = false;
  try {
    new Function(appJsCode);
    parseSuccess = true;
  } catch (err) {
    console.error('app.js Parse Error:', err.message);
  }
  assert(parseSuccess === true, 'app.js parses cleanly with 0 syntax errors');

  // 2. Setup mock browser DOM environment
  console.log('\n--- 2. Setting Up Browser DOM Environment ---');
  const htmlCode = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const domElements = {};
  
  const createMockElement = (id = '') => ({
    id,
    classList: {
      classes: new Set(htmlCode.includes(`id="${id}" class="`) ? ['hidden'] : []),
      add(c) { this.classes.add(c); },
      remove(c) { this.classes.delete(c); },
      contains(c) { return this.classes.has(c); },
      toggle(c) { this.classes.has(c) ? this.classes.delete(c) : this.classes.add(c); }
    },
    style: {},
    innerText: '',
    innerHTML: '',
    value: '',
    disabled: false,
    dataset: {},
    appendChild(child) {},
    removeChild(child) {},
    remove() {},
    focus() {},
    blur() {},
    setAttribute() {},
    getAttribute() { return ''; },
    scrollIntoView() {}
  });

  // Extract all IDs from HTML
  const idRegex = /id="([^"]+)"/g;
  let match;
  while ((match = idRegex.exec(htmlCode)) !== null) {
    const id = match[1];
    domElements[id] = createMockElement(id);
  }

  assert(Object.keys(domElements).length > 50, `Extracted ${Object.keys(domElements).length} DOM elements from index.html`);

  // Build global window/document mock
  global.window = {
    open: (url) => { global.window._lastOpenedUrl = url; },
    location: { href: 'http://localhost:8000' },
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  global.document = {
    getElementById: (id) => domElements[id] || (domElements[id] = createMockElement(id)),
    querySelectorAll: (sel) => [],
    querySelector: (sel) => null,
    createElement: (tag) => createMockElement(),
    body: createMockElement('body'),
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  // Mock fetch responses for fast offline test execution
  global.fetch = async (url, options = {}) => {
    if (url.includes('/api/auth/login')) {
      const body = JSON.parse(options.body || '{}');
      const isSuper = body.email === 'superadmin@vnc.global';
      return {
        ok: true,
        json: async () => ({
          success: true,
          user: {
            id: isSuper ? 'user-superadmin' : 'user-hp',
            email: body.email,
            fullName: isSuper ? 'VNC Platform Admin' : 'Harshili Patni',
            role: 'ADMIN',
            platformRole: isSuper ? 'SUPER_ADMIN' : 'USER'
          },
          client: { id: 'client-vnc-master', companyName: 'VNC Global Business Edge Pvt Ltd' }
        })
      };
    }
    if (url.includes('/api/billing')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          plan: { name: 'Professional', code: 'PROFESSIONAL', price: 199, currency: 'USD' },
          status: 'ACTIVE',
          usage: { users: { current: 1, limit: 10 }, syncs: { current: 12, limit: 500 }, storage: { current: 1.2, limit: 25 } }
        })
      };
    }
    return {
      ok: true,
      json: async () => ({ success: true })
    };
  };

  // Load app.js in global simulated browser context
  (0, eval)(appJsCode + '\nglobal.state = state; global.adminState = adminState;');

  assert(typeof navigateTo === 'function', 'navigateTo function is defined');
  assert(typeof quickDemoSignIn === 'function', 'quickDemoSignIn function is defined');
  assert(typeof quickSuperAdminSignIn === 'function', 'quickSuperAdminSignIn function is defined');
  assert(typeof switchReportsSubTab === 'function', 'switchReportsSubTab function is defined');
  assert(typeof switchSettingsTab === 'function', 'switchSettingsTab function is defined');
  assert(typeof switchAdminTab === 'function', 'switchAdminTab function is defined');
  assert(typeof handleLogout === 'function', 'handleLogout function is defined');

  // 3. Test Client Login & Home Screen Navigation
  console.log('\n--- 3. Testing Org Admin Home Screen & Navigation Buttons ---');
  await quickDemoSignIn();
  assert(state.user !== null && state.user.role === 'ADMIN', 'quickDemoSignIn logs in as Org Admin');
  assert(!domElements['dashboard-view'].classList.contains('hidden'), 'Dashboard view is displayed after login');
  assert(domElements['auth-landing-view'].classList.contains('hidden'), 'Auth landing view is hidden');

  // Test Navigation: Reports
  navigateTo('reports');
  assert(!domElements['reports-view'].classList.contains('hidden'), 'Clicking Reports opens Reports view');
  assert(domElements['dashboard-view'].classList.contains('hidden'), 'Dashboard view is hidden when Reports is active');

  // Test Reports Sub-tabs
  switchReportsSubTab('previous');
  assert(!domElements['subview-previous'].classList.contains('hidden'), 'Clicking Previous Reports tab opens Previous Reports subview');

  switchReportsSubTab('history');
  assert(!domElements['subview-history'].classList.contains('hidden'), 'Clicking Sync History tab opens Sync History subview');

  switchReportsSubTab('reconciliation');
  assert(!domElements['subview-reconciliation'].classList.contains('hidden'), 'Clicking Reconciliation tab opens Reconciliation subview');

  // Test Navigation: Settings
  navigateTo('settings');
  assert(!domElements['settings-view'].classList.contains('hidden'), 'Clicking Settings opens Settings view');

  // Test Settings Sub-tabs
  switchSettingsTab('billing');
  assert(!domElements['settings-tab-billing'].classList.contains('hidden'), 'Clicking Billing & Subscription tab opens Billing settings');

  switchSettingsTab('team');
  assert(!domElements['settings-tab-team'].classList.contains('hidden'), 'Clicking Team & Access tab opens Team management');

  switchSettingsTab('security');
  assert(!domElements['settings-tab-security'].classList.contains('hidden'), 'Clicking Security tab opens Security settings');

  switchSettingsTab('advanced');
  assert(!domElements['settings-tab-advanced'].classList.contains('hidden'), 'Clicking Advanced Settings tab opens Advanced settings');

  switchSettingsTab('cin7');
  assert(!domElements['settings-tab-overview'].classList.contains('hidden'), 'Clicking CIN7 Integration tab navigates to CIN7 card in Overview');

  // Test Logout
  await handleLogout();
  assert(state.user === null, 'handleLogout clears active user state');
  assert(!domElements['auth-landing-view'].classList.contains('hidden'), 'Logout transitions back to Auth landing screen');

  // 4. Test Super Admin Login & Super Admin Portal Subviews
  console.log('\n--- 4. Testing Super Admin Sign In & 11 Admin Portal Subviews ---');
  await quickSuperAdminSignIn();
  assert(state.user !== null && state.user.platformRole === 'SUPER_ADMIN', 'quickSuperAdminSignIn logs in as Super Admin');
  assert(!domElements['admin-portal-view'].classList.contains('hidden'), 'Super Admin portal view is displayed');
  assert(!domElements['nav-admin-btn'].classList.contains('hidden'), 'Super Admin navbar badge button is visible');

  // Test All 11 Admin Portal Sidebar Buttons
  const adminTabs = [
    'dashboard',
    'organizations',
    'users',
    'subscriptions',
    'billing',
    'cin7',
    'sheets',
    'sync',
    'usage',
    'audit',
    'health'
  ];

  for (const tab of adminTabs) {
    switchAdminTab(tab);
    const viewEl = domElements[`admin-view-${tab}`];
    assert(viewEl && !viewEl.classList.contains('hidden'), `Admin Portal tab '${tab}' is clickable and opens #admin-view-${tab}`);
  }

  // Test switching back to Client Portal from Admin Portal
  navigateTo('dashboard');
  assert(!domElements['dashboard-view'].classList.contains('hidden'), 'Navigating to Dashboard from Super Admin portal opens Client Dashboard');
  assert(domElements['admin-portal-view'].classList.contains('hidden'), 'Super Admin portal is cleanly hidden');

  // 5. Testing Simplified Onboarding Flow & Form Elements
  console.log('\n--- 5. Testing Simplified Onboarding Flow & Form Elements ---');
  navigateTo('onboarding');
  assert(!domElements['onboarding-view'].classList.contains('hidden'), 'Navigating to onboarding opens #onboarding-view');
  assert(!domElements['onboard-destination'], 'Spreadsheet destination / master template ID is completely removed from DOM');
  assert(domElements['onboard-account-id'] !== undefined, 'Cin7 Core Account ID field is present');
  assert(domElements['onboard-api-key'] !== undefined, 'Cin7 Core API Key field is present');
  assert(domElements['onboard-billing'] !== undefined, 'Billing & Subscription select is present');
  assert(domElements['onboard-sub-key'] !== undefined, 'Subscription Key (Optional) input is present');
  
  // Test submit flow
  domElements['onboard-account-id'].value = 'test-acc-123';
  domElements['onboard-api-key'].value = 'test-key-456';
  await handleOnboardingSubmit({ preventDefault: () => {} });
  assert(state.cin7.connected === true, 'handleOnboardingSubmit successfully connects Cin7 credentials');
  assert(!domElements['dashboard-view'].classList.contains('hidden'), 'Onboarding redirects directly to Dashboard on success');

  // Test returning user view state
  navigateTo('onboarding');
  assert(!domElements['onboard-connected-banner'].classList.contains('hidden'), 'Returning connected user sees clean connected banner');
  toggleOnboardingEdit(true);
  assert(!domElements['onboard-form'].classList.contains('hidden'), 'Toggle edit enables modifying credentials if requested');

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} PASSED | ${failed} FAILED (TOTAL: ${passed + failed})`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runClickTests().catch(err => {
  console.error('Click Test Execution Failure:', err);
  process.exit(1);
});
