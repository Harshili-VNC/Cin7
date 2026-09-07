/**
 * Tenant Scoping & Isolation Middleware
 * Strictly enforces that every request resolves tenant identification from the authenticated session.
 * Rejects any external or client-supplied tenant_id overrides (e.g. x-client-id, query/body clientId)
 * to prevent multi-tenant data leaks and unauthorized cross-organization access.
 */

const clientStorageService = require('../services/clientStorageService');

function enforceTenantIsolation(req, res, next) {
  // Synchronize authenticated session user
  if (!req.user && req.session && req.session.user) {
    req.user = req.session.user;
  }

  // 1. Strict Server-Side Authority: Derive tenant exclusively from authenticated session
  const rawClientId = req.user?.client_id || req.session?.user?.client_id;

  if (!rawClientId) {
    return res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED_TENANT',
      message: 'Authenticated tenant context is missing or session expired. Access denied.'
    });
  }

  // 2. Format & Path Traversal Validation
  try {
    const validatedClientId = clientStorageService.validateClientId(rawClientId);
    req.tenantId = validatedClientId;
    req.organizationId = validatedClientId;
    next();
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_TENANT_ID',
      message: 'Invalid tenant identifier structure.'
    });
  }
}

module.exports = {
  enforceTenantIsolation
};
