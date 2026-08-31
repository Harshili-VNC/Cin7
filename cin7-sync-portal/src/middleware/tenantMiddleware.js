/**
 * Tenant Scoping Middleware
 * Strictly enforces that every request resolves tenant identification from the authenticated session.
 * Rejects any external or client-supplied tenant_id overrides to prevent multi-tenant data leaks.
 */
function enforceTenantIsolation(req, res, next) {
  if (!req.user || !req.user.client_id) {
    return res.status(403).json({ error: 'Tenant context missing. Authorization denied.' });
  }

  // Bind tenant ID to request context
  req.tenantId = req.user.client_id;
  next();
}

module.exports = {
  enforceTenantIsolation
};
