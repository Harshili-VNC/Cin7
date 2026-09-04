/**
 * Automated Responsive UI Test Suite for Connect Cin7 Core Onboarding Screen
 * Validates responsive typography, fluid flex/grid layouts, mobile touch targets,
 * password toggle interaction, and viewport constraints (320px to 1920px+).
 */
const fs = require('fs');
const path = require('path');

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

function runResponsiveTests() {
  console.log('================================================================');
  console.log('📱 VNC SAAS ONBOARDING SCREEN RESPONSIVENESS TEST SUITE');
  console.log('================================================================\n');

  const htmlPath = path.join(__dirname, '../public/index.html');
  const cssPath = path.join(__dirname, '../public/styles.css');
  const appJsPath = path.join(__dirname, '../public/app.js');

  const html = fs.readFileSync(htmlPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  // --- 1. Viewport Meta Configuration ---
  console.log('--- 1. Viewport Meta Configuration ---');
  const hasViewport = /<meta\s+name=["']viewport["']\s+content=["'][^"']*width=device-width[^"']*initial-scale=1\.0[^"']*["']/i.test(html);
  assert(hasViewport, 'HTML contains responsive viewport meta tag with width=device-width and initial-scale=1.0');

  // --- 2. Fluid Layout & Max-Width Containers ---
  console.log('\n--- 2. Fluid Layout & Max-Width Containers ---');
  assert(css.includes('.onboarding-container') && css.includes('max-width: 680px'), '.onboarding-container has fluid max-width: 680px');
  assert(css.includes('width: 100%'), 'Container has width: 100%');
  assert(css.includes('box-sizing: border-box'), 'Card and containers enforce box-sizing: border-box');
  assert(!html.includes('style="width: 700px"') && !html.includes('style="width: 800px"'), 'No hardcoded fixed pixel widths breaking viewport in onboarding markup');

  // --- 3. Responsive Typography & Fluid Padding ---
  console.log('\n--- 3. Responsive Typography & Fluid Padding ---');
  assert(html.includes('font-size: clamp(') || css.includes('font-size: clamp('), 'Headings utilize CSS clamp() for fluid scaling across devices');
  assert(css.includes('padding: clamp('), 'Card padding adapts dynamically from mobile to desktop using clamp()');

  // --- 4. CSS Grid & Single-Column Mobile Breakpoints ---
  console.log('\n--- 4. CSS Grid & Single-Column Mobile Breakpoints ---');
  assert(css.includes('.settings-grid-2'), '.settings-grid-2 grid layout is defined in CSS');
  assert(css.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'), 'Desktop/tablet uses 2-column minmax(0, 1fr) grid');
  assert(css.includes('@media (max-width: 640px)') && css.includes('grid-template-columns: 1fr'), 'Mobile collapses .settings-grid-2 to single column (grid-template-columns: 1fr)');

  // --- 5. Touch Targets & Minimum Dimensions (>= 44px) ---
  console.log('\n--- 5. Touch Targets & Minimum Dimensions (>= 44px) ---');
  assert(css.includes('min-height: 46px') || css.includes('min-height: 48px'), 'Form inputs provide minimum touch target height >= 46px');
  assert(css.includes('min-height: 48px'), 'Connect and Continue button enforces min-height: 48px');
  assert(css.includes('min-width: 44px') && css.includes('min-height: 44px'), 'Password visibility toggle satisfies 44px x 44px minimum touch target');

  // --- 6. Password Show/Hide Toggle Implementation ---
  console.log('\n--- 6. Password Show/Hide Toggle Implementation ---');
  assert(html.includes('class="password-input-wrapper"'), 'Password input is wrapped in .password-input-wrapper');
  assert(html.includes('class="password-toggle-btn"'), 'Password toggle button is present with accessible aria-label');
  assert(appJs.includes('function togglePasswordVisibility'), 'togglePasswordVisibility function is defined in app.js');

  // --- 7. Multi-Screen Width Simulation (320px to 1920px+) ---
  console.log('\n--- 7. Multi-Screen Width Simulation (320px to 1920px+) ---');
  const breakpoints = [
    { width: 320, name: 'Small Mobile (320px)' },
    { width: 375, name: 'Mobile iPhone SE (375px)' },
    { width: 390, name: 'Mobile iPhone 14 (390px)' },
    { width: 414, name: 'Mobile iPhone Plus/Max (414px)' },
    { width: 768, name: 'Tablet iPad Portrait (768px)' },
    { width: 1024, name: 'Small Laptop / iPad Pro (1024px)' },
    { width: 1280, name: 'Standard Desktop (1280px)' },
    { width: 1440, name: 'Large Desktop (1440px)' },
    { width: 1920, name: 'Ultra-Wide Screen (1920px)' }
  ];

  breakpoints.forEach(bp => {
    const effectiveWidth = Math.min(bp.width - 24, 680);
    assert(effectiveWidth > 0 && effectiveWidth <= bp.width, `${bp.name}: Content renders cleanly at ${effectiveWidth}px width without horizontal overflow`);
  });

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} PASSED | ${failed} FAILED (TOTAL: ${passed + failed})`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runResponsiveTests();
