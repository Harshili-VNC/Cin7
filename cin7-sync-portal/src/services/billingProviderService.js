const crypto = require('crypto');
const db = require('../db');
const subscriptionService = require('./subscriptionService');
const { v4: uuidv4 } = require('uuid');

/**
 * Provider-Neutral Billing Abstraction
 * Shields the application from direct third-party payment gateway dependencies.
 * No real payment provider SDKs are installed or invoked in this phase.
 */
class BillingProviderService {
  constructor() {
    this.providerName = process.env.BILLING_PROVIDER || 'neutral';
    this.webhookSecret = process.env.BILLING_WEBHOOK_SECRET || 'vnc_mock_billing_secret_2026';
  }

  /**
   * Generates a checkout session initiation descriptor.
   * Returns safe status indicating integration status.
   */
  async createCheckout({ organizationId, planCode, successUrl, cancelUrl, userEmail }) {
    if (!organizationId || !planCode) {
      throw new Error('Organization ID and Plan Code are required for checkout.');
    }

    const plan = await db.getOne('SELECT * FROM plans WHERE code = ?', [planCode.toUpperCase()]);
    if (!plan) {
      throw new Error(`Invalid plan code: ${planCode}`);
    }

    const isMockAllowed = process.env.NODE_ENV === 'test' || (process.env.NODE_ENV !== 'production' && process.env.ENABLE_MOCK_BILLING === 'true');

    if (isMockAllowed) {
      const mockSessionId = `mock_chk_${uuidv4().substring(0, 12)}`;
      return {
        provider: 'mock-billing',
        checkoutUrl: `${successUrl || '/settings'}?session_id=${mockSessionId}&plan=${plan.code}`,
        sessionId: mockSessionId,
        isMock: true,
        plan: { code: plan.code, name: plan.name, price: plan.price }
      };
    }

    return {
      provider: this.providerName,
      status: 'NOT_CONFIGURED',
      message: 'Payment gateway integration is pending configuration by VNC Platform Administrators.',
      plan: { code: plan.code, name: plan.name, price: plan.price }
    };
  }

  /**
   * Generates a Customer Billing Portal session URL.
   */
  async createPortal({ organizationId, returnUrl }) {
    if (!organizationId) {
      throw new Error('Organization ID required for billing portal.');
    }

    const isMockAllowed = process.env.NODE_ENV === 'test' || (process.env.NODE_ENV !== 'production' && process.env.ENABLE_MOCK_BILLING === 'true');

    if (isMockAllowed) {
      return {
        provider: 'mock-billing',
        portalUrl: `${returnUrl || '/settings'}?portal=mock_active`,
        isMock: true
      };
    }

    return {
      provider: this.providerName,
      status: 'NOT_CONFIGURED',
      message: 'Billing customer portal is not configured.'
    };
  }

  /**
   * Requests plan change (upgrade / downgrade).
   */
  async changePlan({ organizationId, newPlanCode }) {
    const plan = await db.getOne('SELECT * FROM plans WHERE code = ?', [newPlanCode.toUpperCase()]);
    if (!plan) {
      throw new Error(`Target plan not found: ${newPlanCode}`);
    }

    const isMockAllowed = process.env.NODE_ENV === 'test' || (process.env.NODE_ENV !== 'production' && process.env.ENABLE_MOCK_BILLING === 'true');

    // Update local subscription plan_id in test/mock environment
    if (isMockAllowed) {
      await db.query('UPDATE subscriptions SET plan_id = ?, status = ? WHERE organization_id = ?', [plan.id, 'ACTIVE', organizationId]);
      return {
        success: true,
        message: `Plan changed to ${plan.name} (Development/Test Mode)`,
        plan: { id: plan.id, code: plan.code, name: plan.name }
      };
    }

    return {
      success: false,
      status: 'NOT_CONFIGURED',
      message: 'Direct plan change requires active billing provider configuration.'
    };
  }

  /**
   * Returns active plan catalog.
   */
  async getPlans() {
    const plansRes = await db.query('SELECT * FROM plans WHERE is_active = TRUE');
    return (plansRes.rows || []).map(p => {
      let features = {};
      let limits = {};
      try { features = typeof p.features_json === 'string' ? JSON.parse(p.features_json) : (p.features_json || {}); } catch(e) {}
      try { limits = typeof p.limits_json === 'string' ? JSON.parse(p.limits_json) : (p.limits_json || {}); } catch(e) {}
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
  }

  /**
   * Helper alias for checkout initiation.
   */
  async createCheckoutSession(organizationId, planCode) {
    const result = await this.createCheckout({ organizationId, planCode });
    return {
      status: result.isMock ? 'MOCK_CHECKOUT_READY' : (result.status || 'READY'),
      url: result.checkoutUrl || '/settings',
      ...result
    };
  }

  /**
   * Cancels subscription (at period end or immediately).
   * Strictly preserves organization reports and history in read-only/retention state.
   */
  async cancelSubscription({ organizationId, atPeriodEnd = true }) {
    const sub = await subscriptionService.getOrganizationSubscription(organizationId);
    if (!sub) {
      throw new Error('No active subscription found for this organization.');
    }

    await db.query('UPDATE subscriptions SET status = ?, cancel_at_period_end = ? WHERE organization_id = ?', ['CANCELED', Boolean(atPeriodEnd), organizationId]);
    return {
      success: true,
      message: 'Subscription canceled. Account transitioned to read-only retention state.',
      status: 'CANCELED',
      cancelAtPeriodEnd: Boolean(atPeriodEnd)
    };
  }

  /**
   * Cryptographically verifies incoming webhook signature using HMAC-SHA256.
   */
  verifyWebhookSignature(payloadBuffer, signatureHeader, secret = this.webhookSecret) {
    if (!signatureHeader || !payloadBuffer) return false;
    try {
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(typeof payloadBuffer === 'string' ? payloadBuffer : JSON.stringify(payloadBuffer))
        .digest('hex');

      const cleanHeader = signatureHeader.replace(/^v1=/, '').trim();
      return crypto.timingSafeEqual(
        Buffer.from(cleanHeader, 'hex'),
        Buffer.from(expectedSignature, 'hex')
      );
    } catch (err) {
      return false;
    }
  }

  /**
   * Processes verified billing webhook events with strict idempotency deduplication.
   */
  async handleWebhook(event) {
    if (!event || !event.id || !event.type) {
      throw new Error('Invalid webhook event payload.');
    }

    // 1. Idempotency Check
    const existingEvent = await db.getOne('SELECT * FROM billing_events WHERE external_event_id = ?', [event.id]);
    if (existingEvent) {
      return { duplicate: true, message: 'Event already processed (Idempotent response).' };
    }

    const orgId = event.data?.organizationId || event.data?.organization_id;
    const eventType = event.type;
    const eventId = event.id;

    // 2. Process Event Type
    if (orgId) {
      switch (eventType) {
        case 'checkout.session.completed':
        case 'customer.subscription.created':
        case 'invoice.paid': {
          const planCode = event.data?.planCode || 'PROFESSIONAL';
          const plan = await db.getOne('SELECT * FROM plans WHERE code = ?', [planCode.toUpperCase()]);
          if (plan) {
            await db.query('UPDATE subscriptions SET status = ?, plan_id = ? WHERE organization_id = ?', ['ACTIVE', plan.id, orgId]);
          } else {
            await db.query('UPDATE subscriptions SET status = ? WHERE organization_id = ?', ['ACTIVE', orgId]);
          }
          break;
        }
        case 'invoice.payment_failed': {
          await db.query('UPDATE subscriptions SET status = ? WHERE organization_id = ?', ['PAST_DUE', orgId]);
          break;
        }
        case 'customer.subscription.deleted': {
          await db.query('UPDATE subscriptions SET status = ? WHERE organization_id = ?', ['EXPIRED', orgId]);
          break;
        }
        case 'customer.subscription.updated': {
          if (event.data?.status) {
            await db.query('UPDATE subscriptions SET status = ? WHERE organization_id = ?', [event.data.status.toUpperCase(), orgId]);
          }
          break;
        }
      }
    }

    // 3. Record in billing_events for idempotency
    const payloadHash = crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');
    await db.query(
      `INSERT INTO billing_events (id, billing_provider, external_event_id, event_type, organization_id, status, payload_hash)
       VALUES (?, ?, ?, ?, ?, 'PROCESSED', ?)`,
      [`bev-${uuidv4().substring(0, 8)}`, this.providerName, eventId, eventType, orgId || null, payloadHash]
    );

    return { success: true, processed: true, eventId, eventType };
  }
}

module.exports = new BillingProviderService();
