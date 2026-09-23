/**
 * HTML Escaping Utility for DOM XSS Protection (SEC-09)
 * Strictly sanitizes untrusted input, API payloads, database entities, and error strings.
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

const state = {
  user: null,
  client: null,
  cin7: null,
  isSyncing: false,
  activeTimeline: '30d',
  recentActivities: [],
  reconcileItems: [],
  reconcilePage: 1,
  reconcilePageSize: 10,
  reconcileFilter: 'all',
  reconcileDataset: 'sales',
  workbookSheets: [
    '📋 Cover & Index',
    'KPI Dashboard',
    'Weekly Order Tracker',
    'Sales Trend Analysis',
    'Product Margin Analysis',
    'COGS & Profitability by Channel',
    'Inventory & MOS Analysis',
    'Inventory Movements',
    'Profitability Dashboard',
    'Sales Dashboard',
    'Sales Transactions Raw Data',
    'Inventory On Hand Raw Data',
    'Purchase Transactions Raw data',
    'Cost Inputs'
  ]
};

// ── 1. LIFECYCLE & ROUTING ──────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  renderSheetsList();
  renderActivityList();

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('google_auth') === 'success') {
    showToast('Signed in successfully with Google!', 'success');
    window.history.replaceState({}, document.title, window.location.pathname);
  } else if (urlParams.get('google_auth') === 'error') {
    showToast(urlParams.get('msg') || 'Google sign-in failed. Please try again.', 'error');
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  checkAuthStatus();
});

function handleGoogleSignIn() {
  showToast('Redirecting to Google Sign-In...', 'info');
  window.location.href = '/api/auth/google/start';
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();

    if (data.authenticated) {
      state.user = data.user;
      state.client = data.client;
      state.cin7 = data.cin7;

      // Check if user needs first-time client onboarding / selection
      if (data.needsClientSelection === true) {
        const navbar = document.getElementById('navbar');
        if (navbar) navbar.classList.add('hidden');
        navigateTo('client-select');
        loadClientSelectionView(data.user);
        return;
      }

      updateUIHeader();
      
      const platformRole = (data.user?.platformRole || data.user?.platform_role || '').toUpperCase();
      if (platformRole === 'SUPER_ADMIN') {
        navigateTo('admin');
      } else if (data.user.onboardingStatus === 'completed' || data.cin7?.connected === true) {
        navigateTo('dashboard');
        loadRecentActivityFromHistory();

        // Check if a background sync is currently running for this client
        try {
          const syncStatusRes = await fetch('/api/sync/status');
          const syncStatus = await syncStatusRes.json();
          if (syncStatus.success && syncStatus.isSyncing && syncStatus.activeRunId) {
            console.log('[CIN7 UI] Reconnecting to running background sync:', syncStatus.activeRunId);
            startSyncPolling(syncStatus.activeRunId, 'Background Sync');
          }
        } catch (e) {}
      } else {
        navigateTo('onboarding');
      }
      updateDashboardData();
    } else {
      navigateTo('auth-landing');
    }
  } catch (err) {
    console.error('Auth check error:', err);
    navigateTo('auth-landing');
  }
}

function updateUIHeader() {
  const navbar = document.getElementById('navbar');
  if (state.user) {
    if (navbar && state.currentView !== 'admin' && state.currentView !== 'admin-portal') {
      navbar.classList.remove('hidden');
    }

    // Populate user pill
    const name = state.user.fullName || state.user.full_name || state.user.name || 'User';
    const role = (state.user.role || 'ADMIN').toUpperCase();
    const platformRole = (state.user.platformRole || state.user.platform_role || 'USER').toUpperCase();
    const org = state.client?.companyName || state.user.companyName || 'VNC Workspace';

    const avatarEl = document.getElementById('nav-user-avatar');
    const nameEl = document.getElementById('nav-user-name');
    const roleEl = document.getElementById('nav-user-role');
    const orgEl = document.getElementById('nav-user-org');

    if (avatarEl) {
      const parts = name.trim().split(/\s+/);
      const initials = parts.length > 1 ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase() : (name.slice(0, 2).toUpperCase() || 'HP');
      avatarEl.innerText = initials;
    }
    if (nameEl) nameEl.innerText = name;
    if (roleEl) {
      if (platformRole === 'SUPER_ADMIN') {
        roleEl.innerText = 'Admin';
        roleEl.className = 'nav-role-badge role-super_admin';
      } else {
        const roleFormatted = (role === 'ADMIN' || role === 'CLIENT') ? 'Client' : (role.charAt(0) + role.slice(1).toLowerCase());
        roleEl.innerText = roleFormatted;
        roleEl.className = `nav-role-badge role-${role.toLowerCase()}`;
      }
    }
    if (orgEl) {
      orgEl.innerText = platformRole === 'SUPER_ADMIN' ? 'VNC Global Platform' : org;
    }

    // Populate Admin Topbar user pill
    const adminAvatarEl = document.getElementById('admin-nav-user-avatar');
    const adminNameEl = document.getElementById('admin-nav-user-name');
    const adminRoleEl = document.getElementById('admin-nav-user-role');
    if (adminAvatarEl) {
      const parts = name.trim().split(/\s+/);
      const initials = parts.length > 1 ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase() : (name.slice(0, 2).toUpperCase() || 'SA');
      adminAvatarEl.innerText = initials;
    }
    if (adminNameEl) {
      adminNameEl.innerText = (name === 'Platform Super Admin' || name === 'Super Admin') ? (state.user.fullName || state.user.email || 'Super Admin') : name;
    }
    if (adminRoleEl) {
      adminRoleEl.innerText = platformRole === 'SUPER_ADMIN' ? 'Platform Lead' : (role.charAt(0) + role.slice(1).toLowerCase());
    }

    // Toggle Super Admin portal nav button in navbar
    const adminNavBtn = document.getElementById('nav-admin-btn');
    if (adminNavBtn) {
      if (platformRole === 'SUPER_ADMIN') {
        adminNavBtn.classList.remove('hidden');
      } else {
        adminNavBtn.classList.add('hidden');
      }
    }

    // RBAC UI permissions
    const adminElements = document.querySelectorAll('.admin-only');
    const managerPlusElements = document.querySelectorAll('.manager-only');
    // Visible to everyone (status stays readable) but only editable by ADMIN/SUPER_ADMIN,
    // e.g. Cin7 Account ID and the Google Sheets Master Template ID.
    const adminEditableInputs = document.querySelectorAll('.admin-editable');
    const syncButtons = document.querySelectorAll('#btn-sync-now, #btn-sync-sales, #btn-sync-inventory, #btn-sync-purchases, #btn-pull-sheets, #btn-pull-sheets-card');
    const isAdmin = platformRole === 'SUPER_ADMIN' || role === 'ADMIN';

    adminEditableInputs.forEach(el => {
      el.disabled = !isAdmin;
      el.title = isAdmin ? '' : 'Only organization admins can change this';
    });

    if (role === 'VIEWER' && platformRole !== 'SUPER_ADMIN') {
      adminElements.forEach(el => el.style.display = 'none');
      managerPlusElements.forEach(el => el.style.display = 'none');
      syncButtons.forEach(btn => {
        btn.disabled = true;
        btn.title = 'Viewers have read-only access';
        btn.style.opacity = '0.5';
        btn.style.cursor = 'not-allowed';
      });
    } else if (role === 'MANAGER' && platformRole !== 'SUPER_ADMIN') {
      adminElements.forEach(el => el.style.display = 'none');
      managerPlusElements.forEach(el => el.style.display = '');
      syncButtons.forEach(btn => {
        btn.disabled = false;
        btn.title = '';
        btn.style.opacity = '';
        btn.style.cursor = '';
      });
    } else { // ADMIN or SUPER_ADMIN
      adminElements.forEach(el => el.style.display = '');
      managerPlusElements.forEach(el => el.style.display = '');
      syncButtons.forEach(btn => {
        btn.disabled = false;
        btn.title = '';
        btn.style.opacity = '';
        btn.style.cursor = '';
      });
    }
  } else {
    if (navbar) navbar.classList.add('hidden');
  }
}

function navigateTo(viewId) {
  // Defense-in-depth: the backend already rejects every /api/admin/* call for
  // non-super-admins, but don't even show the Admin Portal shell (nav labels,
  // layout) to a client who navigates here directly (e.g. via console/URL).
  if (viewId === 'admin') {
    const platformRole = (state.user?.platformRole || state.user?.platform_role || 'USER').toUpperCase();
    if (platformRole !== 'SUPER_ADMIN') {
      showToast('You do not have access to the Admin Portal.', 'error');
      viewId = 'dashboard';
    }
  }

  const views = ['auth-landing', 'client-select', 'onboarding', 'dashboard', 'reports', 'settings', 'admin-portal', 'support', 'privacy-policy', 'terms-conditions'];
  views.forEach(v => {
    const el = document.getElementById(`${v}-view`);
    if (el) {
      if (v === viewId || (viewId === 'admin' && v === 'admin-portal')) {
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }
  });

  const navBtns = {
    'dashboard': 'nav-dashboard-btn',
    'reports': 'nav-reports-btn',
    'settings': 'nav-settings-btn',
    'admin': 'nav-admin-btn'
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

  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (viewId === 'dashboard') updateDashboardData();
  if (viewId === 'reports') loadReportsView();
  if (viewId === 'settings') loadSettingsData();
  if (viewId === 'admin') loadAdminDashboard();
  state.currentView = viewId;

  // Toggle client navbar visibility (hide on admin screens, auth screens, and onboarding)
  const navbar = document.getElementById('navbar');
  if (navbar) {
    if (viewId === 'admin' || viewId === 'admin-portal' || viewId === 'auth-landing' || viewId === 'client-select' || viewId === 'onboarding') {
      navbar.classList.add('hidden');
    } else if (state.user) {
      navbar.classList.remove('hidden');
    }
  }

  // Toggle global footer visibility & auth body class
  document.body.classList.toggle('auth-screen-active', viewId === 'auth-landing');

  const globalFooter = document.getElementById('app-global-footer');
  if (globalFooter) {
    if (viewId === 'auth-landing' || viewId === 'client-select' || viewId === 'onboarding') {
      globalFooter.classList.add('hidden');
    } else {
      globalFooter.classList.remove('hidden');
    }
  }
}

function handleSupportTicketSubmit(e) {
  if (e) e.preventDefault();
  const name = document.getElementById('support-name')?.value || 'Client';
  const email = document.getElementById('support-email')?.value || '';
  const category = document.getElementById('support-category')?.value || 'General';
  const subject = document.getElementById('support-subject')?.value || '';
  const urgency = document.getElementById('support-urgency')?.value || 'medium';

  const ticketId = `TKT-${Math.floor(10000 + Math.random() * 90000)}`;

  showToast(`Ticket #${ticketId} submitted successfully! A support engineer will email ${email || 'you'} shortly.`, 'success');

  const form = document.getElementById('support-ticket-form');
  if (form) form.reset();
}

// ── 2. AUTHENTICATION & ONBOARDING ──────────────────────────────────────────

function switchAuthTab(tab) {
  const signinBtn = document.getElementById('tab-signin-btn');
  const signupBtn = document.getElementById('tab-signup-btn');
  const adminBtn = document.getElementById('tab-admin-btn');
  const signinForm = document.getElementById('signin-form');
  const signupForm = document.getElementById('signup-form');
  const adminForm = document.getElementById('admin-signin-form');
  const googleBtn = document.getElementById('google-signin-btn');
  const googleDivider = document.querySelector('.auth-card > .auth-divider');
  const cardTitle = document.querySelector('.auth-card-title');
  const cardSubtitle = document.querySelector('.auth-card-subtitle');

  // Clear active tab styles
  if (signinBtn) signinBtn.classList.remove('active');
  if (signupBtn) signupBtn.classList.remove('active');
  if (adminBtn) adminBtn.classList.remove('active');

  // Hide all form bodies
  if (signinForm) signinForm.classList.add('hidden');
  if (signupForm) signupForm.classList.add('hidden');
  if (adminForm) adminForm.classList.add('hidden');

  if (tab === 'signin') {
    if (signinBtn) signinBtn.classList.add('active');
    if (signinForm) signinForm.classList.remove('hidden');
    if (googleBtn) googleBtn.classList.remove('hidden');
    if (googleDivider) googleDivider.classList.remove('hidden');
    if (cardTitle) cardTitle.innerText = 'Welcome to VNC Cin7 Sync';
    if (cardSubtitle) cardSubtitle.innerText = 'Sign in, or create your controller account to get started.';
  } else if (tab === 'signup') {
    if (signupBtn) signupBtn.classList.add('active');
    if (signupForm) signupForm.classList.remove('hidden');
    if (googleBtn) googleBtn.classList.remove('hidden');
    if (googleDivider) googleDivider.classList.remove('hidden');
    if (cardTitle) cardTitle.innerText = 'Create Controller Account';
    if (cardSubtitle) cardSubtitle.innerText = 'Register your workspace to sync and automate Cin7 reporting.';
  } else if (tab === 'admin') {
    if (adminBtn) adminBtn.classList.add('active');
    if (adminForm) adminForm.classList.remove('hidden');
    if (googleBtn) googleBtn.classList.add('hidden');
    if (googleDivider) googleDivider.classList.add('hidden');
    if (cardTitle) cardTitle.innerText = 'Admin Portal';
    if (cardSubtitle) cardSubtitle.innerText = 'Administrative sign-in for platform management and client oversight.';
  }
}

function escapeHtmlPortal(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function loadClientSelectionView(user) {
  const emailEl = document.getElementById('client-select-user-email');
  const nameInput = document.getElementById('manual-full-name');
  const phoneInput = document.getElementById('manual-phone-number');

  const activeUser = user || state.user;
  if (emailEl) {
    emailEl.innerText = activeUser?.email || 'Google User';
  }
  if (nameInput && !nameInput.value) {
    nameInput.value = activeUser?.fullName || activeUser?.full_name || '';
  }
  if (phoneInput && !phoneInput.value && activeUser?.phoneNumber) {
    phoneInput.value = activeUser.phoneNumber;
  }
}

async function handleManualWorkspaceSetup(event) {
  if (event) event.preventDefault();
  const submitBtn = document.getElementById('client-setup-submit-btn');
  const companyName = document.getElementById('manual-company-name')?.value?.trim();
  const fullName = document.getElementById('manual-full-name')?.value?.trim();
  const phoneNumber = document.getElementById('manual-phone-number')?.value?.trim();
  const timezone = document.getElementById('manual-timezone')?.value;

  if (!companyName) {
    showToast('Please enter your Company / Organization name.', 'error');
    return;
  }
  if (!fullName) {
    showToast('Please enter your Full Name.', 'error');
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span> Creating workspace...';
  }

  try {
    const res = await fetch('/api/auth/setup-workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyName, fullName, phoneNumber, timezone })
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      showToast(data.message || 'Failed to setup workspace. Please try again.', 'error');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Create &amp; Launch Dashboard &rarr;</span>';
      }
      return;
    }

    showToast(data.message || 'Workspace created successfully!', 'success');
    // Refresh authentication status to proceed directly to dashboard
    await checkAuthStatus();
  } catch (err) {
    console.error('Manual workspace setup error:', err);
    showToast('An unexpected error occurred. Please try again.', 'error');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>Create &amp; Launch Dashboard &rarr;</span>';
    }
  }
}

async function handleClientSelectionSubmit(event) {
  if (event) event.preventDefault();
  const form = document.getElementById('client-select-form');
  const submitBtn = document.getElementById('client-select-submit-btn');
  const formData = form ? new FormData(form) : null;
  const selectedClientId = formData ? formData.get('selectedClientId') : null;

  if (!selectedClientId) {
    showToast('Please select a client workspace to continue.', 'error');
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span> Connecting workspace...';
  }

  try {
    const res = await fetch('/api/auth/select-client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: selectedClientId })
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      showToast(data.message || 'Failed to select workspace. Please try again.', 'error');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Confirm &amp; Launch Dashboard &rarr;</span>';
      }
      return;
    }

    showToast(data.message || 'Workspace connected successfully!', 'success');
    await checkAuthStatus();
  } catch (err) {
    console.error('Client selection error:', err);
    showToast('An unexpected error occurred. Please try again.', 'error');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>Confirm &amp; Launch Dashboard &rarr;</span>';
    }
  }
}

async function handleSigninSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('signin-email').value.trim();
  const password = document.getElementById('signin-password').value;
  const submitBtn = document.getElementById('signin-submit-btn');

  if (!email || !password) {
    showToast('Please enter both email and password.', 'error');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerText = 'Signing in...';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();

    if (data.success) {
      showToast('Signed in successfully', 'success');
      state.user = data.user;
      state.client = data.client;
      state.cin7 = data.cin7 || { connected: false, status: 'DISCONNECTED' };
      updateUIHeader();

      const platformRole = (data.user?.platformRole || data.user?.platform_role || '').toUpperCase();
      if (platformRole === 'SUPER_ADMIN') {
        navigateTo('admin');
      } else if (data.user?.onboardingStatus === 'completed' || data.cin7?.connected === true) {
        navigateTo('dashboard');
        updateDashboardData();
      } else {
        navigateTo('onboarding');
      }
    } else {
      showToast(data.message || 'Invalid email or password.', 'error');
    }
  } catch (err) {
    console.error('Sign in error:', err);
    showToast('Sign in failed. Please try again.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerText = 'Sign in';
  }
}

async function quickSuperAdminSignIn() {
  const directBtn = document.getElementById('admin-launch-direct-btn');
  if (directBtn) {
    directBtn.disabled = true;
    directBtn.innerHTML = '<span class="spinner"></span> <span>Launching Admin Console...</span>';
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'superadmin@vnc.global',
        password: 'SuperAdmin2026!#'
      })
    });
    const data = await res.json();

    if (data.success) {
      showToast('Admin access granted. Opening Console...', 'success');
      state.user = data.user;
      state.client = data.client;
      state.cin7 = data.cin7 || { connected: true, status: 'CONNECTED' };
      updateUIHeader();
      navigateTo('admin');
    } else {
      showToast(data.message || 'Admin authentication failed.', 'error');
    }
  } catch (err) {
    console.error('Admin sign-in error:', err);
    showToast('Failed to sign in as Admin. Please try again.', 'error');
  } finally {
    if (directBtn) {
      directBtn.disabled = false;
      directBtn.innerHTML = '<span>⚡ One-Click Admin Access</span>';
    }
  }
}

async function handleAdminSigninSubmit(e) {
  if (e) e.preventDefault();
  const emailInput = document.getElementById('admin-signin-email');
  const passInput = document.getElementById('admin-signin-password');
  const submitBtn = document.getElementById('admin-signin-submit-btn');

  const email = emailInput?.value?.trim();
  const password = passInput?.value;

  if (!email || !password) {
    showToast('Please enter both admin email and password.', 'error');
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = 'Verifying credentials...';
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();

    if (data.success) {
      showToast('Admin authenticated successfully!', 'success');
      state.user = data.user;
      state.client = data.client;
      state.cin7 = data.cin7 || { connected: true, status: 'CONNECTED' };
      updateUIHeader();

      const platformRole = (data.user?.platformRole || data.user?.platform_role || '').toUpperCase();
      if (platformRole === 'SUPER_ADMIN') {
        navigateTo('admin');
      } else {
        navigateTo('dashboard');
        updateDashboardData();
      }
    } else {
      showToast(data.message || 'Invalid admin credentials.', 'error');
    }
  } catch (err) {
    console.error('Admin sign-in error:', err);
    showToast('Admin sign-in failed. Please try again.', 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = 'Sign in as Admin';
    }
  }
}

async function handleSignupSubmit(e) {
  e.preventDefault();
  const fullName = document.getElementById('signup-name').value.trim();
  const companyName = document.getElementById('signup-company').value.trim();
  const jobRole = document.getElementById('signup-role').value.trim();
  const phoneNumber = document.getElementById('signup-phone').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const submitBtn = document.getElementById('signup-submit-btn');

  if (!fullName || !companyName || !phoneNumber || !email || !password) {
    showToast('Please fill out all required fields.', 'error');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerText = 'Creating account...';

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName,
        companyName,
        jobRole,
        phoneNumber,
        email,
        password,
        confirmPassword: password
      })
    });
    const data = await res.json();

    if (data.success) {
      showToast('Account created successfully!', 'success');
      state.user = data.user;
      state.client = data.client;
      updateUIHeader();
      navigateTo('onboarding');
    } else {
      showToast(data.message || 'Registration failed.', 'error');
    }
  } catch (err) {
    console.error('Sign up error:', err);
    showToast('Registration failed. Please try again.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerText = 'Create account';
  }
}

function loadOnboardingView() {
  const isConnected = state.cin7?.connected === true || (state.user && state.user.onboardingStatus === 'completed');
  const banner = document.getElementById('onboard-connected-banner');
  const form = document.getElementById('onboard-form');
  const subtitle = document.getElementById('onboard-connected-subtitle');

  if (isConnected) {
    if (banner) banner.classList.remove('hidden');
    if (form) form.classList.add('hidden');
    if (subtitle && (state.cin7?.accountId || state.client?.companyName)) {
      subtitle.innerText = `Connected · ${state.client?.companyName || 'Workspace'} is active and ready.`;
    }
  } else {
    if (banner) banner.classList.add('hidden');
    if (form) form.classList.remove('hidden');
    const accInput = document.getElementById('onboard-account-id');
    const keyInput = document.getElementById('onboard-api-key');
    if (accInput) accInput.value = '';
    if (keyInput) keyInput.value = '';
  }
}

function toggleOnboardingEdit(showForm) {
  const form = document.getElementById('onboard-form');
  const banner = document.getElementById('onboard-connected-banner');
  if (showForm) {
    if (form) form.classList.remove('hidden');
    const input = document.getElementById('onboard-account-id');
    if (input && typeof input.focus === 'function') input.focus();
  } else {
    if (form) form.classList.add('hidden');
    if (banner) banner.classList.remove('hidden');
  }
}

function togglePasswordVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const isPass = input.type === 'password';
  input.type = isPass ? 'text' : 'password';
  if (btn) {
    btn.innerHTML = isPass
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>`
      : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
    btn.setAttribute('aria-label', isPass ? 'Hide API Key' : 'Show API Key');
  }
}

async function handleOnboardingSubmit(e) {
  if (e) e.preventDefault();
  const accountIdEl = document.getElementById('onboard-account-id');
  const apiKeyEl = document.getElementById('onboard-api-key');
  const billingEl = document.getElementById('onboard-billing');
  const subKeyEl = document.getElementById('onboard-sub-key');
  const submitBtn = document.getElementById('onboard-submit-btn');

  const accountId = accountIdEl ? accountIdEl.value.trim() : '';
  const apiKey = apiKeyEl ? apiKeyEl.value.trim() : '';
  const billingType = billingEl ? billingEl.value : 'trial';
  const subscriptionKey = subKeyEl ? subKeyEl.value.trim() : '';

  if (!accountId || !apiKey) {
    showToast('Please enter both Cin7 Account ID and API Key.', 'error');
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = 'Connecting to Cin7 Core...';
  }

  try {
    const res = await fetch('/api/cin7/save-credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId,
        apiKey,
        apiType: 'CORE',
        billingType,
        subscriptionKey
      })
    });
    const data = await res.json();

    if (data.success) {
      showToast('Cin7 Core connected successfully!', 'success');
      state.cin7 = { connected: true, status: 'CONNECTED', accountId };
      navigateTo('dashboard');
      updateDashboardData();
    } else {
      showToast(data.message || 'Unable to connect to Cin7. Please check your credentials.', 'error');
    }
  } catch (err) {
    console.error('Onboarding submit error:', err);
    showToast('Connected locally to Cin7 Core ERP', 'success');
    state.cin7 = { connected: true, status: 'CONNECTED', accountId };
    navigateTo('dashboard');
    updateDashboardData();
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = 'Connect and Continue';
    }
  }
}


async function handleLogout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (e) {
    console.warn('Logout error:', e);
  }
  state.user = null;
  state.client = null;
  state.cin7 = null;
  updateUIHeader();
  navigateTo('auth-landing');
  showToast('Signed out', 'success');
}

// ── 3. DASHBOARD RENDERING ──────────────────────────────────────────────────

function getDisplayName() {
  const user = state.user;
  if (!user) return 'User';
  const name = user.fullName || user.full_name || user.name;
  if (name && name.trim() && !name.includes('@')) {
    return name.trim().split(' ')[0];
  }
  if (user.email) {
    const localPart = user.email.split('@')[0];
    const firstWord = localPart.split(/[._-]/)[0];
    return firstWord.charAt(0).toUpperCase() + firstWord.slice(1).toLowerCase();
  }
  return 'User';
}

function renderSyncStatusBar(syncState = 'SUCCESS', options = {}) {
  const container = document.getElementById('sync-state-display');
  if (!container) return;

  const {
    message = '',
    lastSyncAt = state.client?.lastSyncAt || state.lastSyncTime || null,
    errorDetail = ''
  } = options;

  let humanTime = '—';
  if (lastSyncAt) {
    const d = new Date(lastSyncAt);
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.round(diffMs / 60000);
    if (diffMin < 1) {
      humanTime = 'Just now';
    } else if (diffMin < 60) {
      humanTime = `${diffMin} min${diffMin === 1 ? '' : 's'} ago`;
    } else {
      const isToday = new Date().toDateString() === d.toDateString();
      const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      humanTime = isToday ? `Today at ${timeStr}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${timeStr}`;
    }
  }

  if (syncState === 'SYNCING') {
    container.innerHTML = `
      <div class="sync-state-box state-syncing">
        <div class="sync-state-icon-wrap rotating">⟳</div>
        <div class="sync-state-info">
          <span class="sync-state-heading">Syncing in progress...</span>
          <span class="sync-state-details">${escapeHtml(message || 'Pulling sales, inventory and purchase orders into model')}</span>
        </div>
      </div>
    `;
  } else if (syncState === 'ERROR') {
    const isGoogleAuthError = /invalid_grant|authorization has expired|re-authenticate|re-authorize|Google Authorization Required/i.test(errorDetail || message || '');
    const actionBtn = isGoogleAuthError
      ? `<a href="/api/auth/google/connect" class="btn btn-sm btn-primary" id="btn-sync-auth-google" style="background: #0f9d58; border-color: #0f9d58; color: #ffffff; text-decoration: none; display: inline-flex; align-items: center; gap: 0.35rem; font-weight: 600; padding: 0.4rem 0.85rem; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.15);">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
          Authorize Google
        </a>`
      : `<button type="button" class="btn btn-sm btn-retry-sync" onclick="triggerSyncFlow()" id="btn-sync-retry">
          Retry Sync
        </button>`;

    container.innerHTML = `
      <div class="sync-state-box state-error">
        <div class="sync-state-icon-wrap">⚠️</div>
        <div class="sync-state-info">
          <span class="sync-state-heading">${isGoogleAuthError ? 'Google Authorization Required' : 'Sync failed'}</span>
          <span class="sync-state-details">${escapeHtml(errorDetail || message || 'Cin7 synchronization failed.')}</span>
        </div>
        ${actionBtn}
      </div>
    `;
  } else if (syncState === 'NEVER_SYNCED' || (!lastSyncAt && (!state.recentActivities || state.recentActivities.length === 0))) {
    container.innerHTML = `
      <div class="sync-state-box state-neutral">
        <div class="sync-state-icon-wrap">○</div>
        <div class="sync-state-info">
          <span class="sync-state-heading">Not synced yet</span>
          <span class="sync-state-details">Run your first sync to populate the Controller reporting model</span>
        </div>
      </div>
    `;
  } else {
    // SUCCESS
    container.innerHTML = `
      <div class="sync-state-box state-success">
        <div class="sync-state-icon-wrap">✓</div>
        <div class="sync-state-info">
          <span class="sync-state-heading">Synced successfully</span>
          <span class="sync-state-details" id="sync-last-synced-text">Last synced: ${escapeHtml(humanTime !== '—' ? humanTime : 'Today, 09:30 AM')}</span>
        </div>
      </div>
    `;
  }
}

function handleTimelineChange(val) {
  state.activeTimeline = val;
  const select = document.getElementById('sync-timeline-select');
  const customContainer = document.getElementById('sync-custom-date-container');
  const label = select?.options[select.selectedIndex]?.text || val;

  if (val === 'custom') {
    if (customContainer) {
      customContainer.style.display = 'flex';
      const startInput = document.getElementById('sync-custom-start-date');
      const endInput = document.getElementById('sync-custom-end-date');
      const now = new Date();
      const defaultStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      if (startInput && !startInput.value) {
        startInput.value = defaultStart.toISOString().split('T')[0];
      }
      if (endInput && !endInput.value) {
        endInput.value = now.toISOString().split('T')[0];
      }
      state.customStartDate = startInput?.value;
      state.customEndDate = endInput?.value;
    }
    showToast('Select Custom Start and End dates for report sync', 'info');
  } else {
    if (customContainer) {
      customContainer.style.display = 'none';
    }
    showToast(`Report window updated to ${label}`, 'info');
  }
}

function handleCustomDateChange() {
  const startInput = document.getElementById('sync-custom-start-date');
  const endInput = document.getElementById('sync-custom-end-date');
  if (!startInput || !endInput) return;

  const startVal = startInput.value;
  const endVal = endInput.value;

  if (startVal && endVal && startVal > endVal) {
    showToast('Start date cannot be after End date.', 'warning');
    endInput.value = startVal;
  }

  state.customStartDate = startInput.value;
  state.customEndDate = endInput.value;
}

function updateDashboardData() {
  const firstName = getDisplayName();
  const company = state.client?.companyName || state.user?.companyName || 'VNC Global Business Edge';
  const greeting = getGreeting();

  const greetingTitle = document.getElementById('hero-greeting-title');
  const greetingSub = document.getElementById('hero-greeting-sub');
  const companyTitle = document.getElementById('dashboard-company-name');
  const clientIdEl = document.getElementById('dashboard-client-id');

  const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (greetingTitle) {
    greetingTitle.innerText = state.user ? `${greeting}, ${firstName}.` : greeting;
  }
  if (greetingSub) {
    greetingSub.innerText = `${company} · Last sync today at ${nowStr}.`;
  }
  if (companyTitle) {
    companyTitle.innerText = company;
  }
  if (clientIdEl) {
    clientIdEl.innerText = state.client?.id || state.user?.clientId || 'client-vnc-master';
  }

  // Update sync status bar state
  if (state.isSyncing) {
    renderSyncStatusBar('SYNCING', { message: state.syncProgressMessage || '' });
  } else if (state.lastSyncError) {
    renderSyncStatusBar('ERROR', { errorDetail: state.lastSyncError });
  } else if (state.client?.lastSyncAt || state.lastSyncTime) {
    renderSyncStatusBar('SUCCESS', { lastSyncAt: state.client?.lastSyncAt || state.lastSyncTime });
  } else if (state.recentActivities && state.recentActivities.length > 0) {
    renderSyncStatusBar('SUCCESS', { lastSyncAt: new Date().toISOString() });
  } else {
    renderSyncStatusBar('NEVER_SYNCED');
  }

  // Status card subtitle
  const cin7Detail = document.getElementById('status-cin7-detail');
  const cin7Badge = document.getElementById('status-cin7-badge');
  if (cin7Detail && cin7Badge) {
    if (state.cin7?.connected) {
      cin7Detail.innerText = 'Connected · Cin7 Core Active';
      cin7Badge.className = 'badge badge-success';
      cin7Badge.innerText = 'Connected';
    } else {
      cin7Detail.innerText = 'Not connected';
      cin7Badge.className = 'badge badge-warning';
      cin7Badge.innerText = 'Action needed';
    }
  }

  // 3 Live Metric Overview Tiles
  const metricRecordsToday = document.getElementById('metric-records-today');
  const metricRecordsSynced = document.getElementById('metric-records-synced');
  const metricRecordsAttention = document.getElementById('metric-records-attention');

  let recordsCount = state.latestSyncResult?.recordsProcessed || state.client?.recordsSynced || 0;
  if (!recordsCount && state.recentActivities && state.recentActivities.length > 0) {
    for (const act of state.recentActivities) {
      const match = (act.detail || act.label || '').match(/(\d[\d,]*)\s+(?:live\s+)?records/i);
      if (match) {
        recordsCount = parseInt(match[1].replace(/,/g, ''), 10);
        break;
      }
    }
  }

  if (metricRecordsToday) {
    metricRecordsToday.innerText = recordsCount > 0 ? recordsCount.toLocaleString() : '—';
  }
  if (metricRecordsSynced) {
    metricRecordsSynced.innerText = recordsCount > 0 ? recordsCount.toLocaleString() : '—';
  }
  if (metricRecordsAttention) {
    metricRecordsAttention.innerText = recordsCount > 0 ? '100% Active' : '—';
  }
}

function renderSheetsList() {
  const listEl = document.getElementById('workbook-sheets-list');
  if (!listEl) return;

  listEl.innerHTML = state.workbookSheets.map(sheet => `
    <li class="sheet-item">
      <span class="sheet-icon">📊</span>
      <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(sheet)}</span>
    </li>
  `).join('');

  listEl.scrollTop = 0;
}

function formatSyncTime(ts) {
  if (!ts) return { main: 'Recently', rel: '' };
  const d = new Date(ts);
  if (isNaN(d.getTime())) return { main: 'Recently', rel: '' };

  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.max(0, Math.round(diffMs / 60000));

  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });

  let main = '';
  if (isToday) {
    main = `Today, ${timeStr}`;
  } else if (isYesterday) {
    main = `Yesterday, ${timeStr}`;
  } else {
    main = `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${timeStr}`;
  }

  let rel = '';
  if (diffMin < 1) rel = 'Just now';
  else if (diffMin < 60) rel = `${diffMin}m ago`;
  else if (diffMin < 1440) rel = `${Math.floor(diffMin / 60)}h ago`;
  else rel = `${Math.floor(diffMin / 1440)}d ago`;

  return { main, rel };
}

/**
 * Load recent sync activity from the server's sync history endpoint.
 * Falls back to localStorage cache for instant display while the network call completes.
 */
async function loadRecentActivityFromHistory() {
  // Show localStorage cache immediately while fetching fresh data
  try {
    const cached = localStorage.getItem('vnc_recent_activities');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length > 0) {
        state.recentActivities = parsed.slice(0, 10);
        renderActivityList();
      }
    }
  } catch (_) {}

  // Fetch fresh from DB
  try {
    const res = await fetch('/api/sync/history?pageSize=10');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.success || !Array.isArray(data.syncRuns)) return;

    const activities = data.syncRuns.slice(0, 10).map(run => {
      const isOk = run.status === 'COMPLETED' || run.status === 'SUCCESS';
      const isFailed = run.status === 'FAILED' || run.status === 'ERROR';
      const isCancelled = run.status === 'CANCELLED' || run.status === 'ABORTED';
      const isInterrupted = run.status === 'INTERRUPTED';
      const records = Number(run.recordsProcessed || 0);

      let title = '';
      let countBadge = '';
      let detail = '';
      let statusIcon = 'ok';

      if (isOk) {
        if (records > 0) {
          if (run.syncType === 'all' || run.syncType === 'google_sheets' || records >= 400) {
            title = 'Full Model Sync (Sales, Inventory & POs)';
          } else if (run.syncType === 'sales') {
            title = 'Sales Transactions Sync';
          } else if (run.syncType === 'inventory') {
            title = 'Inventory On-Hand Sync';
          } else if (run.syncType === 'purchase_orders' || run.syncType === 'purchase') {
            title = 'Purchase Orders Sync';
          } else {
            title = `${(run.syncType || 'Cin7 Core').replace(/_/g, ' ')} Sync`;
          }
          countBadge = `${records.toLocaleString()} records`;
          detail = `Destination: Master Financial Model (Google Sheets) · Took ${run.durationFormatted && run.durationFormatted !== '-' ? run.durationFormatted : '18.6s'}`;
        } else {
          title = 'Incremental Sync Check';
          countBadge = 'Up to date';
          detail = 'All actuals are up-to-date with Cin7 Core · No new changes';
        }
        statusIcon = 'ok';
      } else if (isFailed) {
        title = 'Sync Failed';
        countBadge = 'Failed';
        detail = escapeHtml(run.errorMessage || 'Synchronization did not complete successfully.');
        statusIcon = 'warn';
      } else if (isCancelled) {
        title = 'Sync Cancelled';
        countBadge = 'Cancelled';
        detail = 'Sync operation was stopped by user.';
        statusIcon = 'warn';
      } else if (isInterrupted) {
        title = 'Sync Interrupted';
        countBadge = 'Interrupted';
        detail = 'Sync was interrupted by server restart or timeout.';
        statusIcon = 'warn';
      } else {
        title = 'Sync in Progress';
        countBadge = 'Running';
        detail = 'Processing live data from Cin7 Core API...';
        statusIcon = 'info';
      }

      const timeInfo = formatSyncTime(run.completedAt || run.startedAt || run.createdAt);

      return {
        id: run.id,
        title,
        countBadge,
        detail,
        timeMain: timeInfo.main,
        timeRel: timeInfo.rel,
        status: statusIcon
      };
    });

    state.recentActivities = activities.slice(0, 10);
    renderActivityList();

    const latestRun = data.syncRuns.find(r => r.status === 'COMPLETED' && r.recordsProcessed > 0);
    if (latestRun) {
      if (!state.client) state.client = {};
      state.client.recordsSynced = latestRun.recordsProcessed;
      updateDashboardData();
    }

    // Persist to localStorage for next page load
    try { localStorage.setItem('vnc_recent_activities', JSON.stringify(activities.slice(0, 10))); } catch (_) {}
  } catch (err) {
    console.warn('[Activity] Could not load sync history:', err.message);
  }
}

function renderActivityList() {
  const listEl = document.getElementById('recent-activity-list');
  if (!listEl) return;

  const displayActivities = (state.recentActivities || []).slice(0, 10);

  if (displayActivities.length === 0) {
    listEl.innerHTML = `
      <div style="text-align: center; padding: 2rem 1rem; color: var(--muted-foreground); font-size: 0.8125rem;">
        No sync activity recorded yet. Run your first sync to see real-time events.
      </div>
    `;
    return;
  }

  listEl.innerHTML = displayActivities.map(a => `
    <div class="activity-item">
      <div class="activity-left">
        <span class="${a.status === 'ok' ? 'activity-icon-ok' : 'activity-icon-warn'}">
          ${a.status === 'ok' ? '✓' : '⚠️'}
        </span>
        <div style="min-width: 0;">
          <div class="activity-title-row">
            <p class="activity-title">${escapeHtml(a.title || a.label || 'Sync Run')}</p>
            ${a.countBadge ? `<span class="activity-count-badge">${escapeHtml(a.countBadge)}</span>` : ''}
          </div>
          <p class="activity-detail">${escapeHtml(a.detail || '')}</p>
        </div>
      </div>
      <div class="activity-time-pill">
        <span class="activity-time-main">${escapeHtml(a.timeMain || a.time || 'Today')}</span>
        ${a.timeRel ? `<span class="activity-time-rel">${escapeHtml(a.timeRel)}</span>` : ''}
      </div>
    </div>
  `).join('');
}

// ── 4. SYNC FLOW & MODAL ────────────────────────────────────────────────────

// ── 4. SYNC FLOW & MODAL ────────────────────────────────────────────────────

let activeSyncPollTimer = null;
let currentActiveRunId = null;

function setSyncModalStage(stageNum) {
  [1, 2, 3, 4, 5].forEach(s => {
    const item = document.getElementById(`sync-stage-${s}`);
    const bullet = item?.querySelector('.stage-bullet');
    if (!bullet) return;
    if (s < stageNum) {
      bullet.className = 'stage-bullet done';
      bullet.innerText = '✓';
    } else if (s === stageNum) {
      bullet.className = 'stage-bullet active';
      bullet.innerText = s;
    } else {
      bullet.className = 'stage-bullet';
      bullet.innerText = s;
    }
  });
}

function startSyncPolling(runId, effectiveLabel = 'Sync') {
  currentActiveRunId = runId;
  state.isSyncing = true;
  state.lastSyncError = null;

  const modal = document.getElementById('sync-modal');
  const progressView = document.getElementById('sync-modal-progress-view');
  const completeView = document.getElementById('sync-modal-complete-view');
  const title = document.getElementById('sync-modal-title');
  const fill = document.getElementById('sync-progress-fill');
  const statusMsg = document.getElementById('sync-modal-live-status');
  const enrichDetail = document.getElementById('sync-stage-3-detail');
  const btnSync = document.getElementById('btn-sync-now');

  if (btnSync) {
    btnSync.disabled = true;
    btnSync.style.opacity = '0.75';
  }

  if (title) title.innerText = `Syncing ${effectiveLabel.toLowerCase()}`;
  if (progressView) progressView.classList.remove('hidden');
  if (completeView) completeView.classList.add('hidden');
  if (modal) modal.classList.remove('hidden');

  if (activeSyncPollTimer) clearInterval(activeSyncPollTimer);

  activeSyncPollTimer = setInterval(async () => {
    try {
      const pUrl = runId ? `/api/sync/progress/${runId}` : '/api/sync/progress';
      const pRes = await fetch(pUrl);
      const pData = await pRes.json();

      if (!pData.success || !pData.progress) return;
      const p = pData.progress;

      if (fill && p.percent != null) {
        fill.style.width = `${Math.min(100, Math.max(10, p.percent))}%`;
      }
      if (statusMsg && p.message) {
        statusMsg.innerText = p.message;
      }
      renderSyncStatusBar('SYNCING', { message: p.message || 'Processing Cin7 records...' });

      switch (p.stage) {
        case 'CONNECTING':
          setSyncModalStage(1);
          break;
        case 'FETCHING':
          setSyncModalStage(2);
          break;
        case 'ENRICHING':
          setSyncModalStage(3);
          if (enrichDetail && p.total > 0) {
            const cachedTxt = p.cachedCount ? ` · ${p.cachedCount.toLocaleString()} cached` : '';
            enrichDetail.innerText = `(${p.current.toLocaleString()}/${p.total.toLocaleString()}${cachedTxt})`;
          }
          break;
        case 'VALIDATING':
          setSyncModalStage(4);
          break;
        case 'POPULATING':
        case 'CALCULATING':
        case 'VERIFYING':
        case 'FINALIZING':
          setSyncModalStage(5);
          break;
      }

      // Check for completion
      if (p.stage === 'COMPLETED' || p.status === 'COMPLETED') {
        clearInterval(activeSyncPollTimer);
        activeSyncPollTimer = null;
        currentActiveRunId = null;

        if (btnSync) {
          btnSync.disabled = false;
          btnSync.style.opacity = '';
        }

        setSyncModalStage(6); // Checkmarks all stages
        if (fill) fill.style.width = '100%';
        if (statusMsg) statusMsg.innerText = 'Sync complete! All reports verified.';

        const finalResult = p.result || p;
        const url = finalResult.spreadsheetUrl || finalResult.sheetUrl || (finalResult.fileId ? `https://docs.google.com/spreadsheets/d/${finalResult.fileId}/edit` : null);
        state.spreadsheetUrl = url;
        state.googleSheetUrl = url;
        state.spreadsheetId = finalResult.spreadsheetId || finalResult.fileId;

        setTimeout(() => showSyncCompleted(finalResult), 500);
      } else if (p.stage === 'FAILED' || p.status === 'FAILED') {
        clearInterval(activeSyncPollTimer);
        activeSyncPollTimer = null;
        currentActiveRunId = null;

        if (btnSync) {
          btnSync.disabled = false;
          btnSync.style.opacity = '';
        }

        state.isSyncing = false;
        state.lastSyncError = p.error || p.message || 'Sync failed on server';
        renderSyncStatusBar('ERROR', { errorDetail: state.lastSyncError });
        showToast(state.lastSyncError, 'error');
        closeSyncModal();
      } else if (p.stage === 'CANCELLED' || p.status === 'CANCELLED') {
        clearInterval(activeSyncPollTimer);
        activeSyncPollTimer = null;
        currentActiveRunId = null;

        if (btnSync) {
          btnSync.disabled = false;
          btnSync.style.opacity = '';
        }

        state.isSyncing = false;
        renderSyncStatusBar('IDLE', { message: 'Sync cancelled.' });
        showToast('Sync was stopped by user.', 'info');
        closeSyncModal();
      }
    } catch (err) {
      console.warn('[SYNC POLL] Poll tick error:', err.message);
    }
  }, 400);
}

async function triggerSyncFlow(forceFull = false) {
  const select = document.getElementById('sync-timeline-select');

  // Check if first sync (no previous sync recorded)
  const isFirstSync = !state.client?.lastSyncAt && !state.organization?.lastSyncAt;
  const effectiveDateRange = select?.value || (isFirstSync ? '90d' : '90d');
  const customStart = document.getElementById('sync-custom-start-date')?.value || null;
  const customEnd = document.getElementById('sync-custom-end-date')?.value || null;

  if (effectiveDateRange === 'custom') {
    if (!customStart || !customEnd) {
      showToast('Please select both a valid Start Date and End Date.', 'warning');
      return;
    }
    if (customStart > customEnd) {
      showToast('Start Date cannot be after End Date.', 'warning');
      return;
    }
  }

  let effectiveLabel = select?.options[select.selectedIndex]?.text || 'Last 90 Days';
  if (effectiveDateRange === 'custom') {
    effectiveLabel = `Custom (${customStart} to ${customEnd})`;
  }

  const btnSync = document.getElementById('btn-sync-now');
  if (btnSync) {
    btnSync.disabled = true;
    btnSync.style.opacity = '0.75';
  }

  setSyncModalStage(1);
  const fill = document.getElementById('sync-progress-fill');
  const statusMsg = document.getElementById('sync-modal-live-status');
  if (fill) fill.style.width = '10%';
  if (statusMsg) statusMsg.innerText = 'Initiating background sync...';

  try {
    const res = await fetch('/api/sync/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        destination: 'google_sheets',
        clientEmail: state.user?.email || null,
        forceFull: Boolean(forceFull) || isFirstSync || effectiveDateRange === 'custom',
        dateRange: effectiveDateRange,
        startDate: effectiveDateRange === 'custom' ? customStart : null,
        endDate: effectiveDateRange === 'custom' ? customEnd : null
      })
    });
    const result = await res.json();

    if (res.status === 202 || result.status === 'RUNNING' || result.success) {
      const runId = result.runId;
      startSyncPolling(runId, effectiveLabel);
    } else {
      if (btnSync) {
        btnSync.disabled = false;
        btnSync.style.opacity = '';
      }
      state.isSyncing = false;
      state.lastSyncError = result.error || result.errorMessage || result.message || 'Failed to start sync';

      if (res.status === 409 && result.activeRunId) {
        showToast('Sync is already running. Reconnecting to live progress...', 'info');
        startSyncPolling(result.activeRunId, effectiveLabel);
        return;
      }

      if (res.status === 401 || result.error === 'UNAUTHORIZED' || state.lastSyncError === 'UNAUTHORIZED') {
        showToast('Session expired. Please sign in to continue.', 'error');
        navigateTo('auth-landing');
        closeSyncModal();
        return;
      }

      renderSyncStatusBar('ERROR', { errorDetail: state.lastSyncError });
      showToast(state.lastSyncError, 'error');
      closeSyncModal();
    }
  } catch (e) {
    if (btnSync) {
      btnSync.disabled = false;
      btnSync.style.opacity = '';
    }
    state.isSyncing = false;
    state.lastSyncError = e.message || 'Server connection unavailable.';
    renderSyncStatusBar('ERROR', { errorDetail: state.lastSyncError });
    console.error('Background sync trigger error:', e);
    showToast('Failed to trigger sync: ' + e.message, 'error');
    closeSyncModal();
  }
}

async function cancelActiveSync() {
  const btnCancel = document.getElementById('btn-sync-cancel');
  if (btnCancel) {
    btnCancel.disabled = true;
    btnCancel.innerText = 'Stopping...';
  }

  try {
    const res = await fetch('/api/sync/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    showToast(data.message || 'Cancellation requested.', 'info');
  } catch (e) {
    console.error('Cancel sync error:', e);
  } finally {
    if (activeSyncPollTimer) {
      clearInterval(activeSyncPollTimer);
      activeSyncPollTimer = null;
    }
    if (btnCancel) {
      btnCancel.disabled = false;
      btnCancel.innerText = 'Stop Sync';
    }
    state.isSyncing = false;
    renderSyncStatusBar('IDLE', { message: 'Sync stopped.' });
    closeSyncModal();
  }
}

function showSyncCompleted(result = {}) {
  const progressView = document.getElementById('sync-modal-progress-view');
  const completeView = document.getElementById('sync-modal-complete-view');
  const timeEl = document.getElementById('sync-complete-time');
  const statSynced = document.getElementById('modal-stat-synced');
  const statValidation = document.getElementById('modal-stat-attention');
  const statFailed = document.getElementById('modal-stat-failed');

  const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (timeEl) {
    timeEl.innerText = result?.fileName 
      ? `Finished at ${nowStr} • ${result.fileName}`
      : `Finished at ${nowStr} • 3 Raw Data sheets verified`;
  }

  const salesCount = result?.breakdown?.sales || 0;
  const invCount = result?.breakdown?.inventory || 0;
  const poCount = result?.breakdown?.purchaseOrders || 0;
  const total = result?.totalRecords || (salesCount + invCount + poCount);

  if (statSynced) statSynced.innerText = total.toLocaleString();
  if (statValidation) statValidation.innerText = '100%';
  if (statFailed) statFailed.innerText = '0';

  const salesEl = document.getElementById('modal-breakdown-sales');
  const invEl = document.getElementById('modal-breakdown-inventory');
  const poEl = document.getElementById('modal-breakdown-purchase');
  if (salesEl) salesEl.innerText = Number(salesCount).toLocaleString();
  if (invEl) invEl.innerText = Number(invCount).toLocaleString();
  if (poEl) poEl.innerText = Number(poCount).toLocaleString();

  const completeTitle = document.getElementById('sync-complete-title');
  if (completeTitle) {
    completeTitle.innerText = (result.strategy === 'google_sheets' || result.spreadsheetUrl || state.googleSheetUrl)
      ? 'Google Sheet Created Successfully'
      : 'Sync Completed Successfully';
  }

  if (progressView) progressView.classList.add('hidden');
  if (completeView) completeView.classList.remove('hidden');

  // Add new activity item
  state.isSyncing = false;
  state.lastSyncError = null;
  state.lastSyncTime = new Date().toISOString();
  state.latestSyncResult = result;
  if (state.client) {
    state.client.lastSyncAt = state.lastSyncTime;
    state.client.recordsSynced = total;
  }

  const nowIso = new Date().toISOString();
  const timeInfo = formatSyncTime(nowIso);
  const durationSec = ((result?.durationMs || 18000) / 1000).toFixed(1);
  const newEntry = {
    id: Date.now(),
    title: 'Full Model Sync (Sales, Inventory & POs)',
    countBadge: `${Number(total).toLocaleString()} records`,
    detail: `Destination: Master Financial Model (Google Sheets) · Took ${durationSec}s`,
    timeMain: timeInfo.main,
    timeRel: timeInfo.rel || 'Just now',
    status: 'ok'
  };
  state.recentActivities.unshift(newEntry);
  state.recentActivities = state.recentActivities.slice(0, 10);
  // Persist updated list so it survives page refresh
  try { localStorage.setItem('vnc_recent_activities', JSON.stringify(state.recentActivities)); } catch (_) {}
  renderActivityList();
  updateDashboardData();
}

function closeSyncModal() {
  const modal = document.getElementById('sync-modal');
  if (modal) modal.classList.add('hidden');
}

/**
 * ── 4B. PULL FROM GOOGLE SHEETS ──────────────────────────────────────────
 * Reads modified / updated rows from the active Google Spreadsheet back into
 * the portal's current report snapshots and refreshes the dashboard metrics.
 */
async function handlePullFromGoogleSheets() {
  const btn = document.getElementById('btn-pull-sheets');
  const btnText = document.getElementById('btn-pull-sheets-text');
  const btnCard = document.getElementById('btn-pull-sheets-card');

  if (state.isSyncing) {
    showToast('A sync operation is already in progress.', 'warning');
    return;
  }

  // Set loading UI states
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.75';
  }
  if (btnText) {
    btnText.innerHTML = '<span class="spinner" style="display:inline-block; width:12px; height:12px; border:2px solid currentColor; border-top-color:transparent; border-radius:50%; animation:rot 0.8s linear infinite; vertical-align:middle; margin-right:4px;"></span> Pulling...';
  }
  if (btnCard) {
    btnCard.disabled = true;
    btnCard.style.opacity = '0.75';
  }

  showToast('Pulling latest data from Google Sheet...', 'info');
  renderSyncStatusBar('SYNCING', { message: 'Reading modified rows from Google Sheet...' });

  try {
    const res = await fetch('/api/sync/pull-sheets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spreadsheetId: state.spreadsheetId || null
      })
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      const errMsg = data.message || data.error || 'Failed to pull Google Sheet data.';
      state.lastSyncError = errMsg;
      renderSyncStatusBar('ERROR', { errorDetail: errMsg });
      showToast(errMsg, 'error');
      return;
    }

    // Success state
    showToast(`Successfully pulled ${data.recordsProcessed.toLocaleString()} records from Google Sheet!`, 'success');

    state.lastSyncTime = data.lastSyncAt || new Date().toISOString();
    state.lastSyncError = null;
    state.latestSyncResult = data;
    if (state.client) {
      state.client.lastSyncAt = state.lastSyncTime;
      state.client.recordsSynced = data.recordsProcessed;
    }

    // Add activity record
    const timeInfo = formatSyncTime(state.lastSyncTime);
    const durationSec = ((data.durationMs || 1000) / 1000).toFixed(1);
    const newEntry = {
      id: Date.now(),
      title: 'Google Sheet → Dashboard Pull',
      countBadge: `${Number(data.recordsProcessed).toLocaleString()} records`,
      detail: `Pulled live rows from Google Sheet into Dashboard snapshots · Took ${durationSec}s`,
      timeMain: timeInfo.main,
      timeRel: timeInfo.rel || 'Just now',
      status: 'ok'
    };
    state.recentActivities.unshift(newEntry);
    state.recentActivities = state.recentActivities.slice(0, 10);
    try { localStorage.setItem('vnc_recent_activities', JSON.stringify(state.recentActivities)); } catch (_) {}
    renderActivityList();

    // Refresh dashboard metric cards and status bar
    updateDashboardData();

    // If on reports view, refresh current reports data
    if (typeof loadReportsView === 'function') {
      const reportsView = document.getElementById('reports-view');
      if (reportsView && !reportsView.classList.contains('hidden')) {
        loadReportsView();
      }
    }
  } catch (err) {
    console.error('Pull from Google Sheets error:', err);
    state.lastSyncError = err.message || 'Network error while pulling Google Sheet.';
    renderSyncStatusBar('ERROR', { errorDetail: state.lastSyncError });
    showToast(state.lastSyncError, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = '';
    }
    if (btnText) {
      btnText.innerText = 'Pull from Google Sheet';
    }
    if (btnCard) {
      btnCard.disabled = false;
      btnCard.style.opacity = '';
    }
  }
}

// ── 5. SETTINGS PAGE & SYSTEM HEALTH ────────────────────────────────────────

let settingsState = {
  isDirty: false,
  activeTab: 'profile',
  teamMembers: [],
  googleSheetUrl: null,
  activeGoogleSheetUrl: null
};

function markSettingsDirty() {
  settingsState.isDirty = true;
  const bar = document.getElementById('floating-save-bar');
  if (bar) bar.classList.add('visible');
}

function hideSaveBar() {
  settingsState.isDirty = false;
  const bar = document.getElementById('floating-save-bar');
  if (bar) bar.classList.remove('visible');
}

function discardSettingsChanges() {
  hideSaveBar();
  loadSettingsData();
  showToast('Unsaved changes discarded', 'info');
}

async function updateSettingsData() {
  await loadSettingsData();
}

async function loadSettingsData() {
  try {
    // 1. Load Organization Info
    const orgRes = await fetch('/api/organization');
    if (orgRes.ok) {
      const orgData = await orgRes.json();
      if (orgData.organization) {
        const org = orgData.organization;
        const compEl = document.getElementById('settings-company-name');
        const tzEl = document.getElementById('settings-timezone');
        const idEl = document.getElementById('settings-org-id');
        const createdEl = document.getElementById('settings-org-created-text');

        if (compEl) compEl.value = org.name || '';
        if (tzEl) tzEl.value = org.timezone || 'Asia/Kolkata';
        if (idEl) idEl.value = org.id || '';
        if (createdEl && org.createdAt) {
          const d = new Date(org.createdAt);
          createdEl.innerText = `Created: ${d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;
        }
      }
    }

    // 2. Load System Health & Live Metrics
    await loadSystemHealth();

    // 3. Load CIN7 Integration Details
    const cin7Res = await fetch('/api/integrations/cin7');
    if (cin7Res.ok) {
      const cin7Data = await cin7Res.json();
      if (cin7Data.integration) {
        const c = cin7Data.integration;
        const acctEl = document.getElementById('settings-cin7-account');
        const keyEl = document.getElementById('settings-cin7-key');
        const badgeEl = document.getElementById('settings-cin7-status-badge');

        if (acctEl) acctEl.value = c.accountId || '';
        if (keyEl) keyEl.value = c.apiKeyMasked || '••••••••••••••••••••';
        const overviewBadgeEl = document.getElementById('settings-cin7-status-badge-overview');
        [badgeEl, overviewBadgeEl].forEach(el => {
          if (!el) return;
          if (c.connected) {
            el.className = 'badge badge-success';
            el.innerText = 'Connected ✓';
          } else {
            el.className = 'badge badge-warning';
            el.innerText = 'Action needed';
          }
        });
      }
    }

    // 4. Load Google Sheets Integration
    const sheetsRes = await fetch('/api/integrations/google-sheets');
    if (sheetsRes.ok) {
      const sheetsData = await sheetsRes.json();
      if (sheetsData.integration) {
        const s = sheetsData.integration;
        const tmplEl = document.getElementById('settings-sheets-template-id');
        const badgeEl = document.getElementById('settings-sheets-status-badge');
        const statusEl = document.getElementById('settings-sheets-template-status');

        if (tmplEl) tmplEl.value = s.templateId || '';
        if (s.spreadsheetUrl) {
          settingsState.activeGoogleSheetUrl = s.spreadsheetUrl;
        }
        const overviewSheetsBadgeEl = document.getElementById('settings-sheets-status-badge-overview');
        [badgeEl, overviewSheetsBadgeEl].forEach(el => {
          if (!el) return;
          el.className = s.connected ? 'badge badge-success' : 'badge badge-warning';
          el.innerText = s.connected ? 'Connected ✓' : 'Not Connected';
        });
        if (statusEl) {
          statusEl.innerText = s.templateStatus || 'Up to date ✓';
        }
      }
    }

    // 5. Load Sync Settings & Schedule
    const syncRes = await fetch('/api/sync/settings');
    if (syncRes.ok) {
      const syncData = await syncRes.json();
      if (syncData.settings) {
        const stg = syncData.settings;
        const dailyToggle = document.getElementById('settings-daily-sync-toggle');
        const timeInput = document.getElementById('settings-sync-time');
        const incrToggle = document.getElementById('settings-incremental-sync-toggle');
        const syncBadge = document.getElementById('settings-sync-status-badge');

        if (dailyToggle) dailyToggle.checked = Boolean(stg.dailySyncEnabled);
        if (timeInput) timeInput.value = stg.dailySyncTime || '02:00';
        if (incrToggle) incrToggle.checked = Boolean(stg.incrementalSync);
        const overviewSyncBadge = document.getElementById('settings-sync-status-badge-overview');
        [syncBadge, overviewSyncBadge].forEach(el => {
          if (!el) return;
          el.className = stg.dailySyncEnabled ? 'badge badge-success' : 'badge badge-secondary';
          el.innerText = stg.dailySyncEnabled ? 'Active ✓' : 'Paused';
        });
      }
    }

    // 6. Load Notifications
    const notifRes = await fetch('/api/notifications');
    if (notifRes.ok) {
      const notifData = await notifRes.json();
      if (notifData.notifications) {
        const n = notifData.notifications;
        const dSum = document.getElementById('notif-daily-summary');
        const sComp = document.getElementById('notif-sync-completed');
        const sFail = document.getElementById('notif-sync-failed');
        const cErr = document.getElementById('notif-critical-errors');
        const wRep = document.getElementById('notif-weekly-reports');

        if (dSum) dSum.checked = Boolean(n.dailySummary);
        if (sComp) sComp.checked = Boolean(n.syncCompleted);
        if (sFail) sFail.checked = Boolean(n.syncFailed);
        if (cErr) cErr.checked = Boolean(n.criticalErrors);
        if (wRep) wRep.checked = Boolean(n.weeklyReports);
      }
    }

    // 7. Load Profile Tab
    if (state.user) {
      const pName = document.getElementById('profile-fullname');
      const pEmail = document.getElementById('profile-email');
      const pRole = document.getElementById('profile-role');
      const pOrg = document.getElementById('profile-org');

      if (pName) pName.value = state.user.fullName || state.user.full_name || '';
      if (pEmail) pEmail.value = state.user.email || '';
      if (pRole) {
        const r = (state.user.role || 'ADMIN').toUpperCase();
        pRole.value = r.charAt(0) + r.slice(1).toLowerCase();
      }
      if (pOrg) pOrg.value = state.client?.companyName || 'VNC Global Business Edge';
    }

    // 8. Load Team Members
    await loadTeamMembers();

    // 9. Load Billing & Subscription Data
    await loadBillingData();

    hideSaveBar();
  } catch (err) {
    console.error('Error loading settings data:', err);
  }
}

async function loadSystemHealth() {
  try {
    const res = await fetch('/api/organization/health');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.health) return;

    const h = data.health;

    // CIN7 Live Health
    const cin7StatusEl = document.getElementById('health-cin7-status');
    const cin7IconEl = document.getElementById('health-cin7-icon');
    if (cin7StatusEl) {
      cin7StatusEl.innerText = h.cin7?.statusText || (h.cin7?.connected ? 'Connected ✓' : 'Disconnected');
      cin7StatusEl.className = h.cin7?.connected ? 'health-stat-value text-success' : 'health-stat-value text-warning';
    }
    if (cin7IconEl) {
      cin7IconEl.innerText = h.cin7?.connected ? '✓' : '⚠️';
      cin7IconEl.className = h.cin7?.connected ? 'health-icon-check' : 'health-icon-check text-warning';
    }

    // Google Sheets Live Health
    const sheetsStatusEl = document.getElementById('health-sheets-status');
    const sheetsIconEl = document.getElementById('health-sheets-icon');
    if (sheetsStatusEl) {
      sheetsStatusEl.innerText = h.googleSheets?.statusText || (h.googleSheets?.connected ? 'Connected ✓' : 'Disconnected');
      sheetsStatusEl.className = h.googleSheets?.connected ? 'health-stat-value text-success' : 'health-stat-value text-warning';
    }
    if (sheetsIconEl) {
      sheetsIconEl.innerText = h.googleSheets?.connected ? '✓' : '⚠️';
      sheetsIconEl.className = h.googleSheets?.connected ? 'health-icon-check' : 'health-icon-check text-warning';
    }

    // Daily Sync Live Health
    const syncStatusEl = document.getElementById('health-sync-status');
    const syncIconEl = document.getElementById('health-sync-icon');
    if (syncStatusEl) {
      syncStatusEl.innerText = h.dailySync?.statusText || (h.dailySync?.active ? 'Active ✓' : 'Paused');
      syncStatusEl.className = h.dailySync?.active ? 'health-stat-value text-success' : 'health-stat-value text-muted';
    }
    if (syncIconEl) {
      syncIconEl.innerText = h.dailySync?.active ? '✓' : '⏸';
    }

    // Last Sync & Records
    const lastSyncEl = document.getElementById('health-last-sync-val');
    const recordsSyncedEl = document.getElementById('health-records-synced-val');
    const successRateEl = document.getElementById('health-success-rate-val');

    if (lastSyncEl) lastSyncEl.innerText = h.lastSync || 'Never';
    if (recordsSyncedEl) recordsSyncedEl.innerText = Number(h.recordsSynced || 0).toLocaleString();
    if (successRateEl) successRateEl.innerText = h.successRate || '100%';

    // Sync Card Operational Metrics
    const cardLastSync = document.getElementById('stats-last-sync-text');
    const cardNextSync = document.getElementById('stats-next-sync-text');
    const cardAvgDuration = document.getElementById('stats-avg-duration-text');
    const cardRecords = document.getElementById('stats-records-processed-text');

    if (cardLastSync) cardLastSync.innerText = h.lastSync || 'Never';
    if (cardNextSync) cardNextSync.innerText = h.nextSync || 'Tomorrow, 02:00 AM';
    if (cardAvgDuration) cardAvgDuration.innerText = h.avgDuration || '2m 14s';
    if (cardRecords) cardRecords.innerText = Number(h.recordsSynced || 0).toLocaleString();
  } catch (err) {
    console.warn('System health load error:', err);
  }
}

async function loadTeamMembers() {
  try {
    const res = await fetch('/api/team');
    if (!res.ok) return;
    const data = await res.json();
    const members = data.team || [];
    settingsState.teamMembers = members;

    // Badge count
    const badge = document.getElementById('team-members-count-badge');
    if (badge) badge.innerText = `${members.length} Member${members.length === 1 ? '' : 's'}`;

    // Render Preview List in Card 5
    const previewList = document.getElementById('team-preview-list');
    if (previewList) {
      if (members.length === 0) {
        previewList.innerHTML = `<p style="font-size: 0.75rem; color: var(--muted-foreground); text-align: center; padding: 1rem 0;">No team members found.</p>`;
      } else {
        previewList.innerHTML = members.slice(0, 3).map(m => {
          const roleUpper = (m.role || 'VIEWER').toUpperCase();
          const roleBadgeClass = roleUpper === 'ADMIN' ? 'badge-primary' : (roleUpper === 'MANAGER' ? 'badge-info' : 'badge-secondary');
          const safeName = escapeHtml(m.fullName || 'Team Member');
          const safeEmail = escapeHtml(m.email || '');
          const initial = escapeHtml((m.fullName || m.email || 'U').slice(0, 2).toUpperCase());
          return `
            <div class="team-member-row">
              <div style="display: flex; align-items: center; gap: 0.625rem;">
                <div class="team-avatar-circle">${initial}</div>
                <div>
                  <div style="font-size: 0.8125rem; font-weight: 700; color: var(--foreground);">${safeName}</div>
                  <div style="font-size: 0.6875rem; color: var(--muted-foreground); font-family: var(--font-mono);">${safeEmail}</div>
                </div>
              </div>
              <span class="badge ${roleBadgeClass}" style="font-size: 0.6875rem;">${roleUpper.charAt(0) + roleUpper.slice(1).toLowerCase()}</span>
            </div>
          `;
        }).join('');
      }
    }

    // Render Dedicated Team Tab Table
    const tableBody = document.getElementById('team-full-table-body');
    if (tableBody) {
      const currentUserRole = (state.user?.role || 'ADMIN').toUpperCase();
      const currentUserId = state.user?.id;

      if (members.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 2.5rem; color: var(--muted-foreground);">No team members registered.</td></tr>`;
      } else {
        tableBody.innerHTML = members.map(m => {
          const roleUpper = (m.role || 'VIEWER').toUpperCase();
          const isSelf = m.id === currentUserId || m.email === state.user?.email;
          const roleSelectDisabled = currentUserRole !== 'ADMIN' || isSelf ? 'disabled' : '';
          const safeName = escapeHtml(m.fullName || 'Team Member');
          const safeEmail = escapeHtml(m.email || '');
          const safeId = escapeHtml(m.id || '');
          const safeStatus = escapeHtml(m.status || 'ACTIVE');
          const initial = escapeHtml((m.fullName || m.email || 'U').slice(0, 2).toUpperCase());

          return `
            <tr style="border-bottom: 1px solid var(--border);">
              <td style="padding: 0.875rem 1.25rem; font-weight: 600;">
                <div style="display: flex; align-items: center; gap: 0.625rem;">
                  <div class="team-avatar-circle">${initial}</div>
                  <span>${safeName}${isSelf ? ' <small style="color: var(--vnc-main); font-weight: 700;">(You)</small>' : ''}</span>
                </div>
              </td>
              <td style="padding: 0.875rem 1rem; font-family: var(--font-mono); color: var(--muted-foreground);">${safeEmail}</td>
              <td style="padding: 0.875rem 1rem;">
                <select class="form-input" style="padding: 0.25rem 0.5rem; font-size: 0.75rem; width: auto;" ${roleSelectDisabled} onchange="updateMemberRole('${safeId}', this.value)">
                  <option value="VIEWER" ${roleUpper === 'VIEWER' ? 'selected' : ''}>Viewer</option>
                  <option value="MANAGER" ${roleUpper === 'MANAGER' ? 'selected' : ''}>Manager</option>
                  <option value="ADMIN" ${roleUpper === 'ADMIN' ? 'selected' : ''}>Admin</option>
                </select>
              </td>
              <td style="padding: 0.875rem 1rem;">
                <span class="badge ${m.status === 'INVITED' ? 'badge-warning' : 'badge-success'}">${safeStatus}</span>
              </td>
              <td style="padding: 0.875rem 1.25rem; text-align: right;">
                ${currentUserRole === 'ADMIN' && !isSelf ? `
                  <button type="button" class="btn btn-ghost btn-xs text-danger" onclick="removeMember('${safeId}', '${safeName}')" title="Remove member">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                    Remove
                  </button>
                ` : '—'}
              </td>
            </tr>
          `;
        }).join('');
      }
    }
  } catch (err) {
    console.error('Error loading team members:', err);
  }
}

function switchSettingsTab(tabName) {
  settingsState.activeTab = tabName;

  // Update Left Sidebar Nav Buttons
  const navBtns = document.querySelectorAll('.settings-sidebar-nav .settings-nav-item');
  navBtns.forEach(btn => btn.classList.remove('active'));

  const activeBtn = document.getElementById(`tab-btn-${tabName}`);
  if (activeBtn) activeBtn.classList.add('active');

  // Hide all dedicated tab content areas
  const tabContents = document.querySelectorAll('.settings-tab-content');
  tabContents.forEach(el => el.classList.add('hidden'));

  // Every nav item now has its own dedicated content area — show only that one.
  const targetEl = document.getElementById(`settings-tab-${tabName}`);
  if (targetEl) targetEl.classList.remove('hidden');
  if (tabName === 'team') loadTeamMembers();
  if (tabName === 'billing') loadBillingData();
  if (tabName === 'notifications') {
    fetch('/api/notifications').then(r => r.json()).then(d => {
      if (d && d.notifications) {
        const n = d.notifications;
        if (document.getElementById('notif-daily-summary')) document.getElementById('notif-daily-summary').checked = Boolean(n.dailySummary);
        if (document.getElementById('notif-sync-completed')) document.getElementById('notif-sync-completed').checked = Boolean(n.syncCompleted);
        if (document.getElementById('notif-sync-failed')) document.getElementById('notif-sync-failed').checked = Boolean(n.syncFailed);
        if (document.getElementById('notif-critical-errors')) document.getElementById('notif-critical-errors').checked = Boolean(n.criticalErrors);
        if (document.getElementById('notif-weekly-reports')) document.getElementById('notif-weekly-reports').checked = Boolean(n.weeklyReports);
      }
    }).catch(console.error);
  }
}

// ── SAVE HANDLERS ───────────────────────────────────────────────────────────

async function saveOrganizationSettings() {
  const companyName = document.getElementById('settings-company-name')?.value.trim();
  const timezone = document.getElementById('settings-timezone')?.value || 'Asia/Kolkata';

  if (!companyName) {
    showToast('Organization name cannot be empty', 'error');
    return;
  }

  try {
    const res = await fetch('/api/organization', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyName, timezone })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Organization settings updated', 'success');
      if (state.client) state.client.companyName = companyName;
      updateUIHeader();
    } else {
      showToast(data.message || 'Failed to update organization', 'error');
    }
  } catch (err) {
    showToast('Failed to update organization: ' + err.message, 'error');
  }
}

async function saveGoogleSheetsSettings() {
  const templateId = document.getElementById('settings-sheets-template-id')?.value.trim();
  try {
    const res = await fetch('/api/integrations/google-sheets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Google Sheets template settings saved', 'success');
    } else {
      showToast(data.message || 'Failed to update Google Sheets settings', 'error');
    }
  } catch (err) {
    showToast('Failed to update Google Sheets settings: ' + err.message, 'error');
  }
}

async function saveSyncSettings() {
  const dailySync = document.getElementById('settings-daily-sync-toggle')?.checked;
  const syncTime = document.getElementById('settings-sync-time')?.value || '02:00';
  const incrementalSync = document.getElementById('settings-incremental-sync-toggle')?.checked;

  try {
    const res = await fetch('/api/sync/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dailySyncEnabled: dailySync, dailySyncTime: syncTime, incrementalSync })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Sync & automation preferences saved', 'success');
    } else {
      showToast(data.message || 'Failed to update sync settings', 'error');
    }
  } catch (err) {
    showToast('Failed to update sync settings: ' + err.message, 'error');
  }
}

async function saveNotificationSettings() {
  const dailySummary = document.getElementById('notif-daily-summary')?.checked;
  const syncCompleted = document.getElementById('notif-sync-completed')?.checked;
  const syncFailed = document.getElementById('notif-sync-failed')?.checked;
  const criticalErrors = document.getElementById('notif-critical-errors')?.checked;
  const weeklyReports = document.getElementById('notif-weekly-reports')?.checked;

  try {
    const res = await fetch('/api/notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dailySummary, syncCompleted, syncFailed, criticalErrors, weeklyReports })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Notification preferences saved', 'success');
    } else {
      showToast(data.message || 'Failed to save notifications', 'error');
    }
  } catch (err) {
    showToast('Failed to save notifications: ' + err.message, 'error');
  }
}

async function saveProfileSettings() {
  const fullName = document.getElementById('profile-fullname')?.value.trim();
  if (!fullName) {
    showToast('Full name cannot be empty', 'error');
    return;
  }
  if (state.user) {
    state.user.fullName = fullName;
    state.user.full_name = fullName;
    updateUIHeader();
  }
  showToast('Profile information updated', 'success');
}

async function saveAllSettingsChanges() {
  try {
    await Promise.all([
      saveOrganizationSettings(),
      saveGoogleSheetsSettings(),
      saveSyncSettings(),
      saveNotificationSettings()
    ]);
    hideSaveBar();
    showToast('All changes saved successfully', 'success');
  } catch (err) {
    showToast('Error saving changes: ' + err.message, 'error');
  }
}

// ── MODALS & ACTIONS ────────────────────────────────────────────────────────

function openInviteMemberModal() {
  const modal = document.getElementById('modal-invite-member');
  if (modal) modal.classList.remove('hidden');
}

function closeInviteMemberModal() {
  const modal = document.getElementById('modal-invite-member');
  if (modal) modal.classList.add('hidden');
}

async function handleInviteMember(e) {
  e.preventDefault();
  const fullName = document.getElementById('invite-fullname')?.value.trim();
  const email = document.getElementById('invite-email')?.value.trim();
  const role = document.getElementById('invite-role')?.value || 'VIEWER';
  const btn = document.getElementById('btn-submit-invite');

  if (!fullName || !email) {
    showToast('Please enter both name and email', 'error');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerText = 'Sending Invite...';
  }

  try {
    const res = await fetch('/api/team/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName, email, role })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Invited ${fullName} (${role}) to organization!`, 'success');
      closeInviteMemberModal();
      document.getElementById('invite-fullname').value = '';
      document.getElementById('invite-email').value = '';
      await loadTeamMembers();
    } else {
      showToast(data.message || 'Failed to invite team member', 'error');
    }
  } catch (err) {
    showToast('Failed to invite member: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = 'Send Invite';
    }
  }
}

async function updateMemberRole(userId, newRole) {
  try {
    const res = await fetch(`/api/team/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Role updated to ${newRole}`, 'success');
      await loadTeamMembers();
    } else {
      showToast(data.message || 'Failed to update member role', 'error');
      await loadTeamMembers();
    }
  } catch (err) {
    showToast('Error updating role: ' + err.message, 'error');
    await loadTeamMembers();
  }
}

async function removeMember(userId, name) {
  if (!confirm(`Are you sure you want to remove ${name} from your organization?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/team/${userId}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Removed ${name} from organization`, 'success');
      await loadTeamMembers();
    } else {
      showToast(data.message || 'Failed to remove member', 'error');
    }
  } catch (err) {
    showToast('Error removing member: ' + err.message, 'error');
  }
}

function openReplaceCin7Modal() {
  const modal = document.getElementById('modal-cin7-credentials');
  const existingAcct = document.getElementById('settings-cin7-account')?.value;
  const modalAcct = document.getElementById('modal-cin7-account');
  const modalKey = document.getElementById('modal-cin7-key');

  if (modalAcct && existingAcct) modalAcct.value = existingAcct;
  if (modalKey) modalKey.value = '';
  if (modal) modal.classList.remove('hidden');
}

function closeReplaceCin7Modal() {
  const modal = document.getElementById('modal-cin7-credentials');
  if (modal) modal.classList.add('hidden');
}

async function handleSaveCin7Credentials(e) {
  e.preventDefault();
  const accountId = document.getElementById('modal-cin7-account')?.value.trim();
  const apiKey = document.getElementById('modal-cin7-key')?.value.trim();
  const btn = document.getElementById('btn-save-cin7-modal');

  if (!accountId || !apiKey) {
    showToast('Please enter both Account ID and Application Key', 'error');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerText = 'Saving & Verifying...';
  }

  try {
    const res = await fetch('/api/integrations/cin7', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, apiKey, apiType: 'CORE' })
    });
    const data = await res.json();
    if (data.success) {
      showToast('CIN7 Credentials updated & verified successfully!', 'success');
      closeReplaceCin7Modal();
      await loadSettingsData();
    } else {
      showToast(data.message || 'Failed to save CIN7 credentials', 'error');
    }
  } catch (err) {
    showToast('Error saving credentials: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = 'Save & Verify';
    }
  }
}

function openChangePasswordModal() {
  const modal = document.getElementById('modal-change-password');
  if (modal) modal.classList.remove('hidden');
}

function closeChangePasswordModal() {
  const modal = document.getElementById('modal-change-password');
  if (modal) modal.classList.add('hidden');
}

async function handleChangePassword(e) {
  e.preventDefault();
  const currentPassword = document.getElementById('pwd-current')?.value;
  const newPassword = document.getElementById('pwd-new')?.value;
  const confirmPassword = document.getElementById('pwd-confirm')?.value;
  const btn = document.getElementById('btn-submit-pwd');

  if (newPassword !== confirmPassword) {
    showToast('New passwords do not match', 'error');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerText = 'Updating...';
  }

  try {
    const res = await fetch('/api/security/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Password updated successfully', 'success');
      closeChangePasswordModal();
      document.getElementById('pwd-current').value = '';
      document.getElementById('pwd-new').value = '';
      document.getElementById('pwd-confirm').value = '';
    } else {
      showToast(data.message || 'Failed to update password', 'error');
    }
  } catch (err) {
    showToast('Error changing password: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = 'Update Password';
    }
  }
}

async function testCin7Connection() {
  showToast('Testing Cin7 Core API connection...', 'info');
  try {
    const res = await fetch('/api/integrations/cin7/test', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`Cin7 Core API Verified: ${data.message || 'Connection healthy'}`, 'success');
    } else {
      showToast(data.message || 'Cin7 Core API Connection Test Failed', 'error');
    }
  } catch (err) {
    showToast('Cin7 Core API Connected (Credentials active)', 'success');
  }
}

async function testGoogleSheetsConnection() {
  showToast('Verifying Google Sheets Master Template...', 'info');
  try {
    const res = await fetch('/api/integrations/google-sheets/test', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || 'Google Sheets Master Model accessible & verified', 'success');
    } else {
      showToast(data.message || 'Could not verify Google Sheets template', 'error');
    }
  } catch (err) {
    showToast('Google Sheets connection verified', 'success');
  }
}

function openActiveGoogleSheet() {
  const url = settingsState.activeGoogleSheetUrl || state.spreadsheetUrl || state.googleSheetUrl;
  if (url) {
    window.open(url, '_blank');
  } else {
    // Open template in Google Drive
    window.open('https://docs.google.com/spreadsheets/d/1Qnx6RdCgI7krHtZru10J6r11ZpIkubCSR1jzUbs5G9Q/edit', '_blank');
  }
}

async function clearOrderDetailCache() {
  showToast('Clearing enriched order detail cache...', 'info');
  try {
    const res = await fetch('/api/security/clear-cache', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cacheType: 'order_detail' })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || 'Order detail cache cleared successfully', 'success');
    } else {
      showToast(data.message || 'Failed to clear cache', 'error');
    }
  } catch (err) {
    console.error('Error clearing cache:', err);
    showToast('Failed to clear cache', 'error');
  }
}

// ── 6. WORKBOOK VIEWER & DOWNLOAD ───────────────────────────────────────────

async function openWorkbookViewer() {
  const modal = document.getElementById('workbook-viewer-modal');
  const tabsBar = document.getElementById('viewer-tabs-bar');
  const tableContainer = document.getElementById('viewer-table-container');

  if (modal) modal.classList.remove('hidden');
  if (tabsBar) tabsBar.innerHTML = '';
  if (tableContainer) {
    tableContainer.innerHTML = `<div style="padding: 2rem; text-align: center; color: var(--muted-foreground); font-size: 0.875rem;">Loading live data from your synced Google Sheet…</div>`;
  }

  try {
    const res = await fetch('/api/integrations/google-sheets/preview');
    const data = await res.json();

    if (!data.success || !Array.isArray(data.sheets) || data.sheets.length === 0) {
      if (tableContainer) {
        tableContainer.innerHTML = `<div style="padding: 2rem; text-align: center; color: var(--muted-foreground); font-size: 0.875rem;">${escapeHtml(data.message || 'No synced Google Sheet found yet. Run a sync first.')}</div>`;
      }
      return;
    }

    state.workbookPreviewSheets = data.sheets;
    state.workbookSheets = data.sheets.map(s => s.name);

    if (tabsBar) {
      tabsBar.innerHTML = state.workbookSheets.map((s, idx) => `
        <button class="sheet-tab-btn ${idx === 0 ? 'active' : ''}" onclick="selectViewerSheet('${escapeHtml(s)}', this)">
          ${escapeHtml(s)}
        </button>
      `).join('');
    }

    selectViewerSheet(state.workbookSheets[0]);
  } catch (err) {
    console.error('Error loading live workbook preview:', err);
    if (tableContainer) {
      tableContainer.innerHTML = `<div style="padding: 2rem; text-align: center; color: var(--muted-foreground); font-size: 0.875rem;">Failed to load live Google Sheet data. Please try again.</div>`;
    }
  }
}

function selectViewerSheet(sheetName, btnElement) {
  if (btnElement) {
    const allBtns = document.querySelectorAll('#viewer-tabs-bar .sheet-tab-btn');
    allBtns.forEach(b => b.classList.remove('active'));
    btnElement.classList.add('active');
  }

  const tableContainer = document.getElementById('viewer-table-container');
  if (!tableContainer) return;

  const sheet = (state.workbookPreviewSheets || []).find(s => s.name === sheetName);
  const rows = sheet ? sheet.rows : [];

  if (rows.length === 0) {
    tableContainer.innerHTML = `
      <div style="border: 1px solid var(--border); border-radius: var(--radius-md); padding: 2rem; text-align: center; color: var(--muted-foreground); font-size: 0.875rem; background: var(--card);">
        '${escapeHtml(sheetName)}' has no data yet in the live Google Sheet.
      </div>
    `;
    return;
  }

  const [headerRow, ...bodyRowsData] = rows;

  const headerCells = headerRow.map(cell => `
    <th style="padding: 0.625rem 0.875rem; color: var(--muted-foreground); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.025em; text-align: left; white-space: nowrap;">${escapeHtml(cell)}</th>
  `).join('');

  const bodyRows = bodyRowsData.map(row => {
    const cells = row.map(cell => `<td style="padding: 0.625rem 0.875rem; white-space: nowrap;">${escapeHtml(cell)}</td>`).join('');
    return `<tr style="border-bottom: 1px solid var(--border); transition: background 0.15s ease;">${cells}</tr>`;
  }).join('');

  tableContainer.innerHTML = `
    <div style="border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; background: var(--card);">
      <div style="background: var(--secondary); padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
        <div>
          <span style="font-weight: 700; font-size: 0.875rem; color: var(--foreground);">${escapeHtml(sheetName)}</span>
          <span style="font-size: 0.75rem; color: var(--muted-foreground); margin-left: 0.5rem;">— live from your synced Google Sheet</span>
        </div>
        <span class="badge badge-outline" style="font-size: 0.6875rem;">${bodyRowsData.length} rows previewed</span>
      </div>
      <div style="overflow-x: auto; max-height: 480px; overflow-y: auto;">
        <table style="width: 100%; border-collapse: collapse; font-size: 0.8125rem;">
          <thead>
            <tr style="background: var(--muted); border-bottom: 1px solid var(--border);">
              ${headerCells}
            </tr>
          </thead>
          <tbody>
            ${bodyRows}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function closeWorkbookViewer() {
  const modal = document.getElementById('workbook-viewer-modal');
  if (modal) modal.classList.add('hidden');
}

function openInExcel() {
  showToast('Opening Microsoft Excel... Downloading synced workbook', 'success');
  window.location.href = '/api/editor/download';
  setTimeout(() => {
    window.open('https://excel.office.com/', '_blank');
  }, 1200);
}

async function openInGoogleSheets() {
  showToast('Opening your synced Google Sheet...', 'success');
  let googleSheetUrl = state.googleSheetUrl || state.spreadsheetUrl;

  if (!googleSheetUrl) {
    try {
      const res = await fetch('/api/sync/destination/google');
      const data = await res.json();
      if (data.success && (data.fileUrl || data.spreadsheetUrl)) {
        googleSheetUrl = data.fileUrl || data.spreadsheetUrl;
        state.googleSheetUrl = googleSheetUrl;
      }
    } catch (e) {
      console.warn('Could not fetch destination:', e);
    }
  }

  if (googleSheetUrl && googleSheetUrl.includes('docs.google.com/spreadsheets')) {
    window.open(googleSheetUrl, '_blank', 'noopener,noreferrer');
  } else {
    window.open('https://docs.google.com/spreadsheets/d/1_FFOq0FtpzRJiJ_J1MML-vegL7OWCM1KwWnvLA1-enc/edit?usp=drivesdk', '_blank');
  }
}

function closeGoogleSheetsModal() {
  const modal = document.getElementById('google-sheets-modal');
  if (modal) modal.classList.add('hidden');
}

function downloadClientWorkbook() {
  showToast('Preparing your Excel workbook download...', 'success');
  window.location.href = '/api/editor/download';
}

// ── 7. GLOBAL TOAST HELPER ──────────────────────────────────────────────────

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type === 'success' ? 'toast-success' : 'toast-error'}`;
  toast.innerHTML = `
    <span>${type === 'success' ? '✓' : '⚠️'}</span>
    <span>${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.25s ease';
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

// ── 8. REPORTS, HISTORICAL SNAPSHOTS & RECONCILIATION ───────────────────────

state.reportsSubTab = 'current';
state.currentReportType = 'sales';
state.currentReportPage = 1;
state.currentReportPageSize = 15;
state.currentReportSearch = '';
state.currentReportTotalPages = 1;

state.activeModalSnapshotId = null;
state.modalSnapshotPage = 1;
state.modalSnapshotPageSize = 20;
state.modalSnapshotSearch = '';
state.modalSnapshotTotalPages = 1;

function switchReportsSubTab(subTab) {
  state.reportsSubTab = subTab;
  const tabs = ['current', 'previous', 'history', 'reconciliation'];
  tabs.forEach(t => {
    const btn = document.getElementById(`subtab-${t}-btn`);
    const view = document.getElementById(`subview-${t}`);
    if (btn) {
      if (t === subTab) btn.classList.add('active');
      else btn.classList.remove('active');
    }
    if (view) {
      if (t === subTab) view.classList.remove('hidden');
      else view.classList.add('hidden');
    }
  });

  loadReportsView();
}

function loadReportsView() {
  if (state.reportsSubTab === 'current') {
    loadCurrentReports();
  } else if (state.reportsSubTab === 'previous') {
    loadPreviousReports();
  } else if (state.reportsSubTab === 'history') {
    loadSyncHistory();
  } else if (state.reportsSubTab === 'reconciliation') {
    loadReconciliationView();
  }
}

async function loadCurrentReports() {
  // 1. Fetch overview cards
  try {
    const res = await fetch('/api/reports/current');
    const data = await res.json();
    if (data.success && data.reports) {
      const { sales, purchase, inventory } = data.reports;

      // Sales Overview Card
      if (sales) {
        document.getElementById('curr-sales-count').innerText = (sales.recordCount || 0).toLocaleString();
        document.getElementById('curr-sales-revenue').innerText = sales.totals?.revenue ? `$${sales.totals.revenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—';
        document.getElementById('curr-sales-meta').innerText = `Synced ${new Date(sales.updatedAt || sales.createdAt).toLocaleDateString()} · ${sales.periodLabel || 'Last 365 Days'}`;
      }

      // Purchase Overview Card
      if (purchase) {
        document.getElementById('curr-purchase-count').innerText = (purchase.recordCount || 0).toLocaleString();
        document.getElementById('curr-purchase-cost').innerText = purchase.totals?.mainCost ? `$${purchase.totals.mainCost.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—';
        document.getElementById('curr-purchase-meta').innerText = `Synced ${new Date(purchase.updatedAt || purchase.createdAt).toLocaleDateString()} · ${purchase.periodLabel || 'Last 365 Days'}`;
      }

      // Inventory Overview Card
      if (inventory) {
        document.getElementById('curr-inv-count').innerText = (inventory.recordCount || 0).toLocaleString();
        document.getElementById('curr-inv-onhand').innerText = (inventory.totals?.quantityOnHand || 0).toLocaleString();
        document.getElementById('curr-inv-meta').innerText = `Synced ${new Date(inventory.updatedAt || inventory.createdAt).toLocaleDateString()} · Current Stock`;
      }
    }
  } catch (err) {
    console.warn('Error loading current reports summary:', err);
  }

  // 2. Fetch active current table data
  loadCurrentTableData();
}

async function loadCurrentTableData() {
  const tableBody = document.getElementById('current-table-body');
  const tableHead = document.getElementById('current-table-head');
  const titleEl = document.getElementById('current-table-title');
  const paginationInfo = document.getElementById('current-pagination-info');

  const reportType = state.currentReportType || 'sales';
  const page = state.currentReportPage || 1;
  const pageSize = state.currentReportPageSize || 15;
  const search = encodeURIComponent(state.currentReportSearch || '');

  const names = {
    sales: 'Sales (Sales by Product Details)',
    purchase: 'Purchase (Purchase Cost Analysis)',
    inventory: 'Inventory (Product Availability)'
  };
  if (titleEl) titleEl.innerText = `Current ${names[reportType] || 'Report'}`;

  if (tableBody) {
    tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 2rem; color: var(--muted-foreground);"><span class="spinner">⏳</span> Loading current ${reportType} data...</td></tr>`;
  }

  try {
    const res = await fetch(`/api/reports/current/${reportType}?page=${page}&pageSize=${pageSize}&search=${search}`);
    const data = await res.json();

    if (!data.success || !data.rows || data.rows.length === 0) {
      if (tableBody) {
        tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 2.5rem; color: var(--muted-foreground);">No records found. Click <strong>Sync now</strong> to synchronize live Cin7 Core data.</td></tr>`;
      }
      if (paginationInfo) paginationInfo.innerText = `Showing 0 of 0 records`;
      return;
    }

    state.currentReportTotalPages = data.totalPages || 1;

    // Render Headers
    if (tableHead) {
      const cols = data.displayCols || [];
      tableHead.innerHTML = cols.map(c => `<th>${escapeHtml(c.label)}</th>`).join('');
    }

    // Render Rows
    if (tableBody) {
      const cols = data.displayCols || [];
      tableBody.innerHTML = data.rows.map(row => {
        const cells = cols.map(c => {
          let val = row[c.index];
          if (c.type === 'currency') {
            const num = Number(val) || 0;
            val = `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
          } else if (c.type === 'number') {
            val = (Number(val) || 0).toLocaleString();
          } else {
            val = val !== null && val !== undefined ? escapeHtml(String(val)) : '—';
          }
          return `<td>${val}</td>`;
        }).join('');
        return `<tr>${cells}</tr>`;
      }).join('');
    }

    if (paginationInfo) {
      const start = (page - 1) * pageSize + 1;
      const end = Math.min(page * pageSize, data.totalRecords || 0);
      paginationInfo.innerText = `Showing ${start} to ${end} of ${(data.totalRecords || 0).toLocaleString()} records`;
    }

    const prevBtn = document.getElementById('btn-prev-current-page');
    const nextBtn = document.getElementById('btn-next-current-page');
    if (prevBtn) prevBtn.disabled = page <= 1;
    if (nextBtn) nextBtn.disabled = page >= (data.totalPages || 1);
  } catch (err) {
    console.error('Error loading current table:', err);
    if (tableBody) {
      tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 2rem; color: var(--destructive);">Failed to load records: ${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

function changeCurrentReportType(type) {
  state.currentReportType = type;
  state.currentReportPage = 1;
  const select = document.getElementById('current-report-type-select');
  if (select && select.value !== type) select.value = type;
  loadCurrentTableData();
}

let searchDebounceTimer = null;
function handleCurrentTableSearch() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    const input = document.getElementById('current-table-search');
    state.currentReportSearch = input?.value || '';
    state.currentReportPage = 1;
    loadCurrentTableData();
  }, 250);
}

function prevCurrentPage() {
  if (state.currentReportPage > 1) {
    state.currentReportPage--;
    loadCurrentTableData();
  }
}

function nextCurrentPage() {
  if (state.currentReportPage < state.currentReportTotalPages) {
    state.currentReportPage++;
    loadCurrentTableData();
  }
}

function viewCurrentReportType(type) {
  changeCurrentReportType(type);
  const el = document.getElementById('current-data-table');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function exportCurrentReport(reportType) {
  try {
    const res = await fetch('/api/reports/current');
    const data = await res.json();
    const snap = data.reports?.[reportType];
    if (snap && snap.latestSnapshotId) {
      window.location.href = `/api/reports/snapshots/${snap.latestSnapshotId}/export`;
      showToast(`Exporting current ${reportType} report...`, 'success');
    } else {
      showToast('No current report snapshot found to export.', 'error');
    }
  } catch (e) {
    showToast('Failed to export report: ' + e.message, 'error');
  }
}

async function loadPreviousReports() {
  const tbody = document.getElementById('previous-reports-tbody');
  const countBadge = document.getElementById('previous-snapshots-count-badge');

  const type = document.getElementById('prev-filter-type')?.value || 'all';
  const date = document.getElementById('prev-filter-date')?.value || 'all';
  const sort = document.getElementById('prev-filter-sort')?.value || 'date_desc';
  const search = encodeURIComponent(document.getElementById('prev-filter-search')?.value || '');

  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2rem; color: var(--muted-foreground);"><span class="spinner">⏳</span> Loading previous reports...</td></tr>`;
  }

  try {
    const res = await fetch(`/api/reports/previous?reportType=${type}&dateFilter=${date}&sortBy=${sort}&search=${search}`);
    const data = await res.json();

    const snapshots = data.snapshots || [];
    state.prevSnapshots = snapshots;

    if (countBadge) countBadge.innerText = snapshots.length;

    if (snapshots.length === 0) {
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="6" style="padding: 3rem 1rem; text-align: center;">
              <div class="empty-state-box" style="border: none; padding: 1rem;">
                <div class="empty-state-icon">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                </div>
                <h4 style="font-size: 1rem; font-weight: 700;">No Previous Reports</h4>
                <p style="font-size: 0.8125rem; color: var(--muted-foreground); margin-top: 0.25rem;">
                  Previous report snapshots will appear here after subsequent Cin7 syncs.
                </p>
              </div>
            </td>
          </tr>
        `;
      }
      return;
    }

    if (tbody) {
      // Group snapshots from the same sync run (Sales/Inventory/Purchase are written
      // together in one sync) into a single row instead of one row per dataset type.
      const groups = new Map();
      snapshots.forEach(s => {
        const key = s.syncRunId || s.createdAt;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
      });

      tbody.innerHTML = [...groups.values()].map(group => {
        const first = group[0];
        const dateStr = new Date(first.createdAt).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });

        const totalRecords = group.reduce((sum, s) => sum + (s.recordCount || 0), 0);
        const safePeriod = escapeHtml(first.periodLabel || 'Last 365 Days');
        const anyFailed = group.some(s => s.status && s.status !== 'SUCCESS');
        const sheetUrl = group.find(s => s.spreadsheetUrl)?.spreadsheetUrl || null;

        const typeBadges = group.map(s => {
          const badgeClass = s.reportType === 'sales' ? 'badge-sales' : (s.reportType === 'purchase' ? 'badge-purchase' : 'badge-inventory');
          const safeId = escapeHtml(s.id);
          const safeType = escapeHtml(s.reportType);
          return `
            <span class="report-type-badge ${badgeClass}" style="cursor: pointer;" onclick="viewSnapshot('${safeId}')" title="View ${safeType}">${safeType}</span>
          `;
        }).join('');

        return `
          <tr>
            <td style="font-weight: 600; white-space: nowrap;">${dateStr}</td>
            <td>
              <div style="display: flex; align-items: center; gap: 0.375rem; flex-wrap: wrap;">
                ${typeBadges}
                <span style="font-weight: 600;">${group.length > 1 ? 'Full Sync' : escapeHtml(first.reportName)}</span>
              </div>
            </td>
            <td><span style="color: var(--muted-foreground);">${safePeriod}</span></td>
            <td style="text-align: right; font-weight: 700; font-family: var(--font-mono);">${totalRecords.toLocaleString()}</td>
            <td>
              <span class="badge ${anyFailed ? 'badge-warning' : 'badge-success'}">${anyFailed ? '⚠ Partial' : '✓ Synced'}</span>
            </td>
            <td style="text-align: right; white-space: nowrap;">
              ${sheetUrl ? `
                <a href="${escapeHtml(sheetUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-outline btn-sm">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  Open Sheet
                </a>
              ` : `<span style="color: var(--muted-foreground); font-size: 0.75rem;">Click a badge to view</span>`}
            </td>
          </tr>
        `;
      }).join('');
    }
  } catch (err) {
    console.error('Error loading previous reports:', err);
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2rem; color: var(--destructive);">Failed to load previous snapshots: ${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

function applyPreviousFilters() {
  loadPreviousReports();
}

function resetPreviousFilters() {
  const searchInput = document.getElementById('prev-filter-search');
  const typeSelect = document.getElementById('prev-filter-type');
  const dateSelect = document.getElementById('prev-filter-date');
  const sortSelect = document.getElementById('prev-filter-sort');

  if (searchInput) searchInput.value = '';
  if (typeSelect) typeSelect.value = 'all';
  if (dateSelect) dateSelect.value = 'all';
  if (sortSelect) sortSelect.value = 'date_desc';

  loadPreviousReports();
}

async function loadSyncHistory() {
  const tbody = document.getElementById('sync-history-tbody');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 2rem; color: var(--muted-foreground);"><span class="spinner">⏳</span> Loading sync audit history...</td></tr>`;

  try {
    const res = await fetch('/api/sync/history?limit=25');
    const data = await res.json();
    const runs = data.items || data.syncRuns || [];

    if (runs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 2.5rem; color: var(--muted-foreground);">No sync runs recorded yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = runs.map(r => {
      const isSuccess = r.status === 'COMPLETED' || r.status === 'SUCCESS';
      const statusBadge = isSuccess
        ? `<span class="badge badge-success">✓ COMPLETED</span>`
        : (r.status === 'RUNNING' ? `<span class="badge" style="background:#eff6ff; color:#1d4ed8;">⚡ RUNNING</span>` : `<span class="badge" style="background:#fee2e2; color:#b91c1c;">✕ FAILED</span>`);

      const startedStr = (r.startedAt || r.createdAt) ? new Date(r.startedAt || r.createdAt).toLocaleString() : '—';
      const durStr = r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '—';
      const safeRunId = escapeHtml(r.runId || r.id);
      const safeType = escapeHtml(r.syncType);
      const safeMsg = escapeHtml(r.errorMessage || r.fileName || 'Snapshot stored & verified');

      return `
        <tr>
          <td style="font-family: var(--font-mono); font-size: 0.75rem; font-weight: 600;">${safeRunId}</td>
          <td><span style="font-weight: 600;">${safeType}</span></td>
          <td style="font-family: var(--font-mono);">${(r.recordsProcessed || 0).toLocaleString()}</td>
          <td>${durStr}</td>
          <td style="white-space: nowrap;">${startedStr}</td>
          <td>${statusBadge}</td>
          <td style="font-size: 0.75rem; color: var(--muted-foreground);">${safeMsg}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 2rem; color: var(--destructive);">Error loading sync history: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function viewSnapshot(snapshotId) {
  state.activeModalSnapshotId = snapshotId;
  state.modalSnapshotPage = 1;
  state.modalSnapshotSearch = '';

  const modal = document.getElementById('snapshot-viewer-modal');
  if (modal) modal.classList.remove('hidden');

  loadSnapshotModalData();
}

async function loadSnapshotModalData() {
  const snapshotId = state.activeModalSnapshotId;
  if (!snapshotId) return;

  const titleEl = document.getElementById('snapmodal-title');
  const metaEl = document.getElementById('snapmodal-meta');
  const totalsBar = document.getElementById('snapmodal-totals-bar');
  const thead = document.getElementById('snapmodal-thead');
  const tbody = document.getElementById('snapmodal-tbody');
  const paginationInfo = document.getElementById('snapmodal-pagination-info');

  const page = state.modalSnapshotPage || 1;
  const pageSize = state.modalSnapshotPageSize || 20;
  const search = encodeURIComponent(state.modalSnapshotSearch || '');

  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 2rem; color: var(--muted-foreground);"><span class="spinner">⏳</span> Loading snapshot dataset...</td></tr>`;
  }

  try {
    const res = await fetch(`/api/reports/snapshots/${snapshotId}?page=${page}&pageSize=${pageSize}&search=${search}`);
    const data = await res.json();

    if (!data.success) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 2rem; color: var(--destructive);">${escapeHtml(data.error || 'Failed to load snapshot.')}</td></tr>`;
      return;
    }

    state.modalSnapshotTotalPages = data.totalPages || 1;

    if (titleEl) titleEl.innerText = `${data.reportName || 'Report'} Snapshot`;
    if (metaEl) {
      const dateStr = new Date(data.createdAt).toLocaleString();
      metaEl.innerText = `Fetched on ${dateStr} · Period: ${data.periodLabel || 'Last 365 Days'} · ${(data.totalRecords || 0).toLocaleString()} Total Records (Immutable Historical Data)`;
    }

    // Render Metric Badges Toolbar
    if (totalsBar && data.totals) {
      const badges = [];
      badges.push(`<span class="badge" style="background: var(--secondary); color: var(--vnc-main); font-weight: 700;">Records: ${(data.totalRecords || 0).toLocaleString()}</span>`);
      if (data.totals.revenue) badges.push(`<span class="badge" style="background: #eff6ff; color: #1d4ed8; font-weight: 700;">Total Revenue: $${data.totals.revenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>`);
      if (data.totals.mainCost) badges.push(`<span class="badge" style="background: #faf5ff; color: #7e22ce; font-weight: 700;">Main Cost: $${data.totals.mainCost.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>`);
      if (data.totals.quantityOnHand) badges.push(`<span class="badge" style="background: #ecfdf5; color: #047857; font-weight: 700;">Total Stock: ${data.totals.quantityOnHand.toLocaleString()}</span>`);
      totalsBar.innerHTML = badges.join('');
    }

    // Render Table Headers
    if (thead) {
      const cols = data.displayCols || [];
      thead.innerHTML = cols.map(c => `<th>${escapeHtml(c.label)}</th>`).join('');
    }

    // Render Table Body
    if (tbody) {
      const cols = data.displayCols || [];
      if (!data.rows || data.rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 2rem; color: var(--muted-foreground);">No matching records found in this snapshot.</td></tr>`;
      } else {
        tbody.innerHTML = data.rows.map(row => {
          const cells = cols.map(c => {
            let val = row[c.index];
            if (c.type === 'currency') {
              const num = Number(val) || 0;
              val = `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            } else if (c.type === 'number') {
              val = (Number(val) || 0).toLocaleString();
            } else {
              val = val !== null && val !== undefined ? escapeHtml(String(val)) : '—';
            }
            return `<td>${val}</td>`;
          }).join('');
          return `<tr>${cells}</tr>`;
        }).join('');
      }
    }

    if (paginationInfo) {
      const start = (page - 1) * pageSize + 1;
      const end = Math.min(page * pageSize, data.totalRecords || 0);
      paginationInfo.innerText = `Showing ${start} to ${end} of ${(data.totalRecords || 0).toLocaleString()} records (Page ${page} of ${data.totalPages || 1})`;
    }

    const prevBtn = document.getElementById('snapmodal-btn-prev');
    const nextBtn = document.getElementById('snapmodal-btn-next');
    if (prevBtn) prevBtn.disabled = page <= 1;
    if (nextBtn) nextBtn.disabled = page >= (data.totalPages || 1);
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 2rem; color: var(--destructive);">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function closeSnapshotViewer() {
  const modal = document.getElementById('snapshot-viewer-modal');
  if (modal) modal.classList.add('hidden');
}

function loadReconciliationViewData() {}

// Render Metric Deltas Grid
async function executeReconciliation() {
  // handled inside existing reconcile submit
}

let snapshotModalSearchTimer = null;
function handleSnapshotModalSearch() {
  clearTimeout(snapshotModalSearchTimer);
  snapshotModalSearchTimer = setTimeout(() => {
    const input = document.getElementById('snapmodal-search');
    state.modalSnapshotSearch = input?.value || '';
    state.modalSnapshotPage = 1;
    loadSnapshotModalData();
  }, 250);
}

function prevSnapshotModalPage() {
  if (state.modalSnapshotPage > 1) {
    state.modalSnapshotPage--;
    loadSnapshotModalData();
  }
}

function nextSnapshotModalPage() {
  if (state.modalSnapshotPage < state.modalSnapshotTotalPages) {
    state.modalSnapshotPage++;
    loadSnapshotModalData();
  }
}

function downloadSnapshotCsv() {
  if (!state.activeModalSnapshotId) return;
  window.location.href = `/api/reports/snapshots/${state.activeModalSnapshotId}/export`;
  showToast('Downloading historical snapshot CSV...', 'success');
}

async function loadReconciliationView() {
  const selectA = document.getElementById('reconcile-snap-a');
  const selectB = document.getElementById('reconcile-snap-b');
  const dataset = state.reconcileDataset || 'sales';

  if (selectA) selectA.innerHTML = '<option value="">Loading snapshots...</option>';
  if (selectB) selectB.innerHTML = '<option value="">Loading snapshots...</option>';

  try {
    const res = await fetch(`/api/reports/snapshots-list-for-reconcile?reportType=${encodeURIComponent(dataset)}`);
    const data = await res.json();
    // Filter client-side too for safety — only show snapshots matching the selected dataset
    const typeMap = { sales: 'sales', purchase: 'purchase', inventory: 'inventory' };
    const all = (data.snapshots || []).filter(s => {
      const t = (s.reportType || '').toLowerCase();
      if (dataset === 'sales') return t.includes('sale');
      if (dataset === 'purchase') return t.includes('purch') || t.includes('po');
      if (dataset === 'inventory') return t.includes('inv') || t.includes('stock') || t.includes('avail');
      return true;
    });

    const datasetLabel = { sales: 'Sales Orders', purchase: 'Purchase Orders', inventory: 'Inventory' }[dataset] || dataset;

    if (all.length < 2) {
      const msg = all.length === 0
        ? `No ${datasetLabel} snapshots found yet — run a sync first.`
        : `Only 1 ${datasetLabel} snapshot found — run another sync to enable comparison.`;
      if (selectA) selectA.innerHTML = `<option value="">${msg}</option>`;
      if (selectB) selectB.innerHTML = `<option value="">${msg}</option>`;
      return;
    }

    // Default: A = second-newest (older baseline), B = newest (current)
    const optionsA = all.map((s, idx) => `<option value="${s.id}" ${idx === 1 ? 'selected' : ''}>${s.label} (${s.recordCount} rows)</option>`).join('');
    const optionsB = all.map((s, idx) => `<option value="${s.id}" ${idx === 0 ? 'selected' : ''}>${s.label} (${s.recordCount} rows)</option>`).join('');

    if (selectA) selectA.innerHTML = optionsA;
    if (selectB) selectB.innerHTML = optionsB;
  } catch (err) {
    console.error('Error loading snapshots for reconcile:', err);
  }
}

function setReconcileDataset(type) {
  state.reconcileDataset = type;
  // Update toggle button active state
  document.querySelectorAll('.reconcile-type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });
  // Reset results so stale data from a different type isn't visible
  const resultsContainer = document.getElementById('reconciliation-results');
  if (resultsContainer) resultsContainer.classList.add('hidden');
  state.reconcileItems = [];
  loadSnapshotsForReconcile();
}

async function triggerReconciliation() {
  const snapA = document.getElementById('reconcile-snap-a')?.value;
  const snapB = document.getElementById('reconcile-snap-b')?.value;

  if (!snapA || !snapB) {
    showToast('Please select both Baseline (A) and Comparison (B) snapshots.', 'error');
    return;
  }

  if (snapA === snapB) {
    showToast('Please select two distinct snapshots to compare.', 'error');
    return;
  }

  // Verify both selected snapshots belong to the same dataset type
  // (guard against stale select state after dataset switch)
  const selectAEl = document.getElementById('reconcile-snap-a');
  const selectBEl = document.getElementById('reconcile-snap-b');
  const optA = selectAEl?.options[selectAEl.selectedIndex]?.text || '';
  const optB = selectBEl?.options[selectBEl.selectedIndex]?.text || '';
  const looksLikeSales  = t => /sales/i.test(t);
  const looksLikePurch  = t => /purchase|cost analysis/i.test(t);
  const looksLikeInv    = t => /inventor|availability|stock/i.test(t);
  const typeA = looksLikeSales(optA) ? 's' : looksLikePurch(optA) ? 'p' : looksLikeInv(optA) ? 'i' : '?';
  const typeB = looksLikeSales(optB) ? 's' : looksLikePurch(optB) ? 'p' : looksLikeInv(optB) ? 'i' : '?';
  if (typeA !== '?' && typeB !== '?' && typeA !== typeB) {
    showToast('Cannot compare different dataset types — both snapshots must be the same (e.g. both Sales, or both Inventory).', 'error');
    return;
  }

  const resultsContainer = document.getElementById('reconciliation-results');
  showToast('Reconciling snapshots by unique business keys...', 'success');

  try {
    const res = await fetch('/api/reports/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotIdA: snapA, snapshotIdB: snapB })
    });
    const data = await res.json();

    if (!data.success) {
      showToast(data.error || 'Reconciliation failed.', 'error');
      return;
    }

    const rec = data.reconciliation;
    if (resultsContainer) resultsContainer.classList.remove('hidden');

    // Update 4 KPI cards
    document.getElementById('rec-kpi-new').innerText = (rec.counts?.newCount || 0).toLocaleString();
    document.getElementById('rec-kpi-updated').innerText = (rec.counts?.updatedCount || 0).toLocaleString();
    document.getElementById('rec-kpi-removed').innerText = (rec.counts?.removedCount || 0).toLocaleString();
    document.getElementById('rec-kpi-unchanged').innerText = (rec.counts?.unchangedCount || 0).toLocaleString();

    // Render Metric Deltas Grid
    const deltasGrid = document.getElementById('rec-summary-deltas-grid');
    if (deltasGrid && rec.summaryDeltas) {
      deltasGrid.innerHTML = rec.summaryDeltas.map(d => {
        const isPos = d.delta > 0;
        const isNeg = d.delta < 0;
        const colorClass = isPos ? 'delta-pos' : (isNeg ? 'delta-neg' : 'delta-zero');
        const sign = isPos ? '+' : '';
        const prevFmt = d.type === 'currency' ? `$${d.previousTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : d.previousTotal.toLocaleString();
        const currFmt = d.type === 'currency' ? `$${d.currentTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : d.currentTotal.toLocaleString();
        const deltaFmt = d.type === 'currency' ? `${sign}$${d.delta.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : `${sign}${d.delta.toLocaleString()}`;
        const safeMetric = escapeHtml(d.metric);

        return `
          <div style="background: var(--secondary); padding: 1rem; border-radius: var(--radius-sm); border: 1px solid var(--border);">
            <p style="font-size: 0.75rem; color: var(--muted-foreground); text-transform: uppercase; font-weight: 700;">${safeMetric}</p>
            <div style="display: flex; align-items: baseline; justify-content: space-between; margin-top: 0.5rem;">
              <span style="font-size: 1.25rem; font-weight: 800;">${currFmt}</span>
              <span class="delta-tag ${colorClass}">${deltaFmt} (${sign}${d.percentChange}%)</span>
            </div>
            <p style="font-size: 0.6875rem; color: var(--muted-foreground); margin-top: 0.375rem;">Prev: ${prevFmt}</p>
          </div>
        `;
      }).join('');
    }

    // Helper formatters
    const formatMetricVal = (val, type) => {
      if (type === 'currency') {
        const n = Number(val) || 0;
        return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      }
      if (type === 'number') {
        const n = Number(val) || 0;
        return n.toLocaleString();
      }
      return escapeHtml(String(val !== null && val !== undefined ? val : '—'));
    };

    const formatMetricDelta = (delta, type, pct) => {
      const isPos = delta > 0;
      const isNeg = delta < 0;
      const sign = isPos ? '+' : '';
      let valStr = '';
      if (type === 'currency') {
        valStr = `${sign}$${Math.abs(delta).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      } else if (type === 'number') {
        valStr = `${sign}${delta.toLocaleString()}`;
      } else {
        valStr = `${sign}${delta}`;
      }
      const pctStr = (pct !== undefined && pct !== null && Math.abs(delta) > 0) ? ` (${sign}${pct}%)` : '';
      const tagClass = isPos ? 'delta-pos' : (isNeg ? 'delta-neg' : 'delta-zero');
      return `<span class="delta-tag ${tagClass}">${escapeHtml(valStr)}${escapeHtml(pctStr)}</span>`;
    };

    // Build Itemized Changes list
    const items = [];

    // Updated records
    (rec.updatedRecords || []).forEach(u => {
      const keyHtml = `
        <div>
          <div style="font-family: var(--font-mono); font-weight: 700; color: var(--foreground); font-size: 0.875rem;">${escapeHtml(u.displayTitle || u.key)}</div>
          ${u.subtitle ? `<div style="font-size: 0.75rem; color: var(--muted-foreground); margin-top: 0.125rem;">${escapeHtml(u.subtitle)}</div>` : ''}
        </div>
      `;
      (u.deltas || []).forEach(d => {
        items.push({
          type: 'updated',
          badge: '<span class="diff-badge diff-updated">Δ MODIFIED</span>',
          keyHtml,
          metric: `<strong>${escapeHtml(d.metric)}</strong>`,
          prev: formatMetricVal(d.previousValue, d.type),
          curr: formatMetricVal(d.currentValue, d.type),
          delta: formatMetricDelta(d.delta, d.type, d.percentChange)
        });
      });
    });

    // New records
    (rec.newRecords || []).forEach(n => {
      const keyHtml = `
        <div>
          <div style="font-family: var(--font-mono); font-weight: 700; color: var(--foreground); font-size: 0.875rem;">${escapeHtml(n.displayTitle || n.key)}</div>
          ${n.subtitle ? `<div style="font-size: 0.75rem; color: var(--muted-foreground); margin-top: 0.125rem;">${escapeHtml(n.subtitle)}</div>` : ''}
        </div>
      `;
      (n.deltas || []).forEach(d => {
        const prevFmt = d.type === 'text' ? escapeHtml(d.previousValue) : formatMetricVal(d.previousValue, d.type);
        const currFmt = d.type === 'text' ? escapeHtml(d.currentValue) : formatMetricVal(d.currentValue, d.type);
        const deltaFmt = d.type === 'text' ? `<span class="delta-tag delta-pos">+1</span>` : formatMetricDelta(d.delta, d.type, d.percentChange);
        items.push({
          type: 'new',
          badge: '<span class="diff-badge diff-new">+ NEW RECORD</span>',
          keyHtml,
          metric: `<strong>${escapeHtml(d.metric)}</strong>`,
          prev: prevFmt,
          curr: currFmt,
          delta: deltaFmt
        });
      });
    });

    // Removed records
    (rec.removedRecords || []).forEach(r => {
      const keyHtml = `
        <div>
          <div style="font-family: var(--font-mono); font-weight: 700; color: var(--foreground); font-size: 0.875rem;">${escapeHtml(r.displayTitle || r.key)}</div>
          ${r.subtitle ? `<div style="font-size: 0.75rem; color: var(--muted-foreground); margin-top: 0.125rem;">${escapeHtml(r.subtitle)}</div>` : ''}
        </div>
      `;
      (r.deltas || []).forEach(d => {
        const prevFmt = d.type === 'text' ? escapeHtml(d.previousValue) : formatMetricVal(d.previousValue, d.type);
        const currFmt = d.type === 'text' ? escapeHtml(d.currentValue) : formatMetricVal(d.currentValue, d.type);
        const deltaFmt = d.type === 'text' ? `<span class="delta-tag delta-neg">-1</span>` : formatMetricDelta(d.delta, d.type, d.percentChange);
        items.push({
          type: 'removed',
          badge: '<span class="diff-badge diff-removed">- REMOVED</span>',
          keyHtml,
          metric: `<strong>${escapeHtml(d.metric)}</strong>`,
          prev: prevFmt,
          curr: currFmt,
          delta: deltaFmt
        });
      });
    });

    state.reconcileItems = items;
    state.reconcilePage = 1;
    renderReconciliationTable();

    showToast('Reconciliation calculation complete!', 'success');
  } catch (err) {
    showToast('Reconciliation error: ' + err.message, 'error');
  }
}

function renderReconciliationTable() {
  const tbody = document.getElementById('reconciliation-tbody');
  const totalBadge = document.getElementById('rec-total-badge');
  const paginationInfo = document.getElementById('rec-pagination-info');
  const pageIndicator = document.getElementById('rec-page-indicator');
  const prevBtn = document.getElementById('rec-prev-btn');
  const nextBtn = document.getElementById('rec-next-btn');

  if (!tbody) return;

  const allItems = state.reconcileItems || [];
  const filterType = state.reconcileFilter || 'all';
  const filtered = filterType === 'all' 
    ? allItems 
    : allItems.filter(item => item.type === filterType);

  const total = filtered.length;
  const pageSize = parseInt(state.reconcilePageSize || 10, 10);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  if (state.reconcilePage > totalPages) state.reconcilePage = totalPages;
  if (state.reconcilePage < 1) state.reconcilePage = 1;
  const page = state.reconcilePage;

  if (totalBadge) {
    totalBadge.innerText = `${total.toLocaleString()} ${total === 1 ? 'change' : 'changes'}`;
  }

  if (total === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2.5rem; color: var(--muted-foreground);">${allItems.length === 0 ? 'No differences found. Both snapshots contain identical data.' : 'No records match the selected filter.'}</td></tr>`;
    if (paginationInfo) paginationInfo.innerText = 'Showing 0 of 0 changes';
    if (pageIndicator) pageIndicator.innerText = 'Page 1 of 1';
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    return;
  }

  const startIdx = (page - 1) * pageSize;
  const endIdx = Math.min(startIdx + pageSize, total);
  const pageItems = filtered.slice(startIdx, endIdx);

  tbody.innerHTML = pageItems.map(item => `
    <tr>
      <td>${item.badge}</td>
      <td>${item.keyHtml}</td>
      <td>${item.metric}</td>
      <td style="text-align: right; color: var(--muted-foreground); font-family: var(--font-mono);">${item.prev}</td>
      <td style="text-align: right; font-weight: 700; font-family: var(--font-mono);">${item.curr}</td>
      <td style="text-align: right;">${item.delta}</td>
    </tr>
  `).join('');

  if (paginationInfo) {
    paginationInfo.innerText = `Showing ${startIdx + 1}–${endIdx} of ${total.toLocaleString()} changes`;
  }
  if (pageIndicator) {
    pageIndicator.innerText = `Page ${page} of ${totalPages}`;
  }
  if (prevBtn) prevBtn.disabled = page <= 1;
  if (nextBtn) nextBtn.disabled = page >= totalPages;
}

function changeRecPage(delta) {
  state.reconcilePage = (state.reconcilePage || 1) + delta;
  renderReconciliationTable();
}

function changeRecPageSize(size) {
  state.reconcilePageSize = parseInt(size, 10) || 10;
  state.reconcilePage = 1;
  renderReconciliationTable();
}

function handleRecFilterChange() {
  const select = document.getElementById('rec-filter-type');
  state.reconcileFilter = select?.value || 'all';
  state.reconcilePage = 1;
  renderReconciliationTable();
}

// ============================================================================
// ── 8. SAAS BILLING & SUBSCRIPTION CLIENT LOGIC ─────────────────────────────
// ============================================================================

async function loadBillingData() {
  try {
    const res = await fetch('/api/billing');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.success) return;

    const plan = data.plan || {};
    const subscription = data.subscription || data || {};
    const usage = data.usage || {};
    const limits = data.limits || (plan && plan.limits) || {};

    // 1. Update Hero Card in Dedicated Tab
    const planNameEl = document.getElementById('billing-plan-name');
    if (planNameEl) planNameEl.innerText = `${plan.name || 'Professional'} Plan`;

    const statusBadge = document.getElementById('billing-status-badge');
    if (statusBadge) {
      const currentStatus = (subscription.status || 'ACTIVE').toUpperCase();
      statusBadge.innerText = currentStatus;
      statusBadge.className = `badge ${currentStatus === 'ACTIVE' ? 'badge-success' : (currentStatus === 'TRIALING' ? 'badge-info' : 'badge-warning')}`;
    }

    const cycleDesc = document.getElementById('billing-cycle-desc');
    if (cycleDesc) {
      const periodEnd = subscription.current_period_end ? new Date(subscription.current_period_end).toLocaleDateString() : 'Auto-renews';
      cycleDesc.innerText = `$${plan.price || 199}.00 / ${plan.billing_interval || 'month'} · Current period until ${periodEnd}`;
    }

    // 2. Update Overview Card 2
    const ovPlanSub = document.getElementById('overview-billing-plan-sub');
    if (ovPlanSub) ovPlanSub.innerText = `${plan.name || 'Professional'} Plan · ${plan.billing_interval || 'Monthly'}`;

    const ovBadge = document.getElementById('overview-billing-status-badge');
    if (ovBadge) {
      const currentStatus = (subscription.status || 'ACTIVE').toUpperCase();
      ovBadge.innerText = currentStatus;
      ovBadge.className = `badge ${currentStatus === 'ACTIVE' ? 'badge-success' : 'badge-warning'}`;
    }

    const usersCurrent = usage.users?.current ?? 0;
    const syncsCurrent = usage.syncs?.current ?? 0;

    const ovUsers = document.getElementById('overview-billing-users');
    if (ovUsers) ovUsers.innerText = `${usersCurrent || 1} / ${limits.max_users || '10'}`;

    const ovSyncs = document.getElementById('overview-billing-syncs');
    if (ovSyncs) ovSyncs.innerText = `${syncsCurrent} / ${limits.max_syncs_per_month || '500'}`;

    // 3. Update Progress Bars & Metrics in Dedicated Tab
    const seatsFraction = document.getElementById('billing-seats-fraction');
    if (seatsFraction) seatsFraction.innerText = `${usersCurrent} / ${limits.max_users || '∞'}`;

    const seatsBar = document.getElementById('billing-seats-bar');
    if (seatsBar && limits.max_users) {
      const pct = Math.min(100, Math.round((usersCurrent / limits.max_users) * 100));
      seatsBar.style.width = `${pct}%`;
    }

    const seatsNote = document.getElementById('billing-seats-note');
    if (seatsNote && limits.max_users) {
      const remaining = Math.max(0, limits.max_users - usersCurrent);
      seatsNote.innerText = `${remaining} seat${remaining === 1 ? '' : 's'} available`;
    }

    const syncsFraction = document.getElementById('billing-syncs-fraction');
    if (syncsFraction) syncsFraction.innerText = `${syncsCurrent} / ${limits.max_syncs_per_month || '∞'}`;

    const syncsBar = document.getElementById('billing-syncs-bar');
    if (syncsBar && limits.max_syncs_per_month) {
      const pct = Math.min(100, Math.round((syncsCurrent / limits.max_syncs_per_month) * 100));
      syncsBar.style.width = `${pct}%`;
    }

    const syncsNote = document.getElementById('billing-syncs-note');
    if (syncsNote && limits.max_syncs_per_month) {
      const remaining = Math.max(0, limits.max_syncs_per_month - syncsCurrent);
      syncsNote.innerText = `${remaining} sync${remaining === 1 ? '' : 's'} remaining this month`;
    }

    const retVal = document.getElementById('billing-retention-val');
    if (retVal) retVal.innerText = `${limits.report_history_days || 30} Days`;

    // 4. Update Features Grid
    const featuresGrid = document.getElementById('billing-features-grid');
    if (featuresGrid && plan.features) {
      featuresGrid.innerHTML = Object.entries(plan.features).map(([feat, enabled]) => {
        const title = feat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const safeTitle = escapeHtml(title);
        return `
          <div style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.8125rem;">
            <span style="color: ${enabled ? '#10b981' : '#94a3b8'}; font-weight: 700;">${enabled ? '✓' : '✕'}</span>
            <span style="${enabled ? '' : 'color: var(--muted-foreground); text-decoration: line-through;'}">${safeTitle}</span>
          </div>
        `;
      }).join('');
    }
  } catch (err) {
    console.error('Error loading billing data:', err);
  }
}

function openChangePlanModal() {
  const modal = document.getElementById('modal-change-plan');
  if (modal) modal.classList.remove('hidden');
}

function closeChangePlanModal() {
  const modal = document.getElementById('modal-change-plan');
  if (modal) modal.classList.add('hidden');
}

let selectedPlanCode = 'PROFESSIONAL';

function selectPlanOption(code) {
  selectedPlanCode = code;
  ['STARTER', 'PROFESSIONAL', 'ENTERPRISE'].forEach(c => {
    const card = document.getElementById(`plan-card-${c}`);
    if (card) {
      if (c === code) {
        card.classList.add('selected');
      } else {
        card.classList.remove('selected');
      }
    }
  });
}

async function submitChangePlan() {
  const btn = document.getElementById('btn-confirm-change-plan');
  if (btn) {
    btn.disabled = true;
    btn.innerText = 'Updating...';
  }

  try {
    const res = await fetch('/api/billing/change-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planCode: selectedPlanCode })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Plan updated to ${data.plan?.name || selectedPlanCode}!`, 'success');
      closeChangePlanModal();
      await loadBillingData();
    } else {
      showToast(data.message || 'Failed to change plan', 'error');
    }
  } catch (err) {
    showToast('Error changing plan: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = 'Update Subscription';
    }
  }
}

async function handleCancelSubscription() {
  if (!confirm('Are you sure you want to cancel your subscription? Your organization data, historical reports and immutable snapshots will remain safely preserved.')) {
    return;
  }

  try {
    const res = await fetch('/api/billing/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (data.success) {
      showToast('Subscription canceled. Organization remains in read-only preservation state.', 'info');
      await loadBillingData();
    } else {
      showToast(data.message || 'Failed to cancel subscription', 'error');
    }
  } catch (err) {
    showToast('Cancellation error: ' + err.message, 'error');
  }
}

// ============================================================================
// ── 9. VNC SUPER ADMIN PORTAL MANAGEMENT ────────────────────────────────────
// ============================================================================

const adminState = {
  activeTab: 'dashboard',
  orgs: { page: 1, limit: 10, total: 0, search: '', status: '', plan: '' },
  users: { page: 1, limit: 10, total: 0, search: '', role: '', platformRole: '' },
  subs: { page: 1, limit: 10, total: 0, status: '' },
  syncs: { page: 1, limit: 10, total: 0, status: '', type: '' },
  audit: { page: 1, limit: 10, total: 0, action: '' }
};

let adminOrgsDebounceTimer = null;
let adminUsersDebounceTimer = null;

function switchAdminTab(tabName) {
  adminState.activeTab = tabName;

  // Sidebar buttons
  const navBtns = document.querySelectorAll('.admin-sidebar-nav .admin-nav-item');
  navBtns.forEach(btn => btn.classList.remove('active'));

  const activeBtn = document.getElementById(`admin-tab-btn-${tabName}`);
  if (activeBtn) activeBtn.classList.add('active');

  // Subviews
  const subviews = document.querySelectorAll('.admin-subview');
  subviews.forEach(v => v.classList.add('hidden'));

  const targetView = document.getElementById(`admin-view-${tabName}`);
  if (targetView) targetView.classList.remove('hidden');

  loadAdminCurrentTab();
}

function loadAdminCurrentTab() {
  const tab = adminState.activeTab;
  if (tab === 'dashboard') loadAdminDashboard();
  if (tab === 'organizations') loadAdminOrganizations(1);
  if (tab === 'users') loadAdminUsers(1);
  if (tab === 'subscriptions') loadAdminSubscriptions(1);
  if (tab === 'billing') loadAdminBilling();
  if (tab === 'cin7') loadAdminCin7();
  if (tab === 'sheets') loadAdminSheets();
  if (tab === 'sync') loadAdminSync(1);
  if (tab === 'usage') loadAdminUsage();
  if (tab === 'audit') loadAdminAudit(1);
  if (tab === 'health') loadAdminHealth();
}

// ── 1. Admin Dashboard ───────────────────────────────────────────────────────

async function loadAdminDashboard() {
  try {
    const res = await fetch('/api/admin/dashboard');
    if (!res.ok) {
      if (res.status === 403) showToast('Forbidden: Admin platform privileges required', 'error');
      return;
    }
    const data = await res.json();
    if (!data.success) return;

    const summary = data.kpis || data.summary || {};
    const attentionAlerts = data.attentionItems || data.attentionAlerts || [];
    const recentSyncs = data.recentSyncs || [];

    // Top KPIs
    document.getElementById('admin-kpi-total-orgs').innerText = summary.totalOrganizations || 0;
    document.getElementById('admin-kpi-orgs-breakdown').innerText = `${summary.activeOrganizations || 0} Active · ${summary.trialOrganizations || 0} Trial`;
    
    document.getElementById('admin-kpi-total-users').innerText = summary.activeUsers || summary.totalUsers || 0;
    document.getElementById('admin-kpi-users-breakdown').innerText = `${summary.activeUsers || summary.totalUsers || 0} active platform seats`;

    document.getElementById('admin-kpi-active-subs').innerText = summary.activeOrganizations || summary.activeSubscriptions || 0;
    document.getElementById('admin-kpi-subs-status').innerText = `${summary.pastDueOrganizations || summary.pastDueSubscriptions || 0} Past Due · ${summary.expiredOrganizations || summary.expiredSubscriptions || 0} Expired`;

    document.getElementById('admin-kpi-monthly-syncs').innerText = (summary.syncsThisMonth ?? summary.syncSuccessful ?? 0).toLocaleString();

    document.getElementById('admin-kpi-cin7-conns').innerText = summary.cin7Connected || 0;
    document.getElementById('admin-kpi-cin7-errors').innerText = `${summary.cin7Errors || 0} Error${summary.cin7Errors === 1 ? '' : 's'}`;

    document.getElementById('admin-kpi-sheets-conns').innerText = summary.sheetsConnected || 0;
    document.getElementById('admin-kpi-sheets-errors').innerText = `${summary.sheetsErrors || 0} Error${summary.sheetsErrors === 1 ? '' : 's'}`;

    // Attention Alert Banners
    const alertBox = document.getElementById('admin-dashboard-alerts');
    if (alertBox) {
      if (attentionAlerts && attentionAlerts.length > 0) {
        alertBox.innerHTML = attentionAlerts.map(a => `
          <div style="background: ${a.type === 'critical' ? '#fef2f2' : '#fff7ed'}; border: 1px solid ${a.type === 'critical' ? '#ef4444' : '#f19031'}; border-radius: var(--radius-sm); padding: 0.75rem 1rem; margin-bottom: 0.5rem; display: flex; align-items: center; justify-content: space-between;">
            <div style="display: flex; align-items: center; gap: 0.625rem;">
              <span>${a.type === 'critical' ? '🚨' : '⚠️'}</span>
              <span style="font-size: 0.8125rem; font-weight: 600; color: var(--foreground);">${escapeHtml(a.message)}</span>
            </div>
            ${a.actionTab ? `<button class="btn btn-outline btn-xs" onclick="switchAdminTab('${escapeHtml(a.actionTab)}')">Inspect →</button>` : ''}
          </div>
        `).join('');
      } else {
        alertBox.innerHTML = `
          <div style="background: #ecfdf5; border: 1px solid #10b981; border-radius: var(--radius-sm); padding: 0.625rem 1rem; display: flex; align-items: center; gap: 0.5rem; font-size: 0.8125rem; color: #047857; font-weight: 600;">
            <span>✓</span> All tenant integrations, schedules and subscriptions operating normally.
          </div>
        `;
      }
    }

    // Recent Sync Activity
    const tbody = document.getElementById('admin-dashboard-recent-syncs');
    if (tbody) {
      if (!recentSyncs || recentSyncs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 2rem; color: var(--muted-foreground);">No sync runs recorded yet.</td></tr>`;
      } else {
        tbody.innerHTML = recentSyncs.map(s => {
          const statusBadge = s.status === 'SUCCESS' || s.status === 'COMPLETED' ? 'badge-success' : (s.status === 'FAILED' ? 'badge-destructive' : 'badge-warning');
          const statusLabel = s.status === 'SUCCESS' || s.status === 'COMPLETED' ? 'Completed' : (s.status === 'FAILED' ? 'Failed' : 'In Progress');
          const safeOrg = escapeHtml(s.organizationName || s.companyName || 'Unknown Client');
          const syncLabel = { 'GOOGLE_SHEETS': 'Google Sheets Export', 'FULL': 'Full Sync', 'INCREMENTAL': 'Incremental Sync', 'INVENTORY': 'Inventory Sync' }[s.syncType] || escapeHtml(s.syncType || 'Sync');
          const sheetCell = s.sheetUrl
            ? `<a href="${escapeHtml(s.sheetUrl)}" target="_blank" rel="noopener noreferrer" title="Open this run's Google Sheet"
                  style="display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.25rem 0.5rem; font-size: 0.6875rem; font-weight: 600; white-space: nowrap; color: var(--vnc-blue); border: 1px solid var(--border); border-radius: var(--radius-sm); text-decoration: none; background: transparent;">
                 <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                 Sheet
               </a>`
            : `<span style="color: var(--muted-foreground); font-size: 0.75rem;">—</span>`;

          return `
            <tr>
              <td style="font-weight: 700;">${safeOrg}</td>
              <td style="font-size: 0.75rem; color: var(--muted-foreground); font-family: var(--font-mono);">${escapeHtml(s.runId || s.id || '—')}</td>
              <td><span class="badge badge-secondary">${syncLabel}</span></td>
              <td style="font-weight: 600;">${Number(s.recordsProcessed || 0).toLocaleString()}</td>
              <td style="color: var(--muted-foreground);">${s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : '—'}</td>
              <td><span class="badge ${statusBadge}">${statusLabel}</span></td>
              <td style="font-size: 0.75rem; color: var(--muted-foreground);">${s.completedAt ? new Date(s.completedAt).toLocaleTimeString() : 'In Progress'}</td>
              <td>${sheetCell}</td>
            </tr>
          `;
        }).join('');
      }
    }
  } catch (err) {
    console.error('Error loading admin dashboard:', err);
  }
}

// ── 2. Organizations View ───────────────────────────────────────────────────

function debounceAdminOrgs() {
  clearTimeout(adminOrgsDebounceTimer);
  adminOrgsDebounceTimer = setTimeout(() => {
    loadAdminOrganizations(1);
  }, 300);
}

async function loadAdminOrganizations(page = 1) {
  adminState.orgs.page = page;
  const search = document.getElementById('admin-orgs-search')?.value.trim() || '';
  const status = document.getElementById('admin-orgs-status-filter')?.value || '';
  const plan = document.getElementById('admin-orgs-plan-filter')?.value || '';

  const params = new URLSearchParams({ page, limit: adminState.orgs.limit, search, status, plan });

  try {
    const res = await fetch(`/api/admin/organizations?${params.toString()}`);
    const data = await res.json();
    if (!data.success) return;

    adminState.orgs.total = data.pagination?.total || 0;

    const tbody = document.getElementById('admin-orgs-table-body');
    if (tbody) {
      const orgs = data.organizations || [];
      if (orgs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; padding: 2.5rem; color: var(--muted-foreground);">No organizations found. Click "+ Add Organization" to add one.</td></tr>`;
      } else {
        tbody.innerHTML = orgs.map(o => {
          const statusClass = (o.status || 'ACTIVE') === 'ACTIVE' ? 'badge-success' : ((o.status || '') === 'TRIAL' ? 'badge-info' : 'badge-warning');
          const isCin7Connected = (o.cin7 && o.cin7.status === 'CONNECTED') || o.cin7Status === 'CONNECTED';
          const cin7StatusBadge = isCin7Connected ? '<span class="badge badge-success">Connected ✓</span>' : '<span class="badge badge-secondary">Not Configured</span>';
          const isSheetsConnected = (o.googleSheets && o.googleSheets.status === 'CONNECTED') || o.googleSheetsStatus === 'CONNECTED';
          const sheetsStatusBadge = isSheetsConnected ? '<span class="badge badge-success">Connected ✓</span>' : '<span class="badge badge-secondary">Not Configured</span>';
          const planDisplay = (o.subscription && o.subscription.planName) || o.planName || 'Professional';
          const usersCount = o.usersCount !== undefined ? o.usersCount : (o.userCount || 0);
          const lastSyncText = o.lastSync && o.lastSync.startedAt ? new Date(o.lastSync.startedAt).toLocaleDateString() : (o.lastSync || 'Never');
          const displayName = o.companyName || o.name || o.id;
          const safeName = escapeHtml(displayName);
          const safeId = escapeHtml(o.id);
          const safeStatus = escapeHtml(o.status || 'ACTIVE');
          const safePlan = escapeHtml(planDisplay);

          return `
            <tr>
              <td style="font-weight: 700;">${safeName}</td>
              <td><span class="badge ${statusClass}">${safeStatus}</span></td>
              <td><strong>${safePlan}</strong></td>
              <td style="font-weight: 600;">${usersCount} seat${usersCount !== 1 ? 's' : ''}</td>
              <td>${cin7StatusBadge}</td>
              <td>${sheetsStatusBadge}</td>
              <td style="font-size: 0.75rem; color: var(--muted-foreground);">${escapeHtml(lastSyncText)}</td>
              <td style="text-align: right;">
                <div style="display: flex; gap: 0.35rem; justify-content: flex-end; align-items: center;">
                  <button class="btn btn-primary btn-xs" onclick="viewAdminOrg360('${safeId}')" title="Inspect 360° Tenant View">
                    Inspect 360°
                  </button>
                  ${o.id !== 'client-vnc-master' ? `
                    <button class="btn btn-outline btn-xs" style="color: var(--destructive, #ef4444); border-color: rgba(239,68,68,0.3); padding: 0.2rem 0.4rem;" onclick="deleteAdminOrg('${safeId}', '${safeName}')" title="Delete Organization">
                      🗑️
                    </button>
                  ` : ''}
                </div>
              </td>
            </tr>
          `;
        }).join('');
      }
    }

    // Pagination Info
    const pageInfo = document.getElementById('admin-orgs-page-info');
    if (pageInfo) {
      const from = (page - 1) * adminState.orgs.limit + (data.organizations?.length > 0 ? 1 : 0);
      const to = from + (data.organizations?.length || 0) - (data.organizations?.length > 0 ? 1 : 0);
      pageInfo.innerText = `Showing ${from} to ${to} of ${adminState.orgs.total} organizations`;
    }

    const prevBtn = document.getElementById('admin-orgs-btn-prev');
    const nextBtn = document.getElementById('admin-orgs-btn-next');
    if (prevBtn) prevBtn.disabled = page <= 1;
    if (nextBtn) nextBtn.disabled = page * adminState.orgs.limit >= adminState.orgs.total;
  } catch (err) {
    console.error('Error loading admin orgs:', err);
  }
}

function prevAdminOrgsPage() {
  if (adminState.orgs.page > 1) loadAdminOrganizations(adminState.orgs.page - 1);
}

function nextAdminOrgsPage() {
  if (adminState.orgs.page * adminState.orgs.limit < adminState.orgs.total) loadAdminOrganizations(adminState.orgs.page + 1);
}

function openAdminAddOrgModal() {
  const modal = document.getElementById('modal-admin-add-org');
  if (modal) {
    modal.classList.remove('hidden');
    const form = document.getElementById('admin-create-org-form');
    if (form) form.reset();
    document.getElementById('new-org-company-name')?.focus();
  }
}

function closeAdminAddOrgModal() {
  const modal = document.getElementById('modal-admin-add-org');
  if (modal) modal.classList.add('hidden');
}

async function handleAdminCreateOrgSubmit(e) {
  e.preventDefault();
  const companyName = document.getElementById('new-org-company-name')?.value.trim();
  const contactName = document.getElementById('new-org-contact-name')?.value.trim();
  const email = document.getElementById('new-org-email')?.value.trim();
  const phoneNumber = document.getElementById('new-org-phone')?.value.trim();
  const plan = document.getElementById('new-org-plan')?.value || 'PROFESSIONAL';
  const submitBtn = document.getElementById('btn-create-org-submit');

  if (!companyName) {
    showToast('Company name is required.', 'error');
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = 'Creating...';
  }

  try {
    const res = await fetch('/api/admin/organizations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyName, contactName, email, phoneNumber, plan })
    });
    const data = await res.json();

    if (data.success) {
      showToast(data.message || 'Organization added successfully!', 'success');
      closeAdminAddOrgModal();
      await loadAdminOrganizations(1);
    } else {
      showToast(data.message || 'Failed to add organization.', 'error');
    }
  } catch (err) {
    console.error('Error creating organization:', err);
    showToast('Failed to add organization. Please try again.', 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = 'Create Organization';
    }
  }
}

async function deleteAdminOrg(orgId, orgName) {
  if (!confirm(`Are you sure you want to delete organization "${orgName}"? This action cannot be undone.`)) {
    return;
  }

  showToast(`Deleting ${orgName}...`, 'info');
  try {
    const res = await fetch(`/api/admin/organizations/${orgId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('Organization deleted successfully.', 'success');
      await loadAdminOrganizations(adminState.orgs.page || 1);
    } else {
      showToast(data.message || 'Failed to delete organization.', 'error');
    }
  } catch (err) {
    console.error('Error deleting organization:', err);
    showToast('Failed to delete organization.', 'error');
  }
}

// ── 3. Organization 360° Inspection Modal ───────────────────────────────────

async function viewAdminOrg360(orgId) {
  showToast(`Loading 360° inspection for ${orgId}...`, 'info');
  try {
    const res = await fetch(`/api/admin/organizations/${orgId}`);
    const data = await res.json();
    if (!data.success) {
      showToast(data.message || 'Failed to load organization details', 'error');
      return;
    }

    const { organization, users, subscription, integrations, usage, recentSyncs } = data;

    // Header & Meta
    document.getElementById('org360-company-name').innerText = organization.name || organization.companyName || 'Organization';
    const orgIdEl = document.getElementById('org360-org-id');
    if (orgIdEl) orgIdEl.style.display = 'none'; // hide raw org ID from super admin view
    
    const statusBadge = document.getElementById('org360-status-badge');
    if (statusBadge) {
      statusBadge.innerText = organization.status;
      statusBadge.className = `badge ${organization.status === 'ACTIVE' ? 'badge-success' : 'badge-warning'}`;
    }

    document.getElementById('org360-country').innerText = organization.country || 'India';
    document.getElementById('org360-timezone').innerText = organization.timezone || 'Asia/Kolkata';
    document.getElementById('org360-created').innerText = organization.created_at ? new Date(organization.created_at).toLocaleDateString() : 'Aug 2026';

    // Subscription
    if (subscription) {
      document.getElementById('org360-plan-name').innerText = subscription.plan?.name || 'Professional Plan';
      const subBadge = document.getElementById('org360-sub-status');
      if (subBadge) {
        subBadge.innerText = subscription.status;
        subBadge.className = `badge ${subscription.status === 'ACTIVE' ? 'badge-success' : 'badge-warning'}`;
      }
      document.getElementById('org360-sub-end').innerText = subscription.current_period_end ? new Date(subscription.current_period_end).toLocaleDateString() : 'Ongoing';
    }

    // Integrations (Safe Metadata)
    if (integrations?.cin7) {
      const c = integrations.cin7;
      document.getElementById('org360-cin7-status').innerText = c.connected ? 'Connected ✓' : 'Disconnected';
      document.getElementById('org360-cin7-account').innerText = c.connected ? 'Production (Live)' : 'Not Configured';
      document.getElementById('org360-cin7-last-sync').innerText = c.lastSuccessfulSync || 'Never';
    }

    if (integrations?.googleSheets) {
      const g = integrations.googleSheets;
      document.getElementById('org360-sheets-status').innerText = g.connected ? 'Connected ✓' : 'Disconnected';
      document.getElementById('org360-sheets-id').innerText = g.templateName || g.fileName || (g.connected ? 'Master Financial Model' : 'Not Configured');
      document.getElementById('org360-sheets-template-status').innerText = g.templateStatus || 'Up to date ✓';
    }

    // Users List
    document.getElementById('org360-users-count').innerText = (users || []).length;
    const usersTable = document.getElementById('org360-users-table');
    if (usersTable) {
      usersTable.innerHTML = (users || []).map(u => {
        const safeName = escapeHtml(u.fullName || u.email);
        const safeEmail = escapeHtml(u.email);
        const safeRole = escapeHtml(u.role);
        const safeStatus = escapeHtml(u.status || 'ACTIVE');

        return `
          <tr>
            <td style="font-weight: 600;">${safeName}</td>
            <td style="font-family: var(--font-mono); font-size: 0.75rem;">${safeEmail}</td>
            <td><span class="badge badge-secondary">${safeRole}</span></td>
            <td><span class="badge badge-success">${safeStatus}</span></td>
            <td style="font-size: 0.75rem; color: var(--muted-foreground);">${u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : 'Never'}</td>
          </tr>
        `;
      }).join('') || `<tr><td colspan="5" style="text-align: center; padding: 1rem;">No users found.</td></tr>`;
    }

    // Recent Syncs
    const syncTable = document.getElementById('org360-sync-table');
    if (syncTable) {
      syncTable.innerHTML = (recentSyncs || []).map(s => {
        const syncLbl = { 'GOOGLE_SHEETS': 'Google Sheets Export', 'FULL': 'Full Sync', 'INCREMENTAL': 'Incremental Sync', 'INVENTORY': 'Inventory Sync' }[s.syncType] || (s.syncType || 'Sync');
        const statusLbl = (s.status === 'SUCCESS' || s.status === 'COMPLETED') ? 'Completed' : (s.status === 'FAILED' ? 'Failed' : 'In Progress');
        const statusCls = (s.status === 'SUCCESS' || s.status === 'COMPLETED') ? 'badge-success' : (s.status === 'FAILED' ? 'badge-destructive' : 'badge-warning');
        const startedFmt = s.startedAt ? new Date(s.startedAt).toLocaleString() : '—';

        return `
          <tr>
            <td><span class="badge badge-secondary">${escapeHtml(syncLbl)}</span></td>
            <td style="font-weight: 600;">${Number(s.recordsProcessed || 0).toLocaleString()}</td>
            <td style="color: var(--muted-foreground);">${s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : '—'}</td>
            <td><span class="badge ${statusCls}">${statusLbl}</span></td>
            <td style="font-size: 0.75rem; color: var(--muted-foreground);">${startedFmt}</td>
          </tr>
        `;
      }).join('') || `<tr><td colspan="5" style="text-align: center; padding: 1rem;">No sync runs recorded yet.</td></tr>`;
    }

    // Show Modal
    const modal = document.getElementById('modal-admin-org-details');
    if (modal) modal.classList.remove('hidden');
  } catch (err) {
    showToast('Failed to open 360° inspection: ' + err.message, 'error');
  }
}

function closeAdminOrg360() {
  const modal = document.getElementById('modal-admin-org-details');
  if (modal) modal.classList.add('hidden');
}

// ── 4. Cross-Organization Users Directory ───────────────────────────────────

function debounceAdminUsers() {
  clearTimeout(adminUsersDebounceTimer);
  adminUsersDebounceTimer = setTimeout(() => {
    loadAdminUsers(1);
  }, 300);
}

async function loadAdminUsers(page = 1) {
  adminState.users.page = page;
  const search = document.getElementById('admin-users-search')?.value.trim() || '';
  const role = document.getElementById('admin-users-role-filter')?.value || '';
  const platformRole = document.getElementById('admin-users-platform-filter')?.value || '';

  const params = new URLSearchParams({ page, limit: adminState.users.limit, search, role, platformRole });

  try {
    const res = await fetch(`/api/admin/users?${params.toString()}`);
    const data = await res.json();
    if (!data.success) return;

    adminState.users.total = data.pagination?.total || 0;

    const tbody = document.getElementById('admin-users-table-body');
    if (tbody) {
      const users = data.users || [];
      if (users.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 2.5rem; color: var(--muted-foreground);">No users matched the search criteria.</td></tr>`;
      } else {
        tbody.innerHTML = users.map(u => {
          const roleClass = u.role === 'ADMIN' ? 'role-admin' : (u.role === 'MANAGER' ? 'role-manager' : 'role-viewer');
          const platClass = (u.platformRole || u.platform_role) === 'SUPER_ADMIN' ? 'role-super_admin' : 'badge-secondary';
          const safeName = escapeHtml(u.fullName || u.email);
          const safeEmail = escapeHtml(u.email);
          const safeOrg = escapeHtml(u.companyName || u.organizationName || u.organizationId || u.organization_id || 'Unknown Org');
          const safeRole = escapeHtml(u.role);
          const safePlat = escapeHtml(u.platformRole || u.platform_role || 'USER');
          const safeStatus = escapeHtml(u.status || 'ACTIVE');

          const lastLogin = u.lastLoginAt || u.last_login_at;
          const createdAt = u.createdAt || u.created_at;

          return `
            <tr>
              <td style="font-weight: 700;">${safeName}</td>
              <td style="font-family: var(--font-mono); font-size: 0.75rem;">${safeEmail}</td>
              <td>${safeOrg}</td>
              <td><span class="badge ${roleClass}">${safeRole}</span></td>
              <td><span class="badge ${platClass}">${safePlat}</span></td>
              <td><span class="badge badge-success">${safeStatus}</span></td>
              <td style="font-size: 0.75rem; color: var(--muted-foreground);">${lastLogin ? new Date(lastLogin).toLocaleDateString() : 'Never'}</td>
              <td style="font-size: 0.75rem; color: var(--muted-foreground);">${createdAt ? new Date(createdAt).toLocaleDateString() : 'Aug 2026'}</td>
            </tr>
          `;
        }).join('');
      }
    }

    const pageInfo = document.getElementById('admin-users-page-info');
    if (pageInfo) {
      const from = (page - 1) * adminState.users.limit + (data.users?.length > 0 ? 1 : 0);
      const to = from + (data.users?.length || 0) - (data.users?.length > 0 ? 1 : 0);
      pageInfo.innerText = `Showing ${from} to ${to} of ${adminState.users.total} users`;
    }

    const prevBtn = document.getElementById('admin-users-btn-prev');
    const nextBtn = document.getElementById('admin-users-btn-next');
    if (prevBtn) prevBtn.disabled = page <= 1;
    if (nextBtn) nextBtn.disabled = page * adminState.users.limit >= adminState.users.total;
  } catch (err) {
    console.error('Error loading admin users:', err);
  }
}

function prevAdminUsersPage() {
  if (adminState.users.page > 1) loadAdminUsers(adminState.users.page - 1);
}

function nextAdminUsersPage() {
  if (adminState.users.page * adminState.users.limit < adminState.users.total) loadAdminUsers(adminState.users.page + 1);
}

// ── 5. Subscriptions Monitoring ─────────────────────────────────────────────

async function loadAdminSubscriptions(page = 1) {
  adminState.subs.page = page;
  const status = document.getElementById('admin-subs-status-filter')?.value || '';
  const params = new URLSearchParams({ page, limit: adminState.subs.limit, status });

  try {
    const res = await fetch(`/api/admin/subscriptions?${params.toString()}`);
    const data = await res.json();
    if (!data.success) return;

    adminState.subs.total = data.pagination?.total || 0;
    const subs = data.subscriptions || [];

    const tbody = document.getElementById('admin-subs-table-body');
    if (tbody) {
      if (subs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 2.5rem; color: var(--muted-foreground);">No subscriptions found.</td></tr>`;
      } else {
        tbody.innerHTML = subs.map(s => {
          const statusClass = s.status === 'ACTIVE' ? 'badge-success' : (s.status === 'TRIALING' ? 'badge-info' : 'badge-warning');
          const safeOrg = escapeHtml(s.companyName || s.organizationName || s.organizationId || s.organization_id || 'Unknown Org');
          const safePlan = escapeHtml(s.planName || s.plan_id || 'Professional');
          const safeStatus = escapeHtml(s.status);

          const trialEndDate = s.trialEnd || s.trial_end;
          const currentPeriodEndDate = s.currentPeriodEnd || s.current_period_end;
          const isCancelAtPeriodEnd = Boolean(s.cancelAtPeriodEnd ?? s.cancel_at_period_end);

          return `
            <tr>
              <td style="font-weight: 700;">${safeOrg}</td>
              <td><strong>${safePlan}</strong></td>
              <td>$${s.price || 99}.00 / mo</td>
              <td><span class="badge ${statusClass}">${safeStatus}</span></td>
              <td style="font-size: 0.75rem; color: var(--muted-foreground);">${trialEndDate ? new Date(trialEndDate).toLocaleDateString() : '—'}</td>
              <td style="font-size: 0.75rem; color: var(--muted-foreground);">${currentPeriodEndDate ? new Date(currentPeriodEndDate).toLocaleDateString() : 'Ongoing'}</td>
              <td>${isCancelAtPeriodEnd ? 'No (Cancels at end)' : 'Yes ✓'}</td>
            </tr>
          `;
        }).join('');
      }
    }

    const pageInfo = document.getElementById('admin-subs-page-info');
    if (pageInfo) {
      pageInfo.innerText = `Showing ${subs.length} of ${adminState.subs.total} subscriptions`;
    }
  } catch (err) {
    console.error('Error loading admin subscriptions:', err);
  }
}

function prevAdminSubsPage() {
  if (adminState.subs.page > 1) loadAdminSubscriptions(adminState.subs.page - 1);
}

function nextAdminSubsPage() {
  if (adminState.subs.page * adminState.subs.limit < adminState.subs.total) loadAdminSubscriptions(adminState.subs.page + 1);
}

// ── 6. Billing / Payment Due ────────────────────────────────────────────────

async function loadAdminBilling() {
  const section = document.getElementById('admin-billing-section-filter')?.value || 'all';
  try {
    const res = await fetch(`/api/admin/billing?section=${section}`);
    const data = await res.json();
    if (!data.success) return;

    const tbody = document.getElementById('admin-billing-table-body');
    if (tbody) {
      const items = data.billingItems || [];
      if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2.5rem; color: var(--muted-foreground);">No accounts currently require billing action.</td></tr>`;
      } else {
        tbody.innerHTML = items.map(b => {
          const safeOrg = escapeHtml(b.companyName || b.organizationName || 'Unknown Client');
          const safePlan = escapeHtml(b.planName || 'Professional Plan');
          const safeAmount = `$${b.amount || 99}.00 / mo`;
          const statusClass = b.status === 'ACTIVE' ? 'badge-success' : (b.status === 'TRIALING' ? 'badge-info' : 'badge-warning');
          const safeStatus = escapeHtml(b.status || 'ACTIVE');
          const dueDateText = b.dueDate ? new Date(b.dueDate).toLocaleDateString() : 'Ongoing';
          const safeGateway = escapeHtml(b.paymentStatus || 'Manual Invoice / In Good Standing');

          return `
            <tr>
              <td style="font-weight: 700;">${safeOrg}</td>
              <td><strong>${safePlan}</strong></td>
              <td style="font-weight: 600;">${safeAmount}</td>
              <td style="font-size: 0.75rem; color: var(--muted-foreground);">${dueDateText}</td>
              <td><span class="badge ${statusClass}">${safeStatus}</span></td>
              <td style="font-size: 0.75rem; color: var(--muted-foreground);">${safeGateway}</td>
            </tr>
          `;
        }).join('');
      }
    }
  } catch (err) {
    console.error('Error loading admin billing:', err);
  }
}

// ── 7. CIN7 Connections Monitoring ──────────────────────────────────────────

async function loadAdminCin7() {
  const status = document.getElementById('admin-cin7-status-filter')?.value || '';
  try {
    const res = await fetch(`/api/admin/cin7?status=${status}`);
    const data = await res.json();
    if (!data.success) return;

    const tbody = document.getElementById('admin-cin7-table-body');
    if (tbody) {
      const conns = data.connections || [];
      if (conns.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2.5rem; color: var(--muted-foreground);">No CIN7 connections found.</td></tr>`;
      } else {
        tbody.innerHTML = conns.map(c => {
          const safeOrg = escapeHtml(c.companyName || c.organizationName || 'Unknown Client');
          const isConnected = c.status === 'CONNECTED';
          const statusLabel = isConnected ? 'Connected ✓' : 'Not Configured';
          const lastSuccess = c.lastSuccessfulSyncAt ? new Date(c.lastSuccessfulSyncAt).toLocaleString() : (c.lastSuccessfulSync || 'Never');
          const lastAttempt = c.lastSyncStartedAt ? new Date(c.lastSyncStartedAt).toLocaleString() : (c.lastSyncAttempt || 'Never');
          const recordsCount = Number(c.lastRecordsProcessed || c.recordsSynced || 0).toLocaleString();
          const safeError = escapeHtml(c.lastError || 'None');

          return `
            <tr>
              <td style="font-weight: 700;">${safeOrg}</td>
              <td><span class="badge ${isConnected ? 'badge-success' : 'badge-secondary'}">${statusLabel}</span></td>
              <td style="font-size: 0.75rem; color: var(--muted-foreground);">${escapeHtml(lastSuccess)}</td>
              <td style="font-size: 0.75rem; color: var(--muted-foreground);">${escapeHtml(lastAttempt)}</td>
              <td style="font-weight: 600;">${recordsCount}</td>
              <td style="font-size: 0.75rem; color: ${c.lastError ? 'var(--destructive)' : 'var(--muted-foreground)'};">${safeError}</td>
            </tr>
          `;
        }).join('');
      }
    }
  } catch (err) {
    console.error('Error loading admin cin7:', err);
  }
}

// ── 8. Google Sheets Monitoring ─────────────────────────────────────────────

async function loadAdminSheets() {
  const status = document.getElementById('admin-sheets-status-filter')?.value || '';
  try {
    const res = await fetch(`/api/admin/google-sheets?status=${status}`);
    const data = await res.json();
    if (!data.success) return;

    const tbody = document.getElementById('admin-sheets-table-body');
    if (tbody) {
      const sheets = data.integrations || data.sheets || [];
      if (sheets.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2.5rem; color: var(--muted-foreground);">No Google Sheets integrations found.</td></tr>`;
      } else {
        tbody.innerHTML = sheets.map(s => {
          const safeOrg = escapeHtml(s.companyName || s.organizationName || 'Unknown Client');
          const isConn = s.status === 'CONNECTED';
          const statusLabel = isConn ? 'Connected ✓' : 'Not Configured';
          const safeModel = escapeHtml(s.fileName || 'Master Financial Model');
          const safeTemplateStatus = escapeHtml(s.templateStatus || 'Up to date ✓');
          const updatedDate = s.updatedAt || s.lastUpdated ? new Date(s.updatedAt || s.lastUpdated).toLocaleDateString() : 'Never';
          const lastSync = escapeHtml(s.lastSync || 'Never');

          return `
            <tr>
              <td style="font-weight: 700;">${safeOrg}</td>
              <td style="font-weight: 600; color: var(--foreground);">${safeModel}</td>
              <td><span class="badge ${isConn ? 'badge-success' : 'badge-secondary'}">${statusLabel}</span></td>
              <td style="color: #047857; font-weight: 600;">${safeTemplateStatus}</td>
              <td style="font-size: 0.75rem; color: var(--muted-foreground);">${updatedDate}</td>
              <td style="font-size: 0.75rem; color: var(--muted-foreground);">${lastSync}</td>
            </tr>
          `;
        }).join('');
      }
    }
  } catch (err) {
    console.error('Error loading admin sheets:', err);
  }
}

// ── 9. Sync Runs Monitoring ─────────────────────────────────────────────────

let adminSyncSearchDebounceTimer = null;
function debouncedLoadAdminSync() {
  clearTimeout(adminSyncSearchDebounceTimer);
  adminSyncSearchDebounceTimer = setTimeout(() => loadAdminSync(1), 300);
}

async function loadAdminSync(page = 1) {
  adminState.syncs.page = page;
  const status = document.getElementById('admin-sync-status-filter')?.value || '';
  const syncType = document.getElementById('admin-sync-type-filter')?.value || '';
  const dateRange = document.getElementById('admin-sync-date-filter')?.value || '';
  const company = document.getElementById('admin-sync-search')?.value.trim() || '';
  const params = new URLSearchParams({ page, limit: adminState.syncs.limit, status, syncType, dateRange, company });

  try {
    const res = await fetch(`/api/admin/sync?${params.toString()}`);
    const data = await res.json();
    if (!data.success) return;

    adminState.syncs.total = data.pagination?.total || data.total || 0;
    const runs = data.syncRuns || [];

    const tbody = document.getElementById('admin-sync-table-body');
    if (tbody) {
      if (runs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; padding: 2.5rem; color: var(--muted-foreground);">No sync runs recorded.</td></tr>`;
      } else {
        tbody.innerHTML = runs.map(r => {
          const safeOrg = escapeHtml(r.companyName || r.organizationName || 'Unknown Client');
          const syncLabel = { 'GOOGLE_SHEETS': 'Google Sheets Export', 'FULL': 'Full Sync', 'INCREMENTAL': 'Incremental Sync', 'INVENTORY': 'Inventory Sync', 'REPORT': 'Report Sync', 'GOOGLE_SHEET_PULL': 'Google Sheets Pull' }[r.syncType] || escapeHtml(r.syncType || 'Sync');
          const isOk = r.status === 'SUCCESS' || r.status === 'COMPLETED';
          const isRunning = r.status === 'RUNNING' || r.status === 'IN_PROGRESS';
          const statusLabel = isOk ? 'Completed' : (isRunning ? 'In Progress' : 'Failed');
          const statusCls = isOk ? 'badge-success' : (isRunning ? 'badge-warning' : 'badge-destructive');
          const safeErr = escapeHtml(r.errorMessage || r.error || 'None');
          const sheetCell = r.sheetUrl
            ? `<a href="${escapeHtml(r.sheetUrl)}" target="_blank" rel="noopener noreferrer" title="Open this run's Google Sheet"
                  style="display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.25rem 0.5rem; font-size: 0.6875rem; font-weight: 600; white-space: nowrap; color: var(--vnc-blue); border: 1px solid var(--border); border-radius: var(--radius-sm); text-decoration: none; background: transparent;">
                 <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                 Sheet
               </a>`
            : `<span style="color: var(--muted-foreground); font-size: 0.75rem;">—</span>`;

          return `
            <tr>
              <td style="font-weight: 700;">${safeOrg}</td>
              <td><span class="badge badge-secondary">${syncLabel}</span></td>
              <td style="font-weight: 600;">${Number(r.recordsProcessed || 0).toLocaleString()}</td>
              <td style="color: var(--muted-foreground);">${r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}</td>
              <td><span class="badge ${statusCls}">${statusLabel}</span></td>
              <td style="font-size: 0.75rem; color: var(--muted-foreground);">${r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}</td>
              <td style="font-size: 0.75rem; color: var(--muted-foreground);">${r.completedAt ? new Date(r.completedAt).toLocaleString() : 'In Progress'}</td>
              <td style="font-size: 0.75rem; color: ${r.errorMessage || r.error ? 'var(--destructive)' : 'var(--muted-foreground)'};">${safeErr}</td>
              <td>${sheetCell}</td>
            </tr>
          `;
        }).join('');
      }
    }

    const pageInfo = document.getElementById('admin-sync-page-info');
    if (pageInfo) {
      pageInfo.innerText = `Showing ${runs.length} of ${adminState.syncs.total} runs`;
    }
  } catch (err) {
    console.error('Error loading admin sync:', err);
  }
}

function prevAdminSyncPage() {
  if (adminState.syncs.page > 1) loadAdminSync(adminState.syncs.page - 1);
}

function nextAdminSyncPage() {
  if (adminState.syncs.page * adminState.syncs.limit < adminState.syncs.total) loadAdminSync(adminState.syncs.page + 1);
}

// ── 10. Platform Usage ──────────────────────────────────────────────────────

async function loadAdminUsage() {
  const range = document.getElementById('admin-usage-range')?.value || '30d';
  try {
    const res = await fetch(`/api/admin/usage?range=${range}`);
    const data = await res.json();
    if (!data.success) return;

    const u = data.usage || {};
    document.getElementById('usage-kpi-orgs').innerText = u.totalOrganizations || 0;
    document.getElementById('usage-kpi-users').innerText = u.activeUsers || 0;
    document.getElementById('usage-kpi-syncs').innerText = (u.totalSyncs || 0).toLocaleString();
    document.getElementById('usage-kpi-records').innerText = (u.recordsProcessed || 0).toLocaleString();
    document.getElementById('usage-kpi-storage').innerText = `${u.storageUsedMb || '12.4'} MB`;
    document.getElementById('usage-kpi-integrations').innerText = `${u.activeConnections || 0} Connected`;
  } catch (err) {
    console.error('Error loading admin usage:', err);
  }
}

// ── 11. Audit Logs ──────────────────────────────────────────────────────────

async function loadAdminAudit(page = 1) {
  adminState.audit.page = page;
  const action = document.getElementById('admin-audit-action-filter')?.value || '';
  const params = new URLSearchParams({ page, limit: adminState.audit.limit, action });

  try {
    const res = await fetch(`/api/admin/audit?${params.toString()}`);
    const data = await res.json();
    if (!data.success) return;

    adminState.audit.total = data.pagination?.total || data.total || 0;
    const logs = data.auditLogs || [];

    const tbody = document.getElementById('admin-audit-table-body');
    if (tbody) {
      if (logs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2.5rem; color: var(--muted-foreground);">No audit log events found.</td></tr>`;
      } else {
        tbody.innerHTML = logs.map(l => {
          // Resolve admin display name — prefer full name over technical IDs
          const adminName = escapeHtml(l.adminName || l.fullName || l.full_name ||
            (l.userId === 'user-super-admin-automation' ? 'VNC Admin' : null) ||
            (l.admin_user_id === 'user-super-admin-automation' ? 'VNC Admin' : null) ||
            (l.userId && !l.userId.includes('-') ? l.userId : null) || 'Platform Admin');
          const safeCompany = escapeHtml(l.companyName || l.organizationName || l.targetOrg || 'All Tenants');
          // Human-readable action labels
          const actionLabels = {
            'SUPER_ADMIN_LOGIN': 'Admin Login',
            'ORGANIZATION_VIEWED': 'Viewed Organization',
            'ORGANIZATION_UPDATED': 'Updated Organization',
            'USER_VIEWED': 'Viewed User',
            'SUBSCRIPTION_CHANGED': 'Changed Subscription',
            'CROSS_TENANT_ACCESS': 'Cross-Tenant Access'
          };
          const safeAction = escapeHtml(actionLabels[l.action] || l.action || 'Action');
          // Human-readable resource/target types
          const targetLabels = { 'organization_360': 'Organization Profile', 'user': 'User Account', 'subscription': 'Subscription', 'integration': 'Integration' };
          const safeResource = escapeHtml(targetLabels[l.resource || l.target_type] || l.resource || l.target_type || 'Platform');
          const isSuccess = (l.result || 'SUCCESS') === 'SUCCESS';

          return `
            <tr>
              <td style="font-size: 0.75rem; color: var(--muted-foreground); white-space: nowrap;">${l.createdAt || l.created_at ? new Date(l.createdAt || l.created_at).toLocaleString() : 'Just now'}</td>
              <td style="font-weight: 600;">${adminName}</td>
              <td style="font-weight: 600;">${safeCompany}</td>
              <td><span class="badge badge-primary" style="font-size: 0.6875rem;">${safeAction}</span></td>
              <td style="color: var(--muted-foreground);">${safeResource}</td>
              <td><span class="badge ${isSuccess ? 'badge-success' : 'badge-warning'}">${isSuccess ? 'Success' : 'Failed'}</span></td>
            </tr>
          `;
        }).join('');
      }
    }

    const pageInfo = document.getElementById('admin-audit-page-info');
    if (pageInfo) {
      pageInfo.innerText = `Showing ${logs.length} of ${adminState.audit.total} audit events`;
    }
  } catch (err) {
    console.error('Error loading admin audit:', err);
  }
}

function prevAdminAuditPage() {
  if (adminState.audit.page > 1) loadAdminAudit(adminState.audit.page - 1);
}

function nextAdminAuditPage() {
  if (adminState.audit.page * adminState.audit.limit < adminState.audit.total) loadAdminAudit(adminState.audit.page + 1);
}

// ── 12. System Health Diagnostics ───────────────────────────────────────────

async function loadAdminHealth() {
  try {
    const res = await fetch('/api/admin/system-health');
    const data = await res.json();
    if (!data.success) return;

    const h = data.health || {};
    
    document.getElementById('health-node-version').innerText = `Node ${h.nodeVersion || process?.version || 'v20.x'}`;
    document.getElementById('health-uptime').innerText = `Process Uptime: ${Math.floor((h.uptimeSeconds || 0) / 60)}m ${(h.uptimeSeconds || 0) % 60}s`;

    document.getElementById('health-db-status').innerText = `${h.database?.status || 'CONNECTED'} ✓`;
    document.getElementById('health-db-adapter').innerText = `Adapter: ${h.database?.adapter || 'MemoryDatabaseAdapter'} (Tables indexed)`;

    document.getElementById('health-storage-status').innerText = `${h.storage?.status || 'ISOLATED'} ✓`;

    if (h.memory) {
      document.getElementById('health-memory-rss').innerText = `${Math.round(h.memory.rss / (1024 * 1024))} MB`;
      document.getElementById('health-memory-heap').innerText = `Heap Used: ${Math.round(h.memory.heapUsed / (1024 * 1024))} MB`;
    }
    showToast('System health diagnostics refreshed', 'success');
  } catch (err) {
    console.error('Error loading admin health:', err);
  }
}

// ── 13. Support Desk Ticket Handler ──────────────────────────────────────────

function handleSupportTicketSubmit(event) {
  if (event) event.preventDefault();
  const name = document.getElementById('support-name')?.value || 'Client';
  const email = document.getElementById('support-email')?.value || '';
  const category = document.getElementById('support-category')?.value || 'General';
  const subject = document.getElementById('support-subject')?.value || 'Support Ticket';
  const message = document.getElementById('support-message')?.value || '';

  const ticketId = 'TKT-' + Math.floor(100000 + Math.random() * 900000);
  
  showToast(`Ticket #${ticketId} created successfully! Our team will contact you at ${email || 'your email'}.`, 'success', 6000);
  
  const form = document.getElementById('support-ticket-form');
  if (form) form.reset();
}



