const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/authMiddleware');
const { enforceTenantIsolation } = require('../middleware/tenantMiddleware');
const subscriptionService = require('../services/subscriptionService');
const billingProviderService = require('../services/billingProviderService');
const { logAction } = require('../services/auditService');

/**
 * GET /api/billing
 * Returns organization's current subscription, plan features, limits, and live usage.
 */
router.get('/', requireAuth, enforceTenantIsolation, async (req, res) => {
  const orgId = req.organizationId;
  try {
    const status = await subscriptionService.getSubscriptionStatus(orgId);
    const rawSub = await subscriptionService.getOrganizationSubscription(orgId);
    res.json({
      success: true,
      subscription: {
        organization_id: orgId,
        ...(rawSub || {}),
        ...status
      },
      ...status
    });
  } catch (err) {
    console.error('[BILLING STATUS ERROR]', err.message);
    res.status(500).json({ success: false, error: 'Failed to load organization subscription' });
  }
});

/**
 * GET /api/billing/plans
 * Returns active catalog of SaaS plans.
 */
router.get('/plans', async (req, res) => {
  try {
    const plansRes = await db.query('SELECT * FROM plans WHERE is_active = TRUE');
    const plans = (plansRes.rows || []).map(p => {
      let features = {};
      let limits = {};
      try {
        features = typeof p.features_json === 'string' ? JSON.parse(p.features_json) : (p.features_json || {});
      } catch (e) {}
      try {
        limits = typeof p.limits_json === 'string' ? JSON.parse(p.limits_json) : (p.limits_json || {});
      } catch (e) {}

      return {
        id: p.id,
        name: p.name,
        code: p.code,
        description: p.description,
        price: Number(p.price || 0),
        currency: p.currency || 'USD',
        billingInterval: p.billing_interval || 'monthly',
        features,
        limits
      };
    });

    res.json({ success: true, plans });
  } catch (err) {
    console.error('[BILLING PLANS ERROR]', err.message);
    res.status(500).json({ success: false, error: 'Failed to load subscription plans' });
  }
});

/**
 * POST /api/billing/checkout
 * Initiates checkout session. Restrict: ADMIN only.
 */
router.post('/checkout', requireAuth, enforceTenantIsolation, requireAdmin, async (req, res) => {
  const orgId = req.organizationId;
  const { planCode, successUrl, cancelUrl } = req.body;

  try {
    const result = await billingProviderService.createCheckout({
      organizationId: orgId,
      planCode: planCode || 'PROFESSIONAL',
      userEmail: req.user.email,
      successUrl,
      cancelUrl
    });

    await logAction({
      organizationId: orgId,
      userId: req.user.id,
      action: 'BILLING_CHECKOUT_INITIATED',
      resource: 'billing',
      details: { planCode }
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[BILLING CHECKOUT ERROR]', err.message);
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/billing/portal
 * Returns billing customer portal session URL. Restrict: ADMIN only.
 */
router.post('/portal', requireAuth, enforceTenantIsolation, requireAdmin, async (req, res) => {
  const orgId = req.organizationId;
  const { returnUrl } = req.body;

  try {
    const result = await billingProviderService.createPortal({
      organizationId: orgId,
      returnUrl
    });

    await logAction({
      organizationId: orgId,
      userId: req.user.id,
      action: 'BILLING_PORTAL_ACCESSED',
      resource: 'billing',
      details: {}
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[BILLING PORTAL ERROR]', err.message);
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/billing/change-plan
 * Upgrades or downgrades subscription plan. Restrict: ADMIN only.
 */
router.post('/change-plan', requireAuth, enforceTenantIsolation, requireAdmin, async (req, res) => {
  const orgId = req.organizationId;
  const { newPlanCode } = req.body;

  if (!newPlanCode) {
    return res.status(400).json({ success: false, message: 'New plan code is required.' });
  }

  try {
    const result = await billingProviderService.changePlan({
      organizationId: orgId,
      newPlanCode
    });

    await logAction({
      organizationId: orgId,
      userId: req.user.id,
      action: 'SUBSCRIPTION_PLAN_CHANGED',
      resource: 'billing',
      details: { targetPlan: newPlanCode }
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[BILLING CHANGE PLAN ERROR]', err.message);
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/billing/cancel
 * Schedules subscription cancellation at period end. Restrict: ADMIN only.
 */
router.post('/cancel', requireAuth, enforceTenantIsolation, requireAdmin, async (req, res) => {
  const orgId = req.organizationId;
  const { atPeriodEnd = true } = req.body;

  try {
    const result = await billingProviderService.cancelSubscription({
      organizationId: orgId,
      atPeriodEnd: Boolean(atPeriodEnd)
    });

    await logAction({
      organizationId: orgId,
      userId: req.user.id,
      action: 'SUBSCRIPTION_CANCEL_REQUESTED',
      resource: 'billing',
      details: { atPeriodEnd: Boolean(atPeriodEnd) }
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[BILLING CANCEL ERROR]', err.message);
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/billing/webhook
 * Provider-neutral webhook listener with cryptographic signature verification and idempotency deduplication.
 */
router.post('/webhook', async (req, res) => {
  const signature = req.headers['stripe-signature'] || req.headers['x-billing-signature'];

  // In dedicated test environment only, allow direct mock payload processing
  if (process.env.NODE_ENV === 'test') {
    try {
      const result = await billingProviderService.handleWebhook(req.body);
      return res.json({ success: true, result });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  }

  const isValid = billingProviderService.verifyWebhookSignature(req.body, signature);
  if (!isValid) {
    return res.status(400).json({ success: false, error: 'INVALID_SIGNATURE', message: 'Cryptographic webhook signature verification failed.' });
  }

  try {
    const result = await billingProviderService.handleWebhook(req.body);
    res.json({ success: true, result });
  } catch (err) {
    console.error('[BILLING WEBHOOK ERROR]', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
