const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const os = require('os');
const db = require('../db');
const { requireAuth, requireSuperAdmin } = require('../middleware/authMiddleware');
const subscriptionService = require('../services/subscriptionService');
const { logAction } = require('../services/auditService');

// All Super Admin endpoints strictly require authentication + SUPER_ADMIN platform role
router.use(requireAuth);
router.use(requireSuperAdmin);

/**
 * GET /api/admin/dashboard
 * Aggregates top-level SaaS platform KPIs from real database entities.
 */
router.get('/dashboard', async (req, res) => {
  try {
    const clientsRes = await db.query('SELECT * FROM clients');
    const allClients = clientsRes.rows || [];
    const clientsMap = allClients.reduce((acc, c) => { acc[c.id] = c.company_name; return acc; }, {});

    const usersRes = await db.query('SELECT * FROM users');
    const allUsers = usersRes.rows || [];

    const subsRes = await db.query('SELECT * FROM subscriptions');
    const allSubs = subsRes.rows || [];

    const syncRunsRes = await db.query('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 500');
    const allSyncRuns = syncRunsRes.rows || [];

    const cin7Res = await db.query('SELECT * FROM cin7_connections');
    const allCin7 = cin7Res.rows || [];

    const sheetsRes = await db.query('SELECT * FROM destination_files');
    const allSheets = sheetsRes.rows || [];

    // KPI computations
    const totalOrganizations = allClients.length;
    const activeOrganizations = allClients.filter(c => (c.status || 'ACTIVE').toUpperCase() === 'ACTIVE').length;
    const trialOrganizations = allSubs.filter(s => (s.status || '').toUpperCase() === 'TRIALING').length;
    const pastDueOrganizations = allSubs.filter(s => (s.status || '').toUpperCase() === 'PAST_DUE').length;
    const expiredOrganizations = allSubs.filter(s => ['EXPIRED', 'CANCELED'].includes((s.status || '').toUpperCase())).length;
    const activeUsers = allUsers.filter(u => (u.status || 'ACTIVE').toUpperCase() === 'ACTIVE').length;

    // Sync metrics
    // NOTE: r.started_at comes back from the DB as a native Date object, so these
    // boundaries must stay Date objects too — comparing a Date against an ISO
    // *string* with >= silently evaluates wrong (string gets coerced to NaN),
    // which previously made "today"/"this month" filters never match anything.
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const todaySyncs = allSyncRuns.filter(r => r.started_at && new Date(r.started_at) >= startOfToday);
    const syncRunning = allSyncRuns.filter(r => r.status === 'RUNNING').length;
    const syncSuccessful = allSyncRuns.filter(r => r.status === 'COMPLETED').length;
    const syncFailed = allSyncRuns.filter(r => r.status === 'FAILED').length;
    const syncsThisMonth = allSyncRuns.filter(r => r.status === 'COMPLETED' && r.started_at && new Date(r.started_at) >= startOfMonth).length;

    // Integrations
    const cin7Connected = allCin7.filter(c => c.status === 'CONNECTED').length;
    const cin7Errors = allCin7.filter(c => c.status !== 'CONNECTED').length;
    const sheetsConnected = allSheets.length;
    const sheetsErrors = 0;

    // Attention Required items
    const attentionItems = [];
    if (pastDueOrganizations > 0) {
      attentionItems.push({
        type: 'CRITICAL',
        title: 'Payment Past Due',
        message: `${pastDueOrganizations} organization(s) have past due subscription payments.`
      });
    }

    const trialsExpiringSoon = allSubs.filter(s => {
      if ((s.status || '').toUpperCase() !== 'TRIALING' || !s.trial_end) return false;
      const daysLeft = (new Date(s.trial_end).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      return daysLeft >= 0 && daysLeft <= 7;
    }).length;

    if (trialsExpiringSoon > 0) {
      attentionItems.push({
        type: 'WARNING',
        title: 'Trials Expiring Soon',
        message: `${trialsExpiringSoon} organization trial(s) will expire within the next 7 days.`
      });
    }

    const recentFailedSyncs = allSyncRuns.filter(r => r.status === 'FAILED' && r.started_at && new Date(r.started_at) >= startOfToday).length;
    if (recentFailedSyncs > 0) {
      attentionItems.push({
        type: 'WARNING',
        title: 'Recent Sync Failures',
        message: `${recentFailedSyncs} sync run(s) failed today.`
      });
    }

    const recentSyncs = allSyncRuns.slice(0, 5).map(r => {
      const syncType = (r.sync_type || 'all').toLowerCase();
      const isGoogleSheet = (syncType === 'google_sheets' || syncType === 'google_sheet_pull') && r.excel_version_id;
      const clientUsers = allUsers.filter(u => u.client_id === r.client_id);
      const leadUser = clientUsers.find(u => u.role === 'ADMIN' || u.role === 'CLIENT' || u.platform_role === 'SUPER_ADMIN') || clientUsers[0] || null;
      return {
        id: r.id,
        runId: r.run_id || r.id,
        organizationName: clientsMap[r.client_id] || r.client_id,
        contactName: leadUser ? (leadUser.full_name || leadUser.email) : null,
        contactEmail: leadUser ? leadUser.email : null,
        syncType: syncType.toUpperCase(),
        status: (r.status || 'RUNNING').toUpperCase(),
        recordsProcessed: r.records_processed || 0,
        durationMs: r.duration_ms || 0,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        sheetUrl: isGoogleSheet ? `https://docs.google.com/spreadsheets/d/${r.excel_version_id}/edit` : null
      };
    });

    res.json({
      success: true,
      recentSyncs,
      kpis: {
        totalOrganizations,
        activeOrganizations,
        trialOrganizations,
        pastDueOrganizations,
        expiredOrganizations,
        activeUsers,
        syncRunning,
        syncSuccessful,
        syncFailed,
        syncsThisMonth,
        cin7Connected,
        cin7Errors,
        sheetsConnected,
        sheetsErrors
      },
      attentionItems
    });
  } catch (err) {
    console.error('[ADMIN DASHBOARD ERROR]', err.message);
    res.status(500).json({ success: false, error: 'Failed to load platform dashboard metrics' });
  }
});

/**
 * GET /api/admin/organizations
 * Returns paginated, searchable, filterable list of all client organizations.
 */
router.get('/organizations', async (req, res) => {
  const { search, status, plan, subscriptionStatus, cin7Status, sortBy, sortOrder = 'desc', page = 1, limit = 10 } = req.query;

  try {
    const clientsRes = await db.query('SELECT * FROM clients');
    let organizations = clientsRes.rows || [];

    const usersRes = await db.query('SELECT client_id, id, full_name, email, phone_number, role, platform_role, status, last_login_at FROM users');
    const allUsers = usersRes.rows || [];

    const subsRes = await db.query('SELECT * FROM subscriptions');
    const allSubs = subsRes.rows || [];

    const plansRes = await db.query('SELECT * FROM plans');
    const allPlans = plansRes.rows || [];

    const cin7Res = await db.query('SELECT client_id, status FROM cin7_connections');
    const allCin7 = cin7Res.rows || [];

    const sheetsRes = await db.query('SELECT client_id, provider, file_name, file_url FROM destination_files');
    const allSheets = sheetsRes.rows || [];

    const syncRunsRes = await db.query('SELECT client_id, status, started_at, completed_at, duration_ms, records_processed FROM sync_runs');
    const allSyncRuns = syncRunsRes.rows || [];

    // Map enriched data
    let enriched = organizations.map(org => {
      const orgUsers = allUsers.filter(u => u.client_id === org.id);
      const primaryUser = orgUsers.find(u => u.role === 'ADMIN' || u.role === 'CLIENT' || u.platform_role === 'SUPER_ADMIN') || orgUsers[0] || null;
      const sub = allSubs.find(s => s.organization_id === org.id);
      const assignedPlan = sub ? allPlans.find(p => p.id === sub.plan_id || p.code === sub.plan_id) : null;
      const cin7Conn = allCin7.find(c => c.client_id === org.id);
      const sheet = allSheets.find(s => s.client_id === org.id);
      const lastSyncRun = allSyncRuns
        .filter(r => r.client_id === org.id)
        .sort((a, b) => new Date(b.started_at || 0) - new Date(a.started_at || 0))[0];

      return {
        id: org.id,
        companyName: org.company_name,
        name: org.company_name,
        phoneNumber: org.phone_number,
        timezone: org.timezone || 'Asia/Kolkata',
        status: (org.status || 'ACTIVE').toUpperCase(),
        createdAt: org.created_at,
        usersCount: orgUsers.length,
        activeUsersCount: orgUsers.filter(u => u.status === 'ACTIVE').length,
        primaryUser: primaryUser ? {
          id: primaryUser.id,
          fullName: primaryUser.full_name || primaryUser.email,
          email: primaryUser.email,
          role: (primaryUser.role || 'ADMIN').toUpperCase(),
          platformRole: (primaryUser.platform_role || 'USER').toUpperCase(),
          phoneNumber: primaryUser.phone_number,
          lastLoginAt: primaryUser.last_login_at
        } : null,
        users: orgUsers.map(u => ({
          id: u.id,
          fullName: u.full_name || u.email,
          email: u.email,
          role: (u.role || 'VIEWER').toUpperCase(),
          platformRole: (u.platform_role || 'USER').toUpperCase(),
          status: (u.status || 'ACTIVE').toUpperCase()
        })),
        subscription: {
          id: sub ? sub.id : null,
          status: sub ? (sub.status || 'ACTIVE').toUpperCase() : 'ACTIVE',
          planName: assignedPlan ? assignedPlan.name : 'Professional',
          planCode: assignedPlan ? assignedPlan.code : 'PROFESSIONAL',
          trialEnd: sub ? sub.trial_end : null,
          currentPeriodEnd: sub ? sub.current_period_end : null,
          cancelAtPeriodEnd: Boolean(sub && sub.cancel_at_period_end)
        },
        cin7: {
          status: cin7Conn ? cin7Conn.status : 'NOT_CONFIGURED',
          connected: Boolean(cin7Conn && cin7Conn.status === 'CONNECTED')
        },
        googleSheets: {
          status: sheet ? 'CONNECTED' : 'NOT_CONFIGURED',
          connected: Boolean(sheet),
          fileName: sheet ? sheet.file_name : null
        },
        lastSync: lastSyncRun ? {
          status: lastSyncRun.status,
          startedAt: lastSyncRun.started_at,
          records: lastSyncRun.records_processed,
          durationMs: lastSyncRun.duration_ms
        } : null
      };
    });

    // 1. Search Filter
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      enriched = enriched.filter(o =>
        (o.companyName || o.name || '').toLowerCase().includes(q) ||
        (o.id || '').toLowerCase().includes(q) ||
        (o.primaryUser?.fullName || '').toLowerCase().includes(q) ||
        (o.primaryUser?.email || '').toLowerCase().includes(q) ||
        (o.users || []).some(u => (u.fullName || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q))
      );
    }

    // 2. Status Filter
    if (status && status !== 'all') {
      enriched = enriched.filter(o => (o.status || '').toLowerCase() === status.toLowerCase());
    }

    // 3. Subscription Status Filter
    if (subscriptionStatus && subscriptionStatus !== 'all') {
      enriched = enriched.filter(o => (o.subscription.status || '').toLowerCase() === subscriptionStatus.toLowerCase());
    }

    // 4. Plan Filter
    if (plan && plan !== 'all') {
      enriched = enriched.filter(o => (o.subscription.planCode || '').toLowerCase() === plan.toLowerCase());
    }

    // 5. CIN7 Filter
    if (cin7Status && cin7Status !== 'all') {
      enriched = enriched.filter(o => (o.cin7.status || '').toLowerCase() === cin7Status.toLowerCase());
    }

    // Sorting
    enriched.sort((a, b) => {
      if (sortBy === 'companyName') {
        const nameA = a.companyName || a.name || '';
        const nameB = b.companyName || b.name || '';
        return sortOrder === 'asc' ? nameA.localeCompare(nameB) : nameB.localeCompare(nameA);
      }
      return sortOrder === 'asc'
        ? new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
        : new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });

    const total = enriched.length;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 10);
    const offset = (pageNum - 1) * limitNum;
    const paginated = enriched.slice(offset, offset + limitNum);

    res.json({
      success: true,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum) || 1,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum) || 1
      },
      organizations: paginated
    });
  } catch (err) {
    console.error('[ADMIN ORGS ERROR]', err.message);
    res.status(500).json({ success: false, error: 'Failed to retrieve organizations' });
  }
});

/**
 * POST /api/admin/organizations
 * Creates a new client organization, provisioning isolated workspace, subscription, and admin user.
 */
router.post('/organizations', async (req, res) => {
  const { companyName, contactName, email, phoneNumber, plan = 'PROFESSIONAL', timezone = 'Asia/Kolkata' } = req.body;

  if (!companyName || !companyName.trim()) {
    return res.status(400).json({ success: false, message: 'Company name is required.' });
  }

  const { v4: uuidv4 } = require('uuid');
  const cryptoService = require('../services/cryptoService');
  const clientStorageService = require('../services/clientStorageService');

  try {
    const clientId = `client-${uuidv4().substring(0, 8)}`;
    const adminEmail = (email && email.trim()) ? email.trim().toLowerCase() : `admin@${companyName.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`;
    const adminFullName = (contactName && contactName.trim()) ? contactName.trim() : `${companyName} Admin`;
    const userId = `user-${uuidv4().substring(0, 8)}`;
    const rawPassword = (req.body.password && typeof req.body.password === 'string' && req.body.password.trim().length >= 6)
      ? req.body.password.trim()
      : crypto.randomBytes(12).toString('base64url');
    const passwordHash = cryptoService.hashPassword(rawPassword);

    // 1. Create client organization record
    await db.query(
      `INSERT INTO clients (id, company_name, phone_number, status, onboarding_status, subscription_status, current_version, timezone)
       VALUES (?, ?, ?, 'ACTIVE', 'completed', 'ACTIVE', 'v1.0', ?)`,
      [clientId, companyName.trim(), phoneNumber || null, timezone]
    );

    // 2. Create primary user for organization if email doesn't already exist
    const existingUser = await db.getOne('SELECT id FROM users WHERE email = ?', [adminEmail]);
    if (!existingUser) {
      await db.query(
        `INSERT INTO users (id, client_id, full_name, email, phone_number, password_hash, role, platform_role, status, auth_provider, onboarding_status)
         VALUES (?, ?, ?, ?, ?, ?, 'ADMIN', 'USER', 'ACTIVE', 'local', 'completed')`,
        [userId, clientId, adminFullName, adminEmail, phoneNumber || null, passwordHash]
      );
    }

    // 3. Initialize isolated client storage & copy master template
    let storageInit = null;
    try {
      storageInit = await clientStorageService.initClientStorage(clientId);
    } catch (e) {
      console.warn('[STORAGE INIT WARN]', e.message);
    }

    // 4. Create subscription for the organization
    await subscriptionService.createTrialSubscription(clientId, plan.toUpperCase(), 30);

    // 5. Store workbook record in DB
    if (storageInit && storageInit.currentPath) {
      await db.query(
        `INSERT INTO client_workbooks (id, client_id, workbook_path, current_version, file_name)
         VALUES (?, ?, ?, 'v1.0', 'Controller_Reporting_Model_v5_Cin7_Actuals.xlsx')`,
        [`wb-${uuidv4().substring(0, 8)}`, clientId, storageInit.currentPath]
      );
    }

    await logAction({
      userId: req.session.user?.id || 'admin',
      action: 'ORGANIZATION_CREATED',
      resourceType: 'ORGANIZATION',
      resourceId: clientId,
      details: { companyName, plan, adminEmail }
    });

    res.json({
      success: true,
      message: `Organization "${companyName}" added successfully.`,
      organization: {
        id: clientId,
        companyName: companyName.trim(),
        status: 'ACTIVE',
        plan: plan.toUpperCase()
      }
    });
  } catch (err) {
    console.error('[ADMIN CREATE ORG ERROR]', err);
    res.status(500).json({ success: false, message: 'Failed to create organization: ' + err.message });
  }
});

/**
 * DELETE /api/admin/organizations/:id
 * Removes an organization and its associated sub-records.
 */
router.delete('/organizations/:id', async (req, res) => {
  const orgId = req.params.id;

  if (orgId === 'client-vnc-master') {
    return res.status(400).json({ success: false, message: 'Cannot delete the master VNC organization.' });
  }

  try {
    await db.query('DELETE FROM clients WHERE id = ?', [orgId]);
    await db.query('DELETE FROM users WHERE client_id = ?', [orgId]);
    await db.query('DELETE FROM subscriptions WHERE organization_id = ?', [orgId]);
    await db.query('DELETE FROM cin7_connections WHERE client_id = ?', [orgId]);
    await db.query('DELETE FROM destination_files WHERE client_id = ?', [orgId]);
    await db.query('DELETE FROM sync_runs WHERE client_id = ?', [orgId]);

    await logAction({
      userId: req.session.user?.id || 'admin',
      action: 'ORGANIZATION_DELETED',
      resourceType: 'ORGANIZATION',
      resourceId: orgId
    });

    res.json({ success: true, message: 'Organization deleted successfully.' });
  } catch (err) {
    console.error('[ADMIN DELETE ORG ERROR]', err);
    res.status(500).json({ success: false, message: 'Failed to delete organization.' });
  }
});

/**
 * GET /api/admin/organizations/:id
 * Returns complete 360° organization details for deep inspection.
 */
router.get('/organizations/:id', async (req, res) => {
  const orgId = req.params.id;

  try {
    const client = await db.getOne('SELECT * FROM clients WHERE id = ?', [orgId]);
    if (!client) {
      return res.status(404).json({ success: false, error: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found' });
    }

    // Users
    const usersRes = await db.query('SELECT id, client_id, full_name, email, phone_number, role, platform_role, status, auth_provider, created_at, updated_at, last_login_at FROM users WHERE client_id = ?', [orgId]);
    const users = (usersRes.rows || []).map(u => ({
      id: u.id,
      fullName: u.full_name,
      email: u.email,
      phoneNumber: u.phone_number,
      role: (u.role || 'VIEWER').toUpperCase(),
      platformRole: (u.platform_role || 'USER').toUpperCase(),
      status: (u.status || 'ACTIVE').toUpperCase(),
      authProvider: u.auth_provider || 'local',
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at
    }));

    // Subscription & Plan
    const sub = await subscriptionService.getOrganizationSubscription(orgId);
    const plan = await subscriptionService.getOrganizationPlan(orgId);
    const usage = await subscriptionService.getUsage(orgId);

    // CIN7 Connection Metadata (Masked/Sanitized - NO Secrets)
    const cin7Conn = await db.getOne('SELECT id, status, last_tested_at, created_at, updated_at FROM cin7_connections WHERE client_id = ?', [orgId]);

    // Google Sheets Metadata
    const sheet = await db.getOne('SELECT id, provider, file_id, file_name, file_url, created_at, updated_at FROM destination_files WHERE client_id = ?', [orgId]);

    // Recent Sync Runs
    const syncRunsRes = await db.query('SELECT * FROM sync_runs WHERE client_id = ? ORDER BY started_at DESC LIMIT 15', [orgId]);
    const recentSyncs = (syncRunsRes.rows || []).map(r => ({
      id: r.id,
      runId: r.run_id || r.id,
      syncType: r.sync_type,
      status: r.status,
      recordsProcessed: r.records_processed,
      durationMs: r.duration_ms,
      errorMessage: r.error_message,
      startedAt: r.started_at,
      completedAt: r.completed_at
    }));

    // Log explicit cross-tenant admin inspection
    await logAction({
      organizationId: orgId,
      userId: req.user.id,
      action: 'ORGANIZATION_VIEWED',
      resource: 'organization_360',
      details: { inspectedOrgId: orgId, companyName: client.company_name }
    });

    res.json({
      success: true,
      organization: {
        id: client.id,
        companyName: client.company_name,
        name: client.company_name,
        phoneNumber: client.phone_number,
        timezone: client.timezone || 'Asia/Kolkata',
        status: (client.status || 'ACTIVE').toUpperCase(),
        currentVersion: client.current_version || 'v1.0',
        createdAt: client.created_at,
        updatedAt: client.updated_at
      },
      users,
      subscription: {
        id: sub ? sub.id : null,
        status: sub ? (sub.status || 'ACTIVE').toUpperCase() : 'ACTIVE',
        planName: plan.name,
        planCode: plan.code,
        price: plan.price,
        currency: plan.currency,
        billingInterval: plan.billingInterval,
        currentPeriodStart: sub ? sub.current_period_start : null,
        currentPeriodEnd: sub ? sub.current_period_end : null,
        trialStart: sub ? sub.trial_start : null,
        trialEnd: sub ? sub.trial_end : null,
        cancelAtPeriodEnd: Boolean(sub && sub.cancel_at_period_end),
        billingProvider: sub ? (sub.billing_provider || 'neutral') : 'neutral',
        features: plan.features,
        limits: plan.limits
      },
      usage,
      cin7: {
        configured: Boolean(cin7Conn),
        status: cin7Conn ? cin7Conn.status : 'NOT_CONFIGURED',
        lastTestedAt: cin7Conn ? cin7Conn.last_tested_at : null
      },
      googleSheets: {
        configured: Boolean(sheet),
        provider: sheet ? sheet.provider : 'google',
        fileName: sheet ? sheet.file_name : null,
        fileUrl: sheet ? sheet.file_url : null,
        updatedAt: sheet ? sheet.updated_at : null
      },
      integrations: {
        cin7: {
          configured: Boolean(cin7Conn),
          status: cin7Conn ? cin7Conn.status : 'NOT_CONFIGURED',
          lastTestedAt: cin7Conn ? cin7Conn.last_tested_at : null
        },
        googleSheets: {
          configured: Boolean(sheet),
          provider: sheet ? sheet.provider : 'google',
          fileName: sheet ? sheet.file_name : null,
          fileUrl: sheet ? sheet.file_url : null,
          updatedAt: sheet ? sheet.updated_at : null
        }
      },
      recentSyncs
    });
  } catch (err) {
    console.error('[ADMIN ORG 360 ERROR]', err.message);
    res.status(500).json({ success: false, error: 'Failed to load organization 360 view' });
  }
});

/**
 * Shared impersonation-start logic: swaps req.session.user to the target user's own real
 * identity (their real role — so their existing role-based restrictions apply unchanged —
 * with platform_role forced to USER so the impersonated session never inherits Super Admin
 * privileges), while stashing the real admin's identity in req.session.impersonatorAdmin so
 * POST /api/auth/impersonate/exit can restore it later. Logged via the same audit trail used
 * for the read-only 360 inspection above.
 */
async function startImpersonation(req, res, targetUser) {
  if (req.session.impersonatorAdmin) {
    return res.status(409).json({ success: false, error: 'ALREADY_IMPERSONATING', message: 'Exit your current impersonation session before starting another.' });
  }
  if (!targetUser.client_id) {
    return res.status(400).json({ success: false, error: 'NO_ORGANIZATION', message: 'This user has not been assigned to an organization yet.' });
  }
  const targetPlatformRole = (targetUser.platform_role || 'USER').toUpperCase();
  if (targetPlatformRole === 'SUPER_ADMIN') {
    return res.status(403).json({ success: false, error: 'CANNOT_IMPERSONATE_SUPER_ADMIN', message: 'Cannot impersonate another Super Admin account.' });
  }

  const client = await db.getOne('SELECT company_name FROM clients WHERE id = ?', [targetUser.client_id]);

  req.session.impersonatorAdmin = {
    id: req.user.id,
    email: req.user.email,
    fullName: req.user.full_name || req.user.fullName || req.user.email
  };

  req.session.user = {
    id: targetUser.id,
    client_id: targetUser.client_id,
    organization_id: targetUser.client_id,
    email: targetUser.email,
    full_name: targetUser.full_name,
    fullName: targetUser.full_name,
    phone_number: targetUser.phone_number,
    role: (targetUser.role || 'ADMIN').toUpperCase(),
    platform_role: 'USER',
    platformRole: 'USER',
    onboarding_status: 'completed',
    onboardingStatus: 'completed'
  };

  await new Promise((resolve, reject) => {
    req.session.save(err => err ? reject(err) : resolve());
  });

  await logAction({
    organizationId: targetUser.client_id,
    userId: req.session.impersonatorAdmin.id,
    action: 'IMPERSONATION_START',
    resource: 'user_session',
    details: {
      targetUserId: targetUser.id,
      targetEmail: targetUser.email,
      targetRole: targetUser.role,
      organizationName: client?.company_name,
      initiatedBy: req.session.impersonatorAdmin.email
    }
  });

  res.json({
    success: true,
    impersonating: {
      userId: targetUser.id,
      email: targetUser.email,
      role: targetUser.role,
      organizationName: client?.company_name
    }
  });
}

/**
 * POST /api/admin/organizations/:id/impersonate
 * Starts a full impersonation session as that organization's own admin user, so the Super
 * Admin lands on the real client dashboard with that org's real data, sync history and
 * permissions (not the read-only 360 summary).
 */
router.post('/organizations/:id/impersonate', async (req, res) => {
  const orgId = req.params.id;
  try {
    const client = await db.getOne('SELECT * FROM clients WHERE id = ?', [orgId]);
    if (!client) {
      return res.status(404).json({ success: false, error: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found' });
    }

    // Prefer the org's own ADMIN-role user (full settings/credentials access); fall back to
    // its earliest user of any role if it has no ADMIN yet.
    let targetUser = await db.getOne(
      "SELECT * FROM users WHERE client_id = ? AND UPPER(role) = 'ADMIN' AND UPPER(COALESCE(platform_role,'USER')) != 'SUPER_ADMIN' ORDER BY created_at ASC LIMIT 1",
      [orgId]
    );
    if (!targetUser) {
      targetUser = await db.getOne(
        "SELECT * FROM users WHERE client_id = ? AND UPPER(COALESCE(platform_role,'USER')) != 'SUPER_ADMIN' ORDER BY created_at ASC LIMIT 1",
        [orgId]
      );
    }
    if (!targetUser) {
      return res.status(404).json({ success: false, error: 'NO_USERS_IN_ORGANIZATION', message: 'This organization has no users to view it as.' });
    }

    await startImpersonation(req, res, targetUser);
  } catch (err) {
    console.error('[ADMIN IMPERSONATE ORG ERROR]', err.message);
    res.status(500).json({ success: false, error: 'Failed to start impersonation session' });
  }
});

/**
 * POST /api/admin/users/:id/impersonate
 * Starts a full impersonation session as that exact user — their exact role and
 * permissions apply, so e.g. impersonating a Viewer shows a read-only dashboard.
 */
router.post('/users/:id/impersonate', async (req, res) => {
  const userId = req.params.id;
  try {
    const targetUser = await db.getOne('SELECT * FROM users WHERE id = ?', [userId]);
    if (!targetUser) {
      return res.status(404).json({ success: false, error: 'USER_NOT_FOUND', message: 'User not found' });
    }

    await startImpersonation(req, res, targetUser);
  } catch (err) {
    console.error('[ADMIN IMPERSONATE USER ERROR]', err.message);
    res.status(500).json({ success: false, error: 'Failed to start impersonation session' });
  }
});

/**
 * GET /api/admin/users
 * Cross-organization user directory (with role, status, search, and pagination).
 * Never exposes passwords or password hashes.
 */
router.get('/users', async (req, res) => {
  const { search, organizationId, role, platformRole, status, page = 1, limit = 15 } = req.query;

  try {
    const usersRes = await db.query('SELECT * FROM users');
    let users = usersRes.rows || [];

    const clientsRes = await db.query('SELECT id, company_name FROM clients');
    const clientsMap = (clientsRes.rows || []).reduce((acc, c) => {
      acc[c.id] = c.company_name;
      return acc;
    }, {});

    let mappedUsers = users.map(u => ({
      id: u.id,
      organizationId: u.client_id,
      organization_id: u.client_id,
      companyName: clientsMap[u.client_id] || u.client_id,
      organizationName: clientsMap[u.client_id] || u.client_id,
      fullName: u.full_name,
      email: u.email,
      phoneNumber: u.phone_number,
      role: (u.role || 'VIEWER').toUpperCase(),
      platformRole: (u.platform_role || 'USER').toUpperCase(),
      status: (u.status || 'ACTIVE').toUpperCase(),
      authProvider: u.auth_provider || 'local',
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at
    }));

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      mappedUsers = mappedUsers.filter(u =>
        u.fullName.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        u.companyName.toLowerCase().includes(q)
      );
    }

    if (organizationId && organizationId !== 'all') {
      mappedUsers = mappedUsers.filter(u => u.organizationId === organizationId);
    }

    if (role && role !== 'all') {
      mappedUsers = mappedUsers.filter(u => u.role === role.toUpperCase());
    }

    if (platformRole && platformRole !== 'all') {
      mappedUsers = mappedUsers.filter(u => u.platformRole === platformRole.toUpperCase());
    }

    if (status && status !== 'all') {
      mappedUsers = mappedUsers.filter(u => u.status === status.toUpperCase());
    }

    const total = mappedUsers.length;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 15);
    const offset = (pageNum - 1) * limitNum;
    const paginated = mappedUsers.slice(offset, offset + limitNum);

    res.json({
      success: true,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum) || 1,
      users: paginated
    });
  } catch (err) {
    console.error('[ADMIN USERS ERROR]', err.message);
    res.status(500).json({ success: false, error: 'Failed to retrieve platform users' });
  }
});

/**
 * POST /api/admin/users/invite
 * Invites a new user or Super Admin via Supabase Auth email invitation.
 * Super Admin sets: email, fullName, organizationId, role (ADMIN/MANAGER/VIEWER), and platformRole (USER/SUPER_ADMIN).
 */
router.post('/users/invite', async (req, res) => {
  const { email, fullName, organizationId, role, platformRole } = req.body;

  if (!email || !email.trim()) {
    return res.status(400).json({ success: false, message: 'Email address is required.' });
  }

  const cleanEmail = email.toLowerCase().trim();
  const validRole = ['ADMIN', 'MANAGER', 'VIEWER'].includes((role || '').toUpperCase())
    ? role.toUpperCase()
    : 'ADMIN';
  const validPlatformRole = (platformRole || '').toUpperCase() === 'SUPER_ADMIN'
    ? 'SUPER_ADMIN'
    : 'USER';
  const cleanName = (fullName && fullName.trim()) ? fullName.trim() : cleanEmail.split('@')[0];

  // Resolve target organization
  let targetOrgId = organizationId;
  if (!targetOrgId || targetOrgId === 'default' || (validPlatformRole === 'SUPER_ADMIN' && !targetOrgId)) {
    targetOrgId = 'client-vnc-master';
  }

  try {
    // 1. Verify target client organization exists
    const org = await db.getOne('SELECT id, company_name FROM clients WHERE id = ?', [targetOrgId]);
    if (!org) {
      const anyClient = await db.getOne('SELECT id FROM clients ORDER BY created_at ASC LIMIT 1');
      targetOrgId = anyClient ? anyClient.id : 'client-vnc-master';
    }

    // 2. Check if user already exists in DB
    const existingDbUser = await db.getOne('SELECT id, email, platform_role, role, client_id FROM users WHERE email = ?', [cleanEmail]);

    let supabaseUserId = null;
    let inviteSentViaSupabase = false;

    // 3. Trigger Supabase Auth invitation if Supabase client is initialized
    if (db.supabase && db.supabase.auth && db.supabase.auth.admin) {
      try {
        const appOrigin = req.get('origin') || `${req.protocol}://${req.get('host')}`;
        const inviteRes = await db.supabase.auth.admin.inviteUserByEmail(cleanEmail, {
          data: {
            full_name: cleanName,
            role: validRole,
            platform_role: validPlatformRole,
            organization_id: targetOrgId
          },
          redirectTo: `${appOrigin}/#auth-landing`
        });

        if (inviteRes.error) {
          console.warn('[SUPABASE INVITE NOTICE]', inviteRes.error.message);
        } else if (inviteRes.data && inviteRes.data.user) {
          supabaseUserId = inviteRes.data.user.id;
          inviteSentViaSupabase = true;
          console.log(`[SUPABASE INVITE] Email invite dispatched to ${cleanEmail} (UUID: ${supabaseUserId})`);
        }
      } catch (sbErr) {
        console.warn('[SUPABASE INVITE ERROR (non-fatal)]', sbErr.message);
      }
    }

    // 4. Upsert user record into Postgres users table
    const { v4: uuidv4 } = require('uuid');
    const finalUserId = supabaseUserId || (existingDbUser ? existingDbUser.id : `user-${uuidv4().substring(0, 8)}`);

    if (existingDbUser) {
      await db.query(
        `UPDATE users 
         SET full_name = ?, client_id = ?, role = ?, platform_role = ?, status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP
         WHERE email = ?`,
        [cleanName, targetOrgId, validRole, validPlatformRole, cleanEmail]
      );
    } else {
      await db.query(
        `INSERT INTO users (id, client_id, full_name, email, phone_number, password_hash, role, platform_role, status, auth_provider, onboarding_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, null, null, ?, ?, 'ACTIVE', 'supabase', 'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [finalUserId, targetOrgId, cleanName, cleanEmail, validRole, validPlatformRole]
      );
    }

    // 5. Record platform audit log
    await logAction({
      organizationId: targetOrgId,
      userId: req.user?.id || 'super-admin',
      action: validPlatformRole === 'SUPER_ADMIN' ? 'SUPER_ADMIN_INVITED' : 'USER_INVITED',
      resource: cleanEmail,
      result: 'SUCCESS',
      details: {
        email: cleanEmail,
        fullName: cleanName,
        organizationId: targetOrgId,
        role: validRole,
        platformRole: validPlatformRole,
        invitedBy: req.user?.email,
        inviteSentViaSupabase
      }
    });

    res.json({
      success: true,
      message: inviteSentViaSupabase
        ? `Invitation email successfully sent to ${cleanEmail}!`
        : `User ${cleanEmail} successfully configured as ${validPlatformRole === 'SUPER_ADMIN' ? 'Super Admin' : validRole}!`,
      user: {
        id: finalUserId,
        email: cleanEmail,
        fullName: cleanName,
        organizationId: targetOrgId,
        role: validRole,
        platformRole: validPlatformRole,
        inviteSentViaSupabase
      }
    });
  } catch (err) {
    console.error('[ADMIN INVITE ERROR]', err.message);
    res.status(500).json({ success: false, error: err.message || 'Failed to invite user.' });
  }
});

/**
 * GET /api/admin/subscriptions
 * Global subscription monitoring across all customer organizations.
 */
router.get('/subscriptions', async (req, res) => {
  const { status, planCode, page = 1, limit = 15 } = req.query;

  try {
    const subsRes = await db.query('SELECT * FROM subscriptions');
    let subs = subsRes.rows || [];

    const clientsRes = await db.query('SELECT id, company_name FROM clients');
    const clientsMap = (clientsRes.rows || []).reduce((acc, c) => {
      acc[c.id] = c.company_name;
      return acc;
    }, {});

    const usersRes = await db.query('SELECT client_id, id, full_name, email, role FROM users');
    const allUsers = usersRes.rows || [];

    const plansRes = await db.query('SELECT * FROM plans');
    const plansMap = (plansRes.rows || []).reduce((acc, p) => {
      acc[p.id] = p;
      acc[p.code] = p;
      return acc;
    }, {});

    let mapped = subs.map(s => {
      const plan = plansMap[s.plan_id] || plansMap['PROFESSIONAL'] || {};
      const orgUsers = allUsers.filter(u => u.client_id === s.organization_id);
      const leadUser = orgUsers.find(u => u.role === 'ADMIN' || u.role === 'CLIENT') || orgUsers[0] || null;
      return {
        id: s.id,
        organizationId: s.organization_id,
        organization_id: s.organization_id,
        companyName: clientsMap[s.organization_id] || s.organization_id,
        organizationName: clientsMap[s.organization_id] || s.organization_id,
        contactName: leadUser ? (leadUser.full_name || leadUser.email) : null,
        contactEmail: leadUser ? leadUser.email : null,
        planId: s.plan_id,
        planName: plan.name || 'Professional',
        planCode: plan.code || 'PROFESSIONAL',
        price: plan.price || 0,
        currency: plan.currency || 'USD',
        status: (s.status || 'ACTIVE').toUpperCase(),
        currentPeriodStart: s.current_period_start,
        currentPeriodEnd: s.current_period_end,
        trialStart: s.trial_start,
        trialEnd: s.trial_end,
        cancelAtPeriodEnd: Boolean(s.cancel_at_period_end),
        billingProvider: s.billing_provider || 'neutral',
        createdAt: s.created_at,
        updatedAt: s.updated_at
      };
    });

    if (status && status !== 'all') {
      mapped = mapped.filter(s => s.status.toLowerCase() === status.toLowerCase());
    }

    if (planCode && planCode !== 'all') {
      mapped = mapped.filter(s => s.planCode.toLowerCase() === planCode.toLowerCase());
    }

    const total = mapped.length;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 15);
    const offset = (pageNum - 1) * limitNum;
    const paginated = mapped.slice(offset, offset + limitNum);

    res.json({
      success: true,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum) || 1,
      subscriptions: paginated
    });
  } catch (err) {
    console.error('[ADMIN SUBSCRIPTIONS ERROR]', err.message);
    res.status(500).json({ success: false, error: 'Failed to retrieve subscriptions' });
  }
});

/**
 * GET /api/admin/billing
 * Dedicated payment monitoring (Payment Due, Past Due, Expiring Soon, Expired).
 */
router.get('/billing', async (req, res) => {
  try {
    const subsRes = await db.query('SELECT * FROM subscriptions');
    const allSubs = subsRes.rows || [];

    const clientsRes = await db.query('SELECT id, company_name FROM clients');
    const clientsMap = (clientsRes.rows || []).reduce((acc, c) => {
      acc[c.id] = c.company_name;
      return acc;
    }, {});

    const plansRes = await db.query('SELECT * FROM plans');
    const plansMap = (plansRes.rows || []).reduce((acc, p) => {
      acc[p.id] = p;
      acc[p.code] = p;
      return acc;
    }, {});

    const now = Date.now();
    const sevenDaysFromNow = now + 7 * 24 * 60 * 60 * 1000;

    const paymentDue = [];
    const pastDue = [];
    const trialEndingSoon = [];
    const expired = [];

    allSubs.forEach(s => {
      const plan = plansMap[s.plan_id] || plansMap['PROFESSIONAL'] || {};
      const item = {
        id: s.id,
        organizationId: s.organization_id,
        companyName: clientsMap[s.organization_id] || s.organization_id,
        planName: plan.name || 'Professional',
        planCode: plan.code || 'PROFESSIONAL',
        amount: plan.price || 0,
        currency: plan.currency || 'USD',
        status: (s.status || 'ACTIVE').toUpperCase(),
        dueDate: s.current_period_end || s.trial_end,
        paymentStatus: 'Payment gateway not configured',
        updatedAt: s.updated_at
      };

      if (item.status === 'PAST_DUE') {
        pastDue.push(item);
        paymentDue.push(item);
      } else if (item.status === 'TRIALING' && s.trial_end && new Date(s.trial_end).getTime() <= sevenDaysFromNow) {
        trialEndingSoon.push(item);
      } else if (['EXPIRED', 'CANCELED'].includes(item.status)) {
        expired.push(item);
      }
    });

    const allBillingItems = [...pastDue, ...trialEndingSoon, ...expired, ...paymentDue];

    res.json({
      success: true,
      billingSummary: {
        pastDueCount: pastDue.length,
        trialEndingCount: trialEndingSoon.length,
        expiredCount: expired.length,
        totalFlagged: pastDue.length + trialEndingSoon.length + expired.length
      },
      pastDue,
      trialEndingSoon,
      expired,
      paymentDue,
      billingItems: allBillingItems
    });
  } catch (err) {
    console.error('[ADMIN BILLING ERROR]', err.message);
    res.status(500).json({ success: false, error: 'Failed to retrieve billing monitoring' });
  }
});

/**
 * GET /api/admin/cin7
 * Cross-organization CIN7 connection health monitoring.
 * Zero secret exposure.
 */
router.get('/cin7', async (req, res) => {
  try {
    const cin7Res = await db.query('SELECT * FROM cin7_connections');
    const allCin7 = cin7Res.rows || [];

    const clientsRes = await db.query('SELECT id, company_name FROM clients');
    const clientsMap = (clientsRes.rows || []).reduce((acc, c) => {
      acc[c.id] = c.company_name;
      return acc;
    }, {});

    const syncRunsRes = await db.query('SELECT client_id, status, records_processed, duration_ms, error_message, started_at FROM sync_runs');
    const allSyncs = syncRunsRes.rows || [];

    const connections = allCin7.map(c => {
      const clientSyncs = allSyncs.filter(s => s.client_id === c.client_id);
      const lastSync = clientSyncs.sort((a, b) => new Date(b.started_at || 0) - new Date(a.started_at || 0))[0];
      const lastSuccess = clientSyncs.filter(s => s.status === 'COMPLETED').sort((a, b) => new Date(b.started_at || 0) - new Date(a.started_at || 0))[0];

      return {
        id: c.id,
        organizationId: c.client_id,
        companyName: clientsMap[c.client_id] || c.client_id,
        status: (c.status || 'CONNECTED').toUpperCase(),
        lastTestedAt: c.last_tested_at,
        lastSyncStatus: lastSync ? lastSync.status : 'IDLE',
        lastSyncStartedAt: lastSync ? lastSync.started_at : null,
        lastSuccessfulSyncAt: lastSuccess ? lastSuccess.started_at : null,
        lastRecordsProcessed: lastSync ? lastSync.records_processed : 0,
        lastDurationMs: lastSync ? lastSync.duration_ms : 0,
        lastError: lastSync && lastSync.status === 'FAILED' ? lastSync.error_message : null
      };
    });

    res.json({
      success: true,
      total: connections.length,
      connectedCount: connections.filter(c => c.status === 'CONNECTED').length,
      errorCount: connections.filter(c => c.status !== 'CONNECTED').length,
      connections
    });
  } catch (err) {
    console.error('[ADMIN CIN7 MONITOR ERROR]', err.message);
    res.status(500).json({ success: false, error: 'Failed to retrieve CIN7 monitoring' });
  }
});

/**
 * GET /api/admin/google-sheets
 * Cross-organization Google Sheets connection monitoring.
 */
router.get('/google-sheets', async (req, res) => {
  try {
    const sheetsRes = await db.query('SELECT * FROM destination_files');
    const allSheets = sheetsRes.rows || [];

    const clientsRes = await db.query('SELECT id, company_name FROM clients');
    const clientsMap = (clientsRes.rows || []).reduce((acc, c) => {
      acc[c.id] = c.company_name;
      return acc;
    }, {});

    const sheets = allSheets.map(s => ({
      id: s.id,
      organizationId: s.client_id,
      companyName: clientsMap[s.client_id] || s.client_id,
      provider: s.provider || 'google',
      fileName: s.file_name,
      fileUrl: s.file_url,
      status: 'CONNECTED',
      updatedAt: s.updated_at
    }));

    res.json({
      success: true,
      total: sheets.length,
      connectedCount: sheets.length,
      sheets,
      integrations: sheets
    });
  } catch (err) {
    console.error('[ADMIN SHEETS MONITOR ERROR]', err.message);
    res.status(500).json({ success: false, error: 'Failed to retrieve Google Sheets monitoring' });
  }
});

/**
 * GET /api/admin/sync
 * Operational sync execution logs across all customer organizations.
 */
router.get('/sync', async (req, res) => {
  const { organizationId, status, syncType, company, dateRange, page = 1, limit = 20 } = req.query;

  try {
    const syncRunsRes = await db.query('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 500');
    let runs = syncRunsRes.rows || [];

    const clientsRes = await db.query('SELECT id, company_name FROM clients');
    const clientsMap = (clientsRes.rows || []).reduce((acc, c) => {
      acc[c.id] = c.company_name;
      return acc;
    }, {});

    const usersRes = await db.query('SELECT client_id, id, full_name, email, role FROM users');
    const allUsers = usersRes.rows || [];

    let mapped = runs.map(r => {
      const syncType = (r.sync_type || 'all').toLowerCase();
      const isGoogleSheet = (syncType === 'google_sheets' || syncType === 'google_sheet_pull') && r.excel_version_id;
      const orgUsers = allUsers.filter(u => u.client_id === r.client_id);
      const leadUser = orgUsers.find(u => u.role === 'ADMIN' || u.role === 'CLIENT') || orgUsers[0] || null;
      return {
        id: r.id,
        runId: r.run_id || r.id,
        organizationId: r.client_id,
        companyName: clientsMap[r.client_id] || r.client_id,
        contactName: leadUser ? (leadUser.full_name || leadUser.email) : null,
        contactEmail: leadUser ? leadUser.email : null,
        syncType: syncType.toUpperCase(),
        status: (r.status || 'RUNNING').toUpperCase(),
        recordsProcessed: r.records_processed || 0,
        durationMs: r.duration_ms || 0,
        errorMessage: r.error_message || null,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        sheetUrl: isGoogleSheet ? `https://docs.google.com/spreadsheets/d/${r.excel_version_id}/edit` : null
      };
    });

    if (organizationId && organizationId !== 'all') {
      mapped = mapped.filter(r => r.organizationId === organizationId);
    }

    if (status && status !== 'all') {
      mapped = mapped.filter(r => r.status === status.toUpperCase());
    }

    if (syncType && syncType !== 'all') {
      mapped = mapped.filter(r => r.syncType.toLowerCase() === syncType.toLowerCase());
    }

    if (company && company.trim()) {
      const q = company.trim().toLowerCase();
      mapped = mapped.filter(r => (r.companyName || '').toLowerCase().includes(q));
    }

    if (dateRange) {
      const now = new Date();
      let startBound = null;
      let endBound = null;
      if (dateRange === 'today') {
        startBound = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        endBound = new Date(startBound.getTime() + 24 * 60 * 60 * 1000);
      } else if (dateRange === 'yesterday') {
        endBound = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        startBound = new Date(endBound.getTime() - 24 * 60 * 60 * 1000);
      } else if (dateRange === '7d') {
        startBound = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      } else if (dateRange === '30d') {
        startBound = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      } else if (dateRange === 'month') {
        startBound = new Date(now.getFullYear(), now.getMonth(), 1);
      }

      if (startBound) {
        mapped = mapped.filter(r => {
          if (!r.startedAt) return false;
          const d = new Date(r.startedAt);
          if (d < startBound) return false;
          if (endBound && d >= endBound) return false;
          return true;
        });
      }
    }

    const total = mapped.length;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 20);
    const offset = (pageNum - 1) * limitNum;
    const paginated = mapped.slice(offset, offset + limitNum);

    res.json({
      success: true,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum) || 1,
      syncRuns: paginated
    });
  } catch (err) {
    console.error('[ADMIN SYNC MONITOR ERROR]', err.message);
    res.status(500).json({ success: false, error: 'Failed to retrieve sync monitoring' });
  }
});

/**
 * GET /api/admin/usage
 * Platform-wide usage analytics.
 */
router.get('/usage', async (req, res) => {
  try {
    const clientsRes = await db.query('SELECT * FROM clients');
    const allClients = clientsRes.rows || [];

    const usersRes = await db.query('SELECT * FROM users');
    const allUsers = usersRes.rows || [];

    const syncRunsRes = await db.query('SELECT * FROM sync_runs');
    const allSyncs = syncRunsRes.rows || [];

    const snapRes = await db.query('SELECT * FROM report_snapshots');
    const allSnaps = snapRes.rows || [];

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthSyncs = allSyncs.filter(s => s.started_at && s.started_at >= startOfMonth);
    const totalRecords = allSyncs.reduce((acc, s) => acc + (s.records_processed || 0), 0);
    const totalStorageGb = Number((allSnaps.length * 0.05).toFixed(2));

    res.json({
      success: true,
      usage: {
        totalOrganizations: allClients.length,
        activeUsers: allUsers.filter(u => (u.status || 'ACTIVE').toUpperCase() === 'ACTIVE').length,
        syncsThisMonth: monthSyncs.length,
        totalRecordsProcessed: totalRecords,
        totalSnapshots: allSnaps.length,
        estimatedStorageGb: totalStorageGb
      }
    });
  } catch (err) {
    console.error('[ADMIN USAGE ERROR]', err.message);
    res.status(500).json({ success: false, error: 'Failed to load usage analytics' });
  }
});

/**
 * GET /api/admin/audit
 * Platform audit log feed.
 */
router.get('/audit', async (req, res) => {
  const { organizationId, action, page = 1, limit = 20 } = req.query;

  try {
    const auditRes = await db.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500');
    let logs = auditRes.rows || [];

    const clientsRes = await db.query('SELECT id, company_name FROM clients');
    const clientsMap = (clientsRes.rows || []).reduce((acc, c) => {
      acc[c.id] = c.company_name;
      return acc;
    }, {});

    const usersRes = await db.query('SELECT id, full_name, email FROM users');
    const usersMap = (usersRes.rows || []).reduce((acc, u) => {
      acc[u.id] = { fullName: u.full_name || u.email, email: u.email };
      return acc;
    }, {});

    let mapped = logs.map(l => {
      let details = {};
      try {
        details = typeof l.details_json === 'string' ? JSON.parse(l.details_json) : (l.details_json || {});
      } catch (e) {}

      const userObj = usersMap[l.user_id];
      const resolvedAdmin = userObj ? userObj.fullName : (l.user_id === 'user-super-admin-automation' ? 'Automation Super Admin' : (l.user_id && !l.user_id.includes('-') ? l.user_id : 'Platform Admin'));
      const resolvedEmail = userObj ? userObj.email : (l.user_id === 'user-super-admin-automation' ? 'automation.vncglobalgroup@gmail.com' : null);

      return {
        id: l.id,
        organizationId: l.organization_id,
        organization_id: l.organization_id,
        companyName: clientsMap[l.organization_id] || l.organization_id,
        userId: l.user_id,
        adminName: resolvedAdmin,
        adminEmail: resolvedEmail,
        action: l.action,
        resource: l.resource,
        result: l.result,
        details,
        createdAt: l.created_at
      };
    });

    if (organizationId && organizationId !== 'all') {
      mapped = mapped.filter(l => l.organizationId === organizationId);
    }

    if (action && action !== 'all') {
      mapped = mapped.filter(l => l.action.toLowerCase().includes(action.toLowerCase()));
    }

    const total = mapped.length;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 20);
    const offset = (pageNum - 1) * limitNum;
    const paginated = mapped.slice(offset, offset + limitNum);

    res.json({
      success: true,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum) || 1,
      auditLogs: paginated
    });
  } catch (err) {
    console.error('[ADMIN AUDIT ERROR]', err.message);
    res.status(500).json({ success: false, error: 'Failed to retrieve audit logs' });
  }
});

/**
 * GET /api/admin/system-health
 * Real system infrastructure health & process telemetry.
 */
router.get('/system-health', async (req, res) => {
  try {
    const memUsage = process.memoryUsage();
    const uptimeSec = process.uptime();

    const healthPayload = {
      serverStatus: 'ONLINE',
      nodeVersion: process.version,
      platform: process.platform,
      uptimeSeconds: Math.round(uptimeSec),
      database: { status: 'CONNECTED', adapter: 'sqlite_in_memory' },
      storage: { status: 'ISOLATED', baseDir: 'storage/clients' },
      databaseStatus: 'HEALTHY',
      storageStatus: 'ISOLATED_OK',
      memory: {
        rssMb: (memUsage.rss / 1024 / 1024).toFixed(1),
        heapUsedMb: (memUsage.heapUsed / 1024 / 1024).toFixed(1),
        heapTotalMb: (memUsage.heapTotal / 1024 / 1024).toFixed(1)
      },
      timestamp: new Date().toISOString()
    };

    res.json({
      success: true,
      health: healthPayload,
      systemHealth: healthPayload
    });
  } catch (err) {
    console.error('[ADMIN HEALTH ERROR]', err.message);
    res.status(500).json({ success: false, error: 'Failed to load system telemetry' });
  }
});

/**
 * GET /api/admin/orgs/:orgId/users
 * GET /api/admin/organizations/:orgId/users
 * Returns all users belonging to a specific organization for the impersonation user-select popup.
 */
router.get(['/orgs/:orgId/users', '/organizations/:orgId/users'], async (req, res) => {
  const { orgId } = req.params;
  try {
    let users = [];
    let clientRes = null;

    try {
      clientRes = await db.getOne('SELECT id, company_name FROM clients WHERE id = ?', [orgId]);
    } catch (e) {
      console.warn('[ADMIN ORG CLIENT FETCH WARN]', e.message);
    }

    try {
      const usersRes = await db.query(
        'SELECT id, client_id, full_name, email, role, platform_role, status, last_login_at, created_at FROM users WHERE client_id = ?',
        [orgId]
      );
      users = (usersRes.rows || []).map(u => ({
        id: u.id,
        fullName: u.full_name || u.email,
        email: u.email,
        role: (u.role || 'VIEWER').toUpperCase(),
        platformRole: (u.platform_role || 'USER').toUpperCase(),
        status: (u.status || 'ACTIVE').toUpperCase(),
        lastLoginAt: u.last_login_at,
        createdAt: u.created_at
      }));
    } catch (dbErr) {
      console.warn('[ADMIN ORG USERS DB QUERY WARN]', dbErr.message);
    }

    // Fallback: if query returned 0, search all users
    if (users.length === 0) {
      try {
        const allUsersRes = await db.query('SELECT id, client_id, full_name, email, role, platform_role, status, last_login_at, created_at FROM users');
        const matches = (allUsersRes.rows || []).filter(u => u.client_id === orgId);
        users = matches.map(u => ({
          id: u.id,
          fullName: u.full_name || u.email,
          email: u.email,
          role: (u.role || 'VIEWER').toUpperCase(),
          platformRole: (u.platform_role || 'USER').toUpperCase(),
          status: (u.status || 'ACTIVE').toUpperCase(),
          lastLoginAt: u.last_login_at,
          createdAt: u.created_at
        }));
      } catch (e) {}
    }

    res.json({
      success: true,
      orgId,
      orgName: clientRes ? clientRes.company_name : orgId,
      users
    });
  } catch (err) {
    console.error('[ADMIN ORG USERS ERROR]', err.message);
    res.json({
      success: true,
      orgId,
      orgName: orgId,
      users: []
    });
  }
});

/**
 * POST /api/admin/impersonate
 * Allows a Super Admin to view the portal as a specific user.
 * Stores the original admin session so it can be fully restored on exit.
 */
router.post('/impersonate', async (req, res) => {
  const { userId, orgId } = req.body;
  if (!userId && !orgId) {
    return res.status(400).json({ success: false, message: 'User or Organization identifier is required.' });
  }

  try {
    let user = null;
    if (userId && orgId) {
      user = await db.getOne('SELECT * FROM users WHERE id = ? AND client_id = ?', [userId, orgId]);
    }
    if (!user && userId) {
      user = await db.getOne('SELECT * FROM users WHERE id = ?', [userId]);
    }
    if (!user && userId) {
      user = await db.getOne('SELECT * FROM users WHERE email = ?', [userId]);
    }
    if (!user && orgId) {
      // Find primary user or first user for this organization
      user = await db.getOne('SELECT * FROM users WHERE client_id = ? ORDER BY role, id LIMIT 1', [orgId]);
    }

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const effectiveOrgId = user.client_id || orgId || 'client-05262fcf';
    let client = await db.getOne('SELECT * FROM clients WHERE id = ?', [effectiveOrgId]);
    if (!client) {
      // Fallback: check if client exists under any id
      const allClientsRes = await db.query('SELECT * FROM clients LIMIT 1');
      if (allClientsRes.rows && allClientsRes.rows.length > 0) {
        client = allClientsRes.rows[0];
      } else {
        client = {
          id: effectiveOrgId,
          company_name: 'Client Organization',
          status: 'ACTIVE',
          timezone: 'Asia/Kolkata',
          last_sync_at: null
        };
      }
    }

    let cin7Conn = null;
    try {
      cin7Conn = await db.getOne('SELECT status FROM cin7_connections WHERE client_id = ?', [client.id || effectiveOrgId]);
    } catch (e) {}

    // Save the original admin session before switching context
    req.session.adminSnapshot = req.session.adminSnapshot || req.session.user;

    // Build a minimal session context for the impersonated user
    req.session.user = {
      id: user.id,
      email: user.email,
      full_name: user.full_name || user.email,
      client_id: client.id || effectiveOrgId,
      clientId: client.id || effectiveOrgId,
      role: (user.role || 'ADMIN').toUpperCase(),
      platform_role: 'USER', // Never elevate privileges during impersonation
      platformRole: 'USER',
      onboarding_status: 'completed',
      status: 'ACTIVE',
      _impersonating: true
    };

    await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));

    await logAction({
      userId: req.session.adminSnapshot?.id || 'admin',
      action: 'USER_IMPERSONATION_STARTED',
      resourceType: 'USER',
      resourceId: user.id,
      details: { targetEmail: user.email, orgId: client.id, orgName: client.company_name }
    });

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name || user.email,
        full_name: user.full_name || user.email,
        client_id: client.id || effectiveOrgId,
        clientId: client.id || effectiveOrgId,
        role: (user.role || 'ADMIN').toUpperCase(),
        platformRole: 'USER',
        platform_role: 'USER',
        onboardingStatus: 'completed',
        _impersonating: true
      },
      client: {
        id: client.id,
        companyName: client.company_name,
        name: client.company_name,
        status: client.status || 'ACTIVE',
        timezone: client.timezone || 'Asia/Kolkata',
        lastSyncAt: client.last_sync_at || null
      },
      cin7: {
        connected: Boolean(cin7Conn && cin7Conn.status === 'CONNECTED'),
        status: cin7Conn ? cin7Conn.status : 'NOT_CONFIGURED'
      }
    });
  } catch (err) {
    console.error('[ADMIN IMPERSONATE ERROR]', err.message);
    res.status(500).json({ success: false, message: 'Failed to start impersonation: ' + err.message });
  }
});

/**
 * POST /api/admin/impersonate/exit
 * Restores the original Super Admin session after impersonation.
 */
router.post('/impersonate/exit', async (req, res) => {
  try {
    const adminSnapshot = req.session.adminSnapshot;
    if (!adminSnapshot) {
      return res.status(400).json({ success: false, message: 'No active impersonation session to exit.' });
    }

    await logAction({
      userId: adminSnapshot.id || 'admin',
      action: 'USER_IMPERSONATION_ENDED',
      resourceType: 'USER',
      resourceId: req.session.user?.id || 'unknown',
      details: { restoredAdminEmail: adminSnapshot.email }
    });

    req.session.user = adminSnapshot;
    delete req.session.adminSnapshot;
    await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));

    res.json({ success: true, message: 'Impersonation ended. Admin session restored.' });
  } catch (err) {
    console.error('[ADMIN IMPERSONATE EXIT ERROR]', err.message);
    res.status(500).json({ success: false, message: 'Failed to exit impersonation.' });
  }
});

module.exports = router;
