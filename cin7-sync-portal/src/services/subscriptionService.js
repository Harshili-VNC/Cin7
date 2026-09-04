const db = require('../db');
const { v4: uuidv4 } = require('uuid');

/**
 * Enterprise Subscription & Entitlement Service
 * Centralizes plan catalog, feature entitlements, usage tracking, and seat limit enforcement.
 * Tenant-scoped and provider-neutral.
 */
class SubscriptionService {
  /**
   * Retrieves active subscription for an organization.
   * If none exists for a registered organization, auto-provisions a default trial subscription.
   */
  async getOrganizationSubscription(organizationId) {
    if (!organizationId) return null;

    let sub = await db.getOne('SELECT * FROM subscriptions WHERE organization_id = ?', [organizationId]);
    if (!sub) {
      // Check if organization exists in DB
      const client = await db.getOne('SELECT * FROM clients WHERE id = ?', [organizationId]);
      if (client) {
        sub = await this.createTrialSubscription(organizationId, 'PROFESSIONAL', 14);
      }
    }
    return sub;
  }

  /**
   * Retrieves full plan details and parsed features/limits for an organization.
   */
  async getOrganizationPlan(organizationId) {
    const sub = await this.getOrganizationSubscription(organizationId);
    let plan = null;

    if (sub && sub.plan_id) {
      plan = await db.getOne('SELECT * FROM plans WHERE id = ? OR code = ?', [sub.plan_id, sub.plan_id]);
    }

    if (!plan) {
      plan = await db.getOne('SELECT * FROM plans WHERE code = ?', ['STARTER']);
    }

    if (!plan) {
      return {
        id: 'plan-starter',
        name: 'Starter',
        code: 'STARTER',
        price: 49.00,
        currency: 'USD',
        billingInterval: 'monthly',
        features: { cin7_sync: true, google_sheets: true, sales_reports: true, inventory_reports: true },
        limits: { max_users: 1, max_syncs_per_month: 30, max_cin7_connections: 1, max_google_sheets: 1, max_storage: 5, max_report_history_days: 30 }
      };
    }

    let features = {};
    let limits = {};
    try {
      features = typeof plan.features_json === 'string' ? JSON.parse(plan.features_json) : (plan.features_json || {});
    } catch (e) {}

    try {
      limits = typeof plan.limits_json === 'string' ? JSON.parse(plan.limits_json) : (plan.limits_json || {});
    } catch (e) {}

    return {
      id: plan.id,
      name: plan.name,
      code: plan.code,
      description: plan.description,
      price: Number(plan.price || 0),
      currency: plan.currency || 'USD',
      billingInterval: plan.billing_interval || 'monthly',
      features,
      limits
    };
  }

  /**
   * Checks if an organization's subscription includes a specific feature entitlement.
   */
  async hasFeature(organizationId, featureName) {
    const isActive = await this.isSubscriptionActive(organizationId);
    if (!isActive) return false;

    const plan = await this.getOrganizationPlan(organizationId);
    return Boolean(plan.features && plan.features[featureName]);
  }

  /**
   * Returns numerical quota for a given limit name.
   */
  async getLimit(organizationId, limitName) {
    const plan = await this.getOrganizationPlan(organizationId);
    return plan.limits && plan.limits[limitName] !== undefined ? plan.limits[limitName] : Infinity;
  }

  /**
   * Verifies if current usage is within allowed limit.
   */
  async checkLimit(organizationId, limitName, currentUsage) {
    const limit = await this.getLimit(organizationId, limitName);
    const allowed = currentUsage < limit;
    return {
      allowed,
      limit,
      current: currentUsage
    };
  }

  /**
   * Checks if subscription is in an active usable state (ACTIVE, TRIALING, or PAST_DUE within grace period).
   */
  async isSubscriptionActive(organizationId) {
    const sub = await this.getOrganizationSubscription(organizationId);
    if (!sub) return false;

    const status = (sub.status || 'ACTIVE').toUpperCase();
    if (status === 'ACTIVE') return true;

    if (status === 'TRIALING') {
      if (!sub.trial_end) return true;
      return new Date(sub.trial_end).getTime() > Date.now();
    }

    if (status === 'PAST_DUE') {
      return this.isSubscriptionInGracePeriod(organizationId);
    }

    if (status === 'CANCELED') {
      if (sub.cancel_at_period_end && sub.current_period_end) {
        return new Date(sub.current_period_end).getTime() > Date.now();
      }
      return false;
    }

    return false;
  }

  /**
   * Evaluates if past due subscription is within 7-day grace window.
   */
  async isSubscriptionInGracePeriod(organizationId) {
    const sub = await this.getOrganizationSubscription(organizationId);
    if (!sub || (sub.status || '').toUpperCase() !== 'PAST_DUE') return false;

    const periodEnd = sub.current_period_end ? new Date(sub.current_period_end).getTime() : new Date(sub.updated_at || Date.now()).getTime();
    const graceWindowMs = 7 * 24 * 60 * 60 * 1000; // 7 days grace
    return (Date.now() - periodEnd) < graceWindowMs;
  }

  /**
   * Computes live usage for an organization (users, syncs this month, snapshots/storage).
   */
  async getUsage(organizationId) {
    if (!organizationId) {
      return {
        users: { current: 0, limit: 1 },
        syncs: { current: 0, limit: 30 },
        storage: { current: 0, limit: 5 }
      };
    }

    const plan = await this.getOrganizationPlan(organizationId);

    // 1. User count
    const usersRes = await db.query('SELECT * FROM users WHERE client_id = ? AND status = ?', [organizationId, 'ACTIVE']);
    const userCount = (usersRes.rows || []).length;

    // 2. Sync runs this calendar month
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const syncRes = await db.query('SELECT * FROM sync_runs WHERE client_id = ?', [organizationId]);
    const monthSyncs = (syncRes.rows || []).filter(r => r.started_at && r.started_at >= startOfMonth).length;

    // 3. Storage / snapshots count
    const snapRes = await db.query('SELECT * FROM report_snapshots WHERE client_id = ?', [organizationId]);
    const snapCount = (snapRes.rows || []).length;
    const estStorageGb = Number((snapCount * 0.05).toFixed(2)); // estimated storage

    return {
      users: {
        current: userCount,
        limit: plan.limits.max_users || 10,
        percent: Math.min(100, Math.round((userCount / (plan.limits.max_users || 10)) * 100))
      },
      syncs: {
        current: monthSyncs,
        limit: plan.limits.max_syncs_per_month || 500,
        percent: Math.min(100, Math.round((monthSyncs / (plan.limits.max_syncs_per_month || 500)) * 100))
      },
      storage: {
        current: estStorageGb,
        limit: plan.limits.max_storage || 25,
        percent: Math.min(100, Math.round((estStorageGb / (plan.limits.max_storage || 25)) * 100))
      },
      snapshots: {
        current: snapCount,
        limit: plan.limits.max_report_history_days || 365
      }
    };
  }

  /**
   * Creates an isolated trial subscription for an organization.
   */
  async createTrialSubscription(organizationId, planCode = 'PROFESSIONAL', trialDays = 14) {
    const plan = await db.getOne('SELECT * FROM plans WHERE code = ?', [planCode]) ||
                 await db.getOne('SELECT * FROM plans WHERE code = ?', ['PROFESSIONAL']);

    const planId = plan ? plan.id : 'plan-professional';
    const subId = `sub-${uuidv4().substring(0, 8)}`;
    const now = new Date();
    const trialEnd = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);

    const subRecord = {
      id: subId,
      organization_id: organizationId,
      plan_id: planId,
      billing_provider: 'neutral',
      external_customer_id: null,
      external_subscription_id: null,
      external_price_id: null,
      status: 'TRIALING',
      current_period_start: now.toISOString(),
      current_period_end: trialEnd.toISOString(),
      trial_start: now.toISOString(),
      trial_end: trialEnd.toISOString(),
      cancel_at_period_end: false,
      canceled_at: null
    };

    await db.query(
      `INSERT INTO subscriptions (id, organization_id, plan_id, billing_provider, external_customer_id, external_subscription_id, external_price_id, status, current_period_start, current_period_end, trial_start, trial_end, cancel_at_period_end, canceled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        subRecord.id,
        subRecord.organization_id,
        subRecord.plan_id,
        subRecord.billing_provider,
        subRecord.external_customer_id,
        subRecord.external_subscription_id,
        subRecord.external_price_id,
        subRecord.status,
        subRecord.current_period_start,
        subRecord.current_period_end,
        subRecord.trial_start,
        subRecord.trial_end,
        subRecord.cancel_at_period_end,
        subRecord.canceled_at
      ]
    );

    return subRecord;
  }

  /**
   * Changes the plan assigned to an organization.
   */
  async changeOrganizationPlan(organizationId, planCodeOrId) {
    const plan = await db.getOne('SELECT * FROM plans WHERE code = ? OR id = ?', [planCodeOrId, planCodeOrId]);
    if (!plan) {
      throw new Error(`Plan '${planCodeOrId}' not found`);
    }

    const sub = await this.getOrganizationSubscription(organizationId);
    if (!sub) {
      throw new Error(`Subscription not found for organization '${organizationId}'`);
    }

    await db.query('UPDATE subscriptions SET plan_id = ? WHERE organization_id = ?', [plan.id, organizationId]);
    return this.getOrganizationPlan(organizationId);
  }

  /**
   * Returns formatted subscription status summary for UI.
   */
  async getSubscriptionStatus(organizationId) {
    const sub = await this.getOrganizationSubscription(organizationId);
    const plan = await this.getOrganizationPlan(organizationId);
    const usage = await this.getUsage(organizationId);

    const now = Date.now();
    let trialDaysRemaining = null;
    if (sub && sub.trial_end) {
      const msRemaining = new Date(sub.trial_end).getTime() - now;
      trialDaysRemaining = Math.max(0, Math.ceil(msRemaining / (1000 * 60 * 60 * 24)));
    }

    return {
      subscriptionId: sub ? sub.id : null,
      organizationId,
      status: sub ? (sub.status || 'ACTIVE').toUpperCase() : 'ACTIVE',
      plan: {
        id: plan.id,
        name: plan.name,
        code: plan.code,
        price: plan.price,
        currency: plan.currency,
        billingInterval: plan.billingInterval,
        features: plan.features,
        limits: plan.limits
      },
      currentPeriodStart: sub ? sub.current_period_start : null,
      currentPeriodEnd: sub ? sub.current_period_end : null,
      trialStart: sub ? sub.trial_start : null,
      trialEnd: sub ? sub.trial_end : null,
      trialDaysRemaining,
      cancelAtPeriodEnd: Boolean(sub && sub.cancel_at_period_end),
      canceledAt: sub ? sub.canceled_at : null,
      usage,
      billingProvider: sub ? (sub.billing_provider || 'neutral') : 'neutral',
      isConfigured: false // Payment gateway integration pending
    };
  }
}

module.exports = new SubscriptionService();
