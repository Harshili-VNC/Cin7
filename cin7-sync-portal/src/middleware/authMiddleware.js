const db = require('../db');
const subscriptionService = require('../services/subscriptionService');

function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    req.user = req.session.user;
    return next();
  }

  // Development auto-recovery if server restarted and MemoryStore was wiped
  if (process.env.NODE_ENV !== 'production') {
    const users = Object.values(db.data?.users || {});
    const activeUser = users.find(u => u.status === 'ACTIVE' && u.email !== 'automation.vncglobalgroup@gmail.com') || users[0];
    if (activeUser) {
      const userPayload = {
        id: activeUser.id,
        email: activeUser.email,
        fullName: activeUser.full_name || activeUser.name || 'Harshili',
        role: (activeUser.role === 'CLIENT' || !activeUser.role) ? 'ADMIN' : activeUser.role.toUpperCase(),
        platformRole: (activeUser.platform_role || 'USER').toUpperCase(),
        client_id: activeUser.client_id,
        clientId: activeUser.client_id,
        onboardingStatus: activeUser.onboarding_status || 'completed'
      };
      if (req.session) {
        req.session.user = userPayload;
      }
      req.user = userPayload;
      return next();
    }
  }

  return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Unauthorized. Please login to continue.' });
}

function requireRole(allowedRoles = []) {
  return (req, res, next) => {
    if (!req.user && req.session && req.session.user) {
      req.user = req.session.user;
    }
    if (!req.user && process.env.NODE_ENV !== 'production') {
      const users = Object.values(db.data?.users || {});
      const activeUser = users.find(u => u.status === 'ACTIVE' && u.email !== 'automation.vncglobalgroup@gmail.com') || users[0];
      if (activeUser) {
        req.user = {
          id: activeUser.id,
          email: activeUser.email,
          fullName: activeUser.full_name || activeUser.name || 'Harshili',
          role: (activeUser.role === 'CLIENT' || !activeUser.role) ? 'ADMIN' : activeUser.role.toUpperCase(),
          platformRole: (activeUser.platform_role || 'USER').toUpperCase(),
          client_id: activeUser.client_id,
          clientId: activeUser.client_id,
          onboardingStatus: activeUser.onboarding_status || 'completed'
        };
        if (req.session) req.session.user = req.user;
      }
    }
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Unauthorized. Please login to continue.' });
    }
    const userRole = (req.user.role || 'VIEWER').toUpperCase();
    const normalizedAllowed = allowedRoles.map(r => r.toUpperCase());
    
    if (normalizedAllowed.includes(userRole)) {
      return next();
    }
    return res.status(403).json({
      success: false,
      error: 'FORBIDDEN_ROLE',
      message: `Access denied. Requires one of: ${allowedRoles.join(', ')} (Current role: ${userRole})`
    });
  };
}

function requireSuperAdmin(req, res, next) {
  if (!req.user && req.session && req.session.user) {
    req.user = req.session.user;
  }
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Unauthorized. Please login to continue.' });
  }

  const platformRole = (req.user.platform_role || req.user.platformRole || '').toUpperCase();
  if (platformRole === 'SUPER_ADMIN') {
    return next();
  }

  return res.status(403).json({
    success: false,
    error: 'FORBIDDEN',
    message: 'Access denied. Requires SUPER_ADMIN platform privileges.'
  });
}

const requireAdmin = requireRole(['ADMIN']);
const requireCanSync = requireRole(['ADMIN', 'MANAGER']);
const requireCanManageSettings = requireRole(['ADMIN']);
const requireCanManageTeam = requireRole(['ADMIN']);

async function requireActiveSubscription(req, res, next) {
  const tenantId = req.user?.client_id || req.tenantId;
  if (!tenantId) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Tenant context missing.' });
  }

  try {
    const isActive = await subscriptionService.isSubscriptionActive(tenantId);
    if (!isActive) {
      return res.status(403).json({
        success: false,
        error: 'SUBSCRIPTION_EXPIRED',
        subscriptionStatus: 'EXPIRED',
        message: 'Your reporting subscription has expired. Please contact VNC to renew access.'
      });
    }
    next();
  } catch (err) {
    console.error('[AUTH MIDDLEWARE] Subscription check error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to verify subscription status.' });
  }
}

function requireFeature(featureName) {
  return async (req, res, next) => {
    const tenantId = req.user?.client_id || req.tenantId;
    if (!tenantId) {
      return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Tenant context missing.' });
    }

    try {
      const hasAccess = await subscriptionService.hasFeature(tenantId, featureName);
      if (!hasAccess) {
        return res.status(403).json({
          success: false,
          error: 'FEATURE_NOT_IN_PLAN',
          message: `Your current subscription plan does not include '${featureName}'. Upgrade your plan to unlock this feature.`
        });
      }
      next();
    } catch (err) {
      console.error('[AUTH MIDDLEWARE] Feature check error:', err.message);
      res.status(500).json({ success: false, error: 'Failed to verify feature entitlement.' });
    }
  };
}

module.exports = {
  requireAuth,
  requireRole,
  requireSuperAdmin,
  requireAdmin,
  requireCanSync,
  requireCanManageSettings,
  requireCanManageTeam,
  requireActiveSubscription,
  requireFeature
};