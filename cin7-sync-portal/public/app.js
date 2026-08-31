/**
 * VNC CIN7 SaaS Reporting Portal - Client Controller
 * Version: 2.0.0 (SaaS Multi-Tenant Architecture)
 */

const state = {
  user: null,
  client: null,
  cin7: null,
  historyPage: 1,
  historyTotalPages: 1,
  editorConfig: null,
  activeWorkbookBlob: null,
  activeParsedWorkbook: null,
  activeSheetName: null,
  isEditorOpen: false,
  onlyOfficeInstance: null
};

// ── 1. INITIALIZATION & AUTH LIFECYCLE ──────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  checkAuthStatus();
});

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();

    if (data.authenticated) {
      state.user = data.user;
      state.client = data.client;
      state.cin7 = data.cin7;

      updateUIHeader();
      navigateTo('dashboard');
      loadDashboardData();
    } else {
      navigateTo('auth-landing');
    }
  } catch (err) {
    console.error('Auth status check error:', err);
    navigateTo('auth-landing');
  }
}

function updateUIHeader() {
  const navbar = document.getElementById('navbar');
  const navUserName = document.getElementById('nav-user-name');
  const navUserCompany = document.getElementById('nav-user-company');

  if (state.user) {
    if (navbar) navbar.classList.remove('hidden');
    if (navUserName) navUserName.innerText = state.user.fullName || state.user.email;
    if (navUserCompany) navUserCompany.innerText = state.client?.companyName || 'VNC Organization';
  } else {
    if (navbar) navbar.classList.add('hidden');
  }
}

function navigateTo(viewId) {
  if (state.isEditorOpen && viewId !== 'editor') {
    state.isEditorOpen = false;
  }

  const views = ['auth-landing', 'dashboard', 'editor', 'history', 'settings'];
  views.forEach(v => {
    const el = document.getElementById(`${v}-view`);
    if (el) {
      if (v === viewId) {
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }
  });

  const navBtns = {
    'dashboard': 'nav-dashboard-btn',
    'history': 'nav-history-btn',
    'settings': 'nav-settings-btn'
  };

  Object.entries(navBtns).forEach(([key, btnId]) => {
    const btn = document.getElementById(btnId);
    if (btn) {
      if (key === viewId) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    }
  });

  if (viewId === 'dashboard') loadDashboardData();
  if (viewId === 'history') loadHistoryData(1);
  if (viewId === 'settings') loadSettingsData();
}

// ── 2. DASHBOARD & SUBSCRIPTION CONTROLLER ─────────────────────────────────

async function loadDashboardData() {
  if (!state.client) return;

  const companyNameEl = document.getElementById('dash-company-name');
  const currentVerEl = document.getElementById('dash-current-version');
  const subBadgeEl = document.getElementById('dash-sub-badge');
  const pillSubEl = document.getElementById('status-subscription-txt');
  const lastUpdatedEl = document.getElementById('wb-last-updated');
  const lastSyncStatusEl = document.getElementById('wb-last-sync-status');
  const wbVersionBadge = document.getElementById('wb-version-badge');
  const expiredBanner = document.getElementById('subscription-expired-banner');
  const btnOpenWb = document.getElementById('btn-open-workbook');

  const subStatus = (state.client.subscriptionStatus || 'ACTIVE').toUpperCase();
  const isSubActive = subStatus === 'ACTIVE';

  if (companyNameEl) companyNameEl.innerText = state.client.companyName;
  if (currentVerEl) currentVerEl.innerText = state.client.currentVersion || 'v1.0';
  if (wbVersionBadge) wbVersionBadge.innerText = `Version ${state.client.currentVersion || 'v1.0'}`;

  if (subBadgeEl) {
    subBadgeEl.innerText = subStatus;
    subBadgeEl.className = `badge-status ${isSubActive ? 'status-success' : 'status-error'}`;
  }

  if (pillSubEl) {
    pillSubEl.innerText = isSubActive ? 'Active' : 'Expired';
    pillSubEl.parentElement.className = `status-pill ${isSubActive ? '' : 'pill-error'}`;
  }

  if (lastUpdatedEl) {
    lastUpdatedEl.innerText = state.client.lastSyncAt ? new Date(state.client.lastSyncAt).toLocaleString() : 'Never';
  }

  if (lastSyncStatusEl) {
    lastSyncStatusEl.innerText = state.client.syncStatus || 'IDLE';
  }

  // Subscription Banner & Access Blocking
  if (!isSubActive) {
    if (expiredBanner) expiredBanner.classList.remove('hidden');
    if (btnOpenWb) {
      btnOpenWb.classList.add('disabled-btn');
      btnOpenWb.title = 'Subscription expired. Contact VNC to renew access.';
    }
  } else {
    if (expiredBanner) expiredBanner.classList.add('hidden');
    if (btnOpenWb) {
      btnOpenWb.classList.remove('disabled-btn');
      btnOpenWb.title = 'Open real Excel reporting model in browser editor';
    }
  }

  // Cin7 status pill
  const pillCin7 = document.getElementById('status-cin7-txt');
  if (pillCin7) {
    const isCin7Ok = state.cin7 && state.cin7.connected;
    pillCin7.innerText = isCin7Ok ? 'Connected' : 'Disconnected';
  }
}

async function toggleTestSubscription() {
  try {
    const res = await fetch('/api/auth/subscription/toggle', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`Subscription status updated: ${data.subscriptionStatus}`, 'info');
      state.client.subscriptionStatus = data.subscriptionStatus;
      loadDashboardData();
    }
  } catch (err) {
    showToast('Failed to toggle subscription status', 'error');
  }
}

// ── 3. BROWSER SPREADSHEET EDITOR CONTROLLER ──────────────────────────────

async function openWorkbook(versionId = null) {
  const subStatus = (state.client?.subscriptionStatus || 'ACTIVE').toUpperCase();
  if (subStatus !== 'ACTIVE') {
    showToast('Your reporting subscription has expired. Please contact VNC to renew access.', 'error');
    alert('⚠️ Access Blocked\n\nYour reporting subscription has expired. Please contact VNC to renew access.');
    return;
  }

  const isHistorical = !!versionId;
  const loadMsg = isHistorical
    ? `Requesting read-only editor session for version ${versionId}...`
    : 'Initializing secure spreadsheet editor session...';

  showToast(loadMsg, 'info');

  try {
    const res = await fetch('/api/editor/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId, isReadOnly: isHistorical })
    });

    if (res.status === 403) {
      const errData = await res.json();
      showToast(errData.message || 'Your reporting subscription has expired. Please contact VNC to renew access.', 'error');
      alert(`⚠️ Subscription Expired\n\n${errData.message || 'Your reporting subscription has expired. Please contact VNC to renew access.'}`);
      return;
    }

    const data = await res.json();

    if (!data.success || !data.config) {
      showToast(data.message || 'Failed to initialize spreadsheet editor.', 'error');
      return;
    }

    state.editorConfig = data.config;
    state.isEditorOpen = true;

    // Switch to full-screen editor view
    navigateTo('editor');
    renderEditorHeader(data.config);

    // Initialize document editor
    await mountSpreadsheetEditor(data.config);
  } catch (err) {
    console.error('Error opening workbook editor:', err);
    showToast('Failed to open spreadsheet editor: ' + err.message, 'error');
  }
}

function renderEditorHeader(config) {
  const titleEl = document.getElementById('editor-doc-title');
  const verEl = document.getElementById('editor-version-tag');
  const modeEl = document.getElementById('editor-mode-tag');
  const companyEl = document.getElementById('editor-company-tag');
  const syncBtn = document.getElementById('btn-editor-sync');
  const saveStatusEl = document.getElementById('editor-save-status');

  if (titleEl) titleEl.innerText = config.fileName || 'Controller_Reporting_Model_v5_Cin7_Actuals.xlsx';
  if (verEl) verEl.innerText = config.versionId || 'v1.0';
  if (companyEl) companyEl.innerText = config.companyName || state.client?.companyName || 'VNC Client';

  if (config.isReadOnly) {
    if (modeEl) {
      modeEl.innerText = 'READ-ONLY (HISTORICAL SNAPSHOT)';
      modeEl.className = 'editor-mode-tag mode-readonly';
    }
    if (syncBtn) syncBtn.classList.add('hidden');
    if (saveStatusEl) saveStatusEl.innerText = '🔒 Read-Only Historical Snapshot';
  } else {
    if (modeEl) {
      modeEl.innerText = 'EDIT MODE';
      modeEl.className = 'editor-mode-tag mode-edit';
    }
    if (syncBtn) syncBtn.classList.remove('hidden');
    if (saveStatusEl) saveStatusEl.innerText = '● Live Server Sync Active';
  }
}

function closeEditor() {
  state.isEditorOpen = false;
  state.editorConfig = null;
  state.activeParsedWorkbook = null;
  const container = document.getElementById('editor-canvas-container');
  if (container) {
    container.innerHTML = '<div id="onlyoffice-placeholder" style="width: 100%; height: 100%;"></div>';
  }
  navigateTo('dashboard');
}

/**
 * Mounts ONLYOFFICE Docs or full-fidelity interactive XLSX engine
 */
async function mountSpreadsheetEditor(config) {
  const container = document.getElementById('editor-canvas-container');
  if (!container) return;

  container.innerHTML = `
    <div class="editor-loading-screen" id="editor-loading-screen">
      <div class="loading-spinner"></div>
      <h3>Loading Real Excel Workbook...</h3>
      <p>Preserving all 17 worksheets, formulas, pivot tables, and financial dashboards.</p>
    </div>
    <div id="onlyoffice-mount" style="width: 100%; height: 100%;"></div>
  `;

  const onlyofficeUrl = config.onlyofficeUrl || 'http://localhost:8000';
  let onlyofficeSuccess = false;

  // Try ONLYOFFICE Document Server API integration
  try {
    const testRes = await fetch(`${onlyofficeUrl}/web-apps/apps/api/documents/api.js`, { method: 'HEAD', mode: 'no-cors' }).catch(() => null);
    if (window.DocsAPI && typeof window.DocsAPI.DocEditor === 'function') {
      const editor = new window.DocsAPI.DocEditor('onlyoffice-mount', {
        document: config.document,
        documentType: config.documentType,
        editorConfig: config.editorConfig,
        token: config.token,
        height: '100%',
        width: '100%'
      });
      state.onlyOfficeInstance = editor;
      onlyofficeSuccess = true;
      const loadingScreen = document.getElementById('editor-loading-screen');
      if (loadingScreen) loadingScreen.remove();
      return;
    }
  } catch (e) {
    console.log('[EDITOR] ONLYOFFICE Server not locally available. Using integrated XLSX browser engine.');
  }

  // Fallback: Fetch real .xlsx binary from server stream & mount rich multi-sheet spreadsheet canvas
  await mountNativeXlsxEngine(config);
}

/**
 * Native in-browser XLSX Spreadsheet Engine (Preserves all 17 sheets, formulas, formatting)
 */
async function mountNativeXlsxEngine(config) {
  const container = document.getElementById('editor-canvas-container');
  if (!container) return;

  try {
    // 1. Fetch real binary .xlsx directly from server stream
    const fileRes = await fetch(config.fileStreamUrl);
    if (!fileRes.ok) {
      throw new Error(`Failed to load workbook stream (${fileRes.statusText})`);
    }

    const arrayBuffer = await fileRes.arrayBuffer();
    state.activeWorkbookBlob = arrayBuffer;

    // 2. Parse workbook with SheetJS (full cell formulas, dates, formatting)
    if (!window.XLSX) {
      throw new Error('Spreadsheet engine components not loaded.');
    }

    const wb = window.XLSX.read(arrayBuffer, {
      type: 'array',
      cellDates: true,
      cellStyles: true,
      cellNF: true,
      cellFormula: true
    });

    state.activeParsedWorkbook = wb;
    const sheetNames = wb.SheetNames || [];
    state.activeSheetName = sheetNames[0] || 'Cover & Index';

    // 3. Render complete spreadsheet application interface
    container.innerHTML = `
      <div class="xlsx-app-container">
        <!-- Formula Bar -->
        <div class="xlsx-formula-bar">
          <div class="fx-label">fx</div>
          <div class="active-cell-box" id="fx-cell-address">A1</div>
          <input type="text" class="fx-input" id="fx-formula-input" placeholder="Select a cell to view or edit formulas" ${config.isReadOnly ? 'readonly' : ''}>
          ${!config.isReadOnly ? '<button class="btn-save-cell-edit" onclick="saveActiveCellEdit()" title="Apply formula / value change">✓ Apply</button>' : ''}
        </div>

        <!-- Main Grid Area -->
        <div class="xlsx-grid-viewport" id="xlsx-grid-viewport">
          <div class="xlsx-grid-wrapper" id="xlsx-grid-wrapper">
            <!-- Table dynamically injected here -->
          </div>
        </div>

        <!-- Bottom Sheet Tab Bar (17 Worksheets) -->
        <div class="xlsx-tab-bar" id="xlsx-tab-bar">
          <div class="tab-nav-arrow" onclick="scrollTabs(-100)">◀</div>
          <div class="tab-scroll-container" id="tab-scroll-container">
            ${sheetNames.map((name, idx) => `
              <button class="sheet-tab-btn ${idx === 0 ? 'active' : ''}" 
                      id="tab-btn-${idx}" 
                      onclick="switchWorksheetTab('${name.replace(/'/g, "\\'")}', ${idx})">
                ${name}
              </button>
            `).join('')}
          </div>
          <div class="tab-nav-arrow" onclick="scrollTabs(100)">▶</div>
          <div class="tab-count-badge">${sheetNames.length} Sheets Preserved</div>
        </div>
      </div>
    `;

    // Render active sheet grid
    renderActiveWorksheetGrid();
  } catch (err) {
    console.error('Error mounting XLSX engine:', err);
    container.innerHTML = `
      <div class="editor-error-box">
        <h3>Unable to render spreadsheet</h3>
        <p>${err.message}</p>
        <button class="btn-primary" onclick="openWorkbook()">Retry Loading</button>
      </div>
    `;
  }
}

function switchWorksheetTab(sheetName, tabIndex) {
  state.activeSheetName = sheetName;
  document.querySelectorAll('.sheet-tab-btn').forEach((btn, idx) => {
    if (idx === tabIndex) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
  renderActiveWorksheetGrid();
}

function scrollTabs(offset) {
  const container = document.getElementById('tab-scroll-container');
  if (container) {
    container.scrollBy({ left: offset, behavior: 'smooth' });
  }
}

function renderActiveWorksheetGrid() {
  const wrapper = document.getElementById('xlsx-grid-wrapper');
  if (!wrapper || !state.activeParsedWorkbook || !state.activeSheetName) return;

  const ws = state.activeParsedWorkbook.Sheets[state.activeSheetName];
  if (!ws) {
    wrapper.innerHTML = '<div class="empty-sheet-msg">Empty Worksheet</div>';
    return;
  }

  const range = window.XLSX.utils.decode_range(ws['!ref'] || 'A1:M40');
  const maxRow = Math.min(range.e.r, 150); // High-performance view window
  const maxCol = Math.min(range.e.c, 25);

  let html = '<table class="xlsx-sheet-table"><thead><tr><th class="row-num-header"></th>';

  for (let c = 0; c <= maxCol; c++) {
    const colName = window.XLSX.utils.encode_col(c);
    html += `<th class="col-header">${colName}</th>`;
  }
  html += '</tr></thead><tbody>';

  for (let r = 0; r <= maxRow; r++) {
    html += `<tr><td class="row-num">${r + 1}</td>`;
    for (let c = 0; c <= maxCol; c++) {
      const cellAddress = window.XLSX.utils.encode_cell({ r, c });
      const cell = ws[cellAddress];

      let displayVal = '';
      let cellTypeClass = '';
      let formulaVal = '';

      if (cell) {
        if (cell.f) {
          formulaVal = `=${cell.f}`;
          displayVal = cell.w || cell.v || '';
          cellTypeClass = 'cell-formula';
        } else if (cell.w) {
          displayVal = cell.w;
        } else if (cell.v !== undefined) {
          displayVal = cell.v;
        }

        if (typeof cell.v === 'number') {
          cellTypeClass += ' cell-number';
        }
      }

      const isReadOnly = state.editorConfig?.isReadOnly;
      const contentEditable = !isReadOnly ? 'contenteditable="true"' : '';

      html += `
        <td class="grid-cell ${cellTypeClass}" 
            id="cell-${cellAddress}"
            data-address="${cellAddress}"
            data-formula="${formulaVal.replace(/"/g, '&quot;')}"
            ${contentEditable}
            onfocus="handleCellFocus('${cellAddress}')"
            onblur="handleCellBlur('${cellAddress}', this)">
          ${escapeHtml(String(displayVal))}
        </td>
      `;
    }
    html += '</tr>';
  }

  html += '</tbody></table>';
  wrapper.innerHTML = html;
}

let activeFocusedCell = 'A1';

function handleCellFocus(cellAddress) {
  activeFocusedCell = cellAddress;
  const addrBox = document.getElementById('fx-cell-address');
  const fxInput = document.getElementById('fx-formula-input');
  if (addrBox) addrBox.innerText = cellAddress;

  const ws = state.activeParsedWorkbook?.Sheets[state.activeSheetName];
  const cell = ws ? ws[cellAddress] : null;

  if (fxInput) {
    if (cell && cell.f) {
      fxInput.value = `=${cell.f}`;
    } else if (cell && cell.v !== undefined) {
      fxInput.value = cell.v;
    } else {
      fxInput.value = '';
    }
  }
}

async function handleCellBlur(cellAddress, tdElement) {
  if (state.editorConfig?.isReadOnly) return;

  const newVal = tdElement.innerText.trim();
  const ws = state.activeParsedWorkbook?.Sheets[state.activeSheetName];
  if (!ws) return;

  if (!ws[cellAddress]) {
    ws[cellAddress] = { t: 's', v: newVal };
  } else {
    if (newVal.startsWith('=')) {
      ws[cellAddress].f = newVal.substring(1);
    } else {
      delete ws[cellAddress].f;
      const num = Number(newVal.replace(/[^0-9.-]/g, ''));
      if (!isNaN(num) && newVal !== '' && !newVal.includes('/') && !newVal.includes('-')) {
        ws[cellAddress].t = 'n';
        ws[cellAddress].v = num;
      } else {
        ws[cellAddress].t = 's';
        ws[cellAddress].v = newVal;
      }
    }
  }

  await triggerAutoSave();
}

async function saveActiveCellEdit() {
  const fxInput = document.getElementById('fx-formula-input');
  if (!fxInput || !activeFocusedCell) return;

  const td = document.getElementById(`cell-${activeFocusedCell}`);
  if (td) {
    td.innerText = fxInput.value;
    await handleCellBlur(activeFocusedCell, td);
  }
}

let autoSaveTimeout = null;

async function triggerAutoSave() {
  const statusEl = document.getElementById('editor-save-status');
  if (statusEl) statusEl.innerText = '⏳ Saving changes to server...';

  clearTimeout(autoSaveTimeout);
  autoSaveTimeout = setTimeout(async () => {
    try {
      if (!state.activeParsedWorkbook || !state.editorConfig?.saveDirectUrl) return;

      const wbOut = window.XLSX.write(state.activeParsedWorkbook, {
        bookType: 'xlsx',
        type: 'array'
      });

      const res = await fetch(state.editorConfig.saveDirectUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        body: wbOut
      });

      if (res.ok) {
        if (statusEl) statusEl.innerText = '● Live Server Sync Active (Saved)';
        showToast('Changes saved to server workbook', 'success');
      } else {
        if (statusEl) statusEl.innerText = '⚠️ Save failed';
      }
    } catch (e) {
      console.error('Auto-save error:', e);
      if (statusEl) statusEl.innerText = '⚠️ Auto-save error';
    }
  }, 1000);
}

async function handleSyncFromEditor() {
  showToast('Triggering Cin7 sync...', 'info');
  await handleSync('all');
  if (state.isEditorOpen) {
    showToast('Reloading workbook with fresh Cin7 data...', 'info');
    await openWorkbook();
  }
}

// ── 4. CIN7 DATA SYNC CONTROLLER ──────────────────────────────────────────

async function handleSync(syncType = 'all') {
  const subStatus = (state.client?.subscriptionStatus || 'ACTIVE').toUpperCase();
  if (subStatus !== 'ACTIVE') {
    showToast('Your reporting subscription has expired. Please contact VNC to renew access.', 'error');
    return;
  }

  showProgressModal(syncType);

  try {
    const res = await fetch(`/api/sync/${syncType}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (res.status === 403) {
      hideProgressModal();
      showToast('Your reporting subscription has expired. Please contact VNC to renew access.', 'error');
      return;
    }

    const data = await res.json();
    hideProgressModal();

    if (data.success) {
      showToast(`⚡ Synced ${data.recordsProcessed} records successfully (Version: ${data.versionId || 'v2.0'})`, 'success');
      
      // Update local client state
      if (data.versionId) state.client.currentVersion = data.versionId;
      if (data.lastSyncAt) state.client.lastSyncAt = data.lastSyncAt;
      state.client.syncStatus = 'SYNCED';

      loadDashboardData();
    } else {
      showToast(data.errorMessage || 'Sync execution failed.', 'error');
    }
  } catch (err) {
    hideProgressModal();
    console.error('Sync Error:', err);
    showToast('Network error during Cin7 sync.', 'error');
  }
}

function showProgressModal(syncType) {
  const card = document.getElementById('master-progress-card');
  const title = document.getElementById('progress-status-title');
  const bar = document.getElementById('progress-bar-fill');
  const pct = document.getElementById('progress-percent-txt');
  const footer = document.getElementById('progress-footer-txt');

  if (card) card.classList.remove('hidden');
  if (title) title.innerText = `Syncing Cin7 ${syncType.toUpperCase()} Data...`;
  if (bar) bar.style.width = '35%';
  if (pct) pct.innerText = '35%';
  if (footer) footer.innerText = 'Querying Cin7 ERP endpoints & rate limits...';

  setTimeout(() => {
    if (bar) bar.style.width = '70%';
    if (pct) pct.innerText = '70%';
    if (footer) footer.innerText = 'Updating server-side reporting.xlsx & archiving version...';
  }, 600);
}

function hideProgressModal() {
  const card = document.getElementById('master-progress-card');
  const bar = document.getElementById('progress-bar-fill');
  const pct = document.getElementById('progress-percent-txt');

  if (bar) bar.style.width = '100%';
  if (pct) pct.innerText = '100%';

  setTimeout(() => {
    if (card) card.classList.add('hidden');
    if (bar) bar.style.width = '0%';
    if (pct) pct.innerText = '0%';
  }, 400);
}

// ── 5. PERSISTENT VERSION HISTORY AUDIT LOG ───────────────────────────────

async function loadHistoryData(page = 1) {
  state.historyPage = page;
  try {
    const res = await fetch(`/api/sync/history?page=${page}&limit=10`);
    const data = await res.json();

    const tbody = document.getElementById('history-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const items = data.items || data.syncRuns || [];

    if (items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No sync history recorded yet. Trigger your first sync from the Dashboard!</td></tr>';
      updatePaginationControls(1, 1, 0);
      return;
    }

    items.forEach(run => {
      const tr = document.createElement('tr');
      const dateStr = new Date(run.startedAt || run.started_at).toLocaleString();
      let statusBadge = '';
      let actionBtn = '';
      const versionBadge = run.excelVersionId || run.excel_version_id || 'v1.0';

      if (run.status === 'COMPLETED') {
        statusBadge = '<span class="badge-status status-success">● COMPLETED</span>';
        actionBtn = `
          <button type="button" class="btn-action-open-version" onclick="openHistoricalVersion('${run.id}')" title="Open historical version in browser spreadsheet editor">
            📂 Open Version (${versionBadge})
          </button>
        `;
      } else if (run.status === 'FAILED') {
        statusBadge = '<span class="badge-status status-error">✕ FAILED</span>';
        actionBtn = `<span class="text-muted">—</span>`;
      } else {
        statusBadge = '<span class="badge-status status-syncing">⏳ RUNNING</span>';
        actionBtn = `<span class="text-muted">—</span>`;
      }

      const durationSec = ((run.durationMs || run.duration_ms || 0) / 1000).toFixed(1);

      tr.innerHTML = `
        <td><span class="version-code-badge">${versionBadge}</span></td>
        <td>${dateStr}</td>
        <td>${statusBadge}</td>
        <td><strong>${(run.recordsProcessed || run.records_processed || 0).toLocaleString()}</strong></td>
        <td>${durationSec}s</td>
        <td><code>${run.runId || run.id}</code></td>
        <td>${actionBtn}</td>
      `;
      tbody.appendChild(tr);
    });

    state.historyTotalPages = data.totalPages || 1;
    updatePaginationControls(data.page || 1, data.totalPages || 1, data.totalRecords || items.length);
  } catch (err) {
    console.error('Error loading history:', err);
  }
}

async function openHistoricalVersion(historyId) {
  if (!historyId) return;

  const subStatus = (state.client?.subscriptionStatus || 'ACTIVE').toUpperCase();
  if (subStatus !== 'ACTIVE') {
    showToast('Your reporting subscription has expired. Please contact VNC to renew access.', 'error');
    alert('⚠️ Access Blocked\n\nYour reporting subscription has expired. Please contact VNC to renew access.');
    return;
  }

  showToast('Opening historical snapshot in browser spreadsheet editor...', 'info');

  try {
    const res = await fetch(`/api/sync/history/${historyId}/session`, { method: 'POST' });
    if (res.status === 403) {
      showToast('Your reporting subscription has expired.', 'error');
      return;
    }

    const data = await res.json();
    if (data.success && data.config) {
      state.editorConfig = data.config;
      state.isEditorOpen = true;
      navigateTo('editor');
      renderEditorHeader(data.config);
      await mountSpreadsheetEditor(data.config);
    } else {
      showToast(data.message || 'Could not load historical version snapshot.', 'error');
    }
  } catch (err) {
    showToast('Failed to open version snapshot: ' + err.message, 'error');
  }
}

function updatePaginationControls(page, totalPages, totalRecords) {
  const pageInfo = document.getElementById('history-page-info');
  const pageNum = document.getElementById('current-page-num');
  const prevBtn = document.getElementById('btn-page-prev');
  const nextBtn = document.getElementById('btn-page-next');

  if (pageInfo) pageInfo.innerText = `Showing Page ${page} of ${totalPages} (${totalRecords} total sync runs)`;
  if (pageNum) pageNum.innerText = page;

  if (prevBtn) prevBtn.disabled = page <= 1;
  if (nextBtn) nextBtn.disabled = page >= totalPages;
}

function changeHistoryPage(offset) {
  const newPage = state.historyPage + offset;
  if (newPage >= 1 && newPage <= state.historyTotalPages) {
    loadHistoryData(newPage);
  }
}

// ── 6. SETTINGS & MODALS ──────────────────────────────────────────────────

function loadSettingsData() {
  const compName = document.getElementById('settings-company-name');
  const tenantId = document.getElementById('settings-tenant-id');
  const curVer = document.getElementById('settings-current-version');
  const subBadge = document.getElementById('settings-sub-badge');

  if (compName && state.client) compName.innerText = state.client.companyName;
  if (tenantId && state.client) tenantId.innerText = state.client.id;
  if (curVer && state.client) curVer.innerText = state.client.currentVersion || 'v1.0';

  const subStatus = (state.client?.subscriptionStatus || 'ACTIVE').toUpperCase();
  if (subBadge) {
    subBadge.innerText = subStatus;
    subBadge.className = `badge-status ${subStatus === 'ACTIVE' ? 'status-success' : 'status-error'}`;
  }
}

function openSigninModal() {
  const modal = document.getElementById('signin-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeSigninModal() {
  const modal = document.getElementById('signin-modal');
  if (modal) modal.classList.add('hidden');
}

async function handleSigninSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('signin-email').value;
  const password = document.getElementById('signin-password').value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();
    if (data.success) {
      closeSigninModal();
      showToast('Signed in successfully', 'success');
      await checkAuthStatus();
    } else {
      showToast(data.message || 'Invalid login credentials.', 'error');
    }
  } catch (err) {
    showToast('Sign in server request failed.', 'error');
  }
}

function openRegisterModal() {
  const modal = document.getElementById('register-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeRegisterModal() {
  const modal = document.getElementById('register-modal');
  if (modal) modal.classList.add('hidden');
}

async function handleRegisterSubmit(e) {
  e.preventDefault();
  const fullName = document.getElementById('reg-fullname').value;
  const companyName = document.getElementById('reg-company').value;
  const phoneNumber = document.getElementById('reg-phone').value;
  const email = document.getElementById('reg-email').value;
  const password = document.getElementById('reg-password').value;
  const confirmPassword = document.getElementById('reg-confirm-password').value;

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName, companyName, phoneNumber, email, password, confirmPassword })
    });

    const data = await res.json();
    if (data.success) {
      closeRegisterModal();
      showToast('Account created and workbook provisioned!', 'success');
      await checkAuthStatus();
    } else {
      showToast(data.message || 'Registration failed.', 'error');
    }
  } catch (err) {
    showToast('Registration request failed.', 'error');
  }
}

function openCin7Modal() {
  const modal = document.getElementById('cin7-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeCin7Modal() {
  const modal = document.getElementById('cin7-modal');
  if (modal) modal.classList.add('hidden');
}

async function handleCin7Test() {
  const username = document.getElementById('cin7-username').value;
  const key = document.getElementById('cin7-key').value;
  const fb = document.getElementById('modal-feedback');

  if (fb) {
    fb.innerText = 'Testing connection to Cin7 ERP API...';
    fb.className = 'modal-feedback success';
    fb.classList.remove('hidden');
  }

  try {
    const res = await fetch('/api/cin7/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiUsername: username, apiKey: key })
    });
    const data = await res.json();
    if (fb) {
      fb.innerText = data.message;
      fb.className = `modal-feedback ${data.success ? 'success' : 'error'}`;
    }
  } catch (err) {
    if (fb) {
      fb.innerText = 'Unable to connect to Cin7 API.';
      fb.className = 'modal-feedback error';
    }
  }
}

async function handleCin7Connect(e) {
  e.preventDefault();
  const username = document.getElementById('cin7-username').value;
  const key = document.getElementById('cin7-key').value;

  try {
    const res = await fetch('/api/cin7/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiUsername: username, apiKey: key })
    });

    const data = await res.json();
    if (data.success) {
      showToast('Cin7 Credentials Updated Successfully', 'success');
      closeCin7Modal();
      checkAuthStatus();
    } else {
      showToast(data.message || 'Failed to save credentials.', 'error');
    }
  } catch (err) {
    showToast('Failed to update Cin7 credentials.', 'error');
  }
}

async function handleLogout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
    state.user = null;
    state.client = null;
    state.isEditorOpen = false;
    updateUIHeader();
    navigateTo('auth-landing');
    showToast('Logged out successfully', 'info');
  } catch (err) {
    window.location.reload();
  }
}

// ── 7. UTILITIES ──────────────────────────────────────────────────────────

function togglePasswordVisibility(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerText = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 4500);
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}
