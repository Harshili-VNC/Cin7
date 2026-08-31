const db = require('../db');

function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    req.user = req.session.user;
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized. Please login to continue.' });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'ADMIN') {
    req.user = req.session.user;
    return next();
  }
  return res.status(403).json({ error: 'Forbidden. Admin privileges required.' });
}

async function requireActiveSubscription(req, res, next) {
  if (!req.user || !req.user.client_id) {
    return res.status(401).json({ error: 'Unauthorized. Tenant context missing.' });
  }

  try {
    const client = await db.getOne('SELECT * FROM clients WHERE id = ?', [req.user.client_id]);
    if (!client) {
      return res.status(404).json({ error: 'Client organization not found.' });
    }

    const subStatus = (client.subscription_status || 'ACTIVE').toUpperCase();
    if (subStatus !== 'ACTIVE') {
      return res.status(403).json({
        success: false,
        error: 'SUBSCRIPTION_EXPIRED',
        subscriptionStatus: 'EXPIRED',
        message: 'Your reporting subscription has expired. Please contact VNC to renew access.'
      });
    }

    req.client = client;
    next();
  } catch (err) {
    console.error('[AUTH MIDDLEWARE] Subscription check error:', err.message);
    res.status(500).json({ error: 'Failed to verify subscription status.' });
  }
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireActiveSubscription
};