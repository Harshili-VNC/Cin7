const fs = require('fs');
const path = require('path');
require('dotenv').config();

let pg;
try {
  pg = require('pg');
} catch (e) {}

class MemoryDatabaseAdapter {
  constructor() {
    this.storageFile = path.join(__dirname, 'portal_db_store.json');
    this.reset();
  }

  reset() {
    this.data = {
      clients: {},
      users: {},
      oauth_accounts: {},
      client_preferences: {},
      cin7_connections: {},
      destination_files: {},
      client_workbooks: {},
      sync_runs: {},
      sync_logs: [],
      report_snapshots: {},
      audit_logs: [],
      plans: {},
      subscriptions: {},
      billing_events: []
    };
    if (fs.existsSync(this.storageFile)) {
      try {
        const raw = fs.readFileSync(this.storageFile, 'utf8');
        this.data = JSON.parse(raw);
        if (!this.data.client_preferences) this.data.client_preferences = {};
        if (!this.data.oauth_accounts) this.data.oauth_accounts = {};
        if (!this.data.client_workbooks) this.data.client_workbooks = {};
        if (!this.data.sync_runs) this.data.sync_runs = {};
        if (!this.data.sync_logs) this.data.sync_logs = [];
        if (!this.data.report_snapshots) this.data.report_snapshots = {};
        if (!this.data.audit_logs) this.data.audit_logs = [];
        if (!this.data.plans) this.data.plans = {};
        if (!this.data.subscriptions) this.data.subscriptions = {};
        if (!this.data.billing_events) this.data.billing_events = [];

        // Backfill new fields for existing client records
        Object.values(this.data.clients || {}).forEach(c => {
          if (!c.subscription_status) c.subscription_status = 'ACTIVE';
          if (!c.current_version) c.current_version = 'v1.0';
          if (!c.sync_status) c.sync_status = 'IDLE';
          if (!c.last_sync_at) c.last_sync_at = null;
          if (!c.timezone) c.timezone = 'Asia/Kolkata';
          if (!c.sync_schedule_json) c.sync_schedule_json = JSON.stringify({ daily_sync: true, schedule_time: '02:00', timezone: c.timezone || 'Asia/Kolkata', incremental_sync: true });
          if (!c.notifications_config_json) c.notifications_config_json = JSON.stringify({ email_daily_summary: true, email_sync_completed: true, email_sync_failed: true, email_critical_errors: true, email_weekly_reports: false, slack_status: 'Not Connected', teams_status: 'Not Connected' });
        });

        // Ensure users have role, platform_role, and status
        Object.values(this.data.users || {}).forEach(u => {
          if (!u.role || u.role === 'CLIENT') u.role = 'ADMIN';
          if (!u.platform_role) u.platform_role = 'USER';
          if (!u.status) u.status = 'ACTIVE';
        });
      } catch (err) {}
    }

    // Seed default catalog plans if not present
    this.seedDefaultPlans();
  }

  seedDefaultPlans() {
    if (!this.data.plans) this.data.plans = {};
    if (Object.keys(this.data.plans).length === 0) {
      const plansList = [
        {
          id: 'plan-starter',
          name: 'Starter',
          code: 'STARTER',
          description: 'Essential Cin7 reporting & reconciliation for solo controllers',
          price: 49.00,
          currency: 'USD',
          billing_interval: 'monthly',
          is_active: true,
          features_json: JSON.stringify({
            cin7_sync: true,
            google_sheets: true,
            sales_reports: true,
            inventory_reports: true
          }),
          limits_json: JSON.stringify({
            max_users: 1,
            max_syncs_per_month: 30,
            max_cin7_connections: 1,
            max_google_sheets: 1,
            max_storage: 5,
            max_report_history_days: 30
          }),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        {
          id: 'plan-professional',
          name: 'Professional',
          code: 'PROFESSIONAL',
          description: 'Full-suite controller automation, multi-user collaboration & scheduled sync',
          price: 149.00,
          currency: 'USD',
          billing_interval: 'monthly',
          is_active: true,
          features_json: JSON.stringify({
            cin7_sync: true,
            google_sheets: true,
            sales_reports: true,
            purchase_reports: true,
            inventory_reports: true,
            advanced_reports: true,
            report_history: true,
            reconciliation: true,
            scheduled_sync: true,
            multiple_users: true,
            advanced_settings: true
          }),
          limits_json: JSON.stringify({
            max_users: 10,
            max_syncs_per_month: 500,
            max_cin7_connections: 5,
            max_google_sheets: 5,
            max_storage: 25,
            max_report_history_days: 365
          }),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        {
          id: 'plan-enterprise',
          name: 'Enterprise',
          code: 'ENTERPRISE',
          description: 'High-throughput consolidation, unlimited connections & priority support',
          price: 399.00,
          currency: 'USD',
          billing_interval: 'monthly',
          is_active: true,
          features_json: JSON.stringify({
            cin7_sync: true,
            google_sheets: true,
            sales_reports: true,
            purchase_reports: true,
            inventory_reports: true,
            advanced_reports: true,
            report_history: true,
            reconciliation: true,
            scheduled_sync: true,
            multiple_users: true,
            advanced_settings: true,
            api_access: true,
            priority_support: true
          }),
          limits_json: JSON.stringify({
            max_users: 50,
            max_syncs_per_month: 5000,
            max_cin7_connections: 999,
            max_google_sheets: 999,
            max_storage: 100,
            max_report_history_days: 3650
          }),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      ];

      plansList.forEach(p => {
        this.data.plans[p.id] = p;
      });
      this.save();
    }
  }

  save() {
    try {
      fs.writeFileSync(this.storageFile, JSON.stringify(this.data, null, 2));
    } catch (err) {}
  }

  async query(sql, params = []) {
    const cleanSql = sql.trim().toUpperCase();

    // SELECT
    if (cleanSql.startsWith('SELECT')) {
      let collection = [];
      if (cleanSql.includes('FROM CLIENTS')) collection = Object.values(this.data.clients);
      else if (cleanSql.includes('FROM USERS')) collection = Object.values(this.data.users);
      else if (cleanSql.includes('FROM OAUTH_ACCOUNTS')) collection = Object.values(this.data.oauth_accounts);
      else if (cleanSql.includes('FROM CLIENT_PREFERENCES')) collection = Object.values(this.data.client_preferences);
      else if (cleanSql.includes('FROM CIN7_CONNECTIONS')) collection = Object.values(this.data.cin7_connections);
      else if (cleanSql.includes('FROM DESTINATION_FILES')) collection = Object.values(this.data.destination_files);
      else if (cleanSql.includes('FROM CLIENT_WORKBOOKS')) collection = Object.values(this.data.client_workbooks);
      else if (cleanSql.includes('FROM SYNC_RUNS')) collection = Object.values(this.data.sync_runs);
      else if (cleanSql.includes('FROM SYNC_LOGS')) collection = this.data.sync_logs;
      else if (cleanSql.includes('FROM REPORT_SNAPSHOTS')) collection = Object.values(this.data.report_snapshots || {});
      else if (cleanSql.includes('FROM AUDIT_LOGS')) collection = this.data.audit_logs || [];
      else if (cleanSql.includes('FROM PLANS')) collection = Object.values(this.data.plans || {});
      else if (cleanSql.includes('FROM SUBSCRIPTIONS')) collection = Object.values(this.data.subscriptions || {});
      else if (cleanSql.includes('FROM BILLING_EVENTS')) collection = this.data.billing_events || [];
      else return { rows: [{ test: 1 }] };

      let rows = collection.filter(item => {
        if (cleanSql.includes('WHERE EMAIL = ? AND CLIENT_ID = ? AND STATUS = ?')) {
          const [email, clientId, status] = params;
          return String(item.email || '').toLowerCase() === String(email).toLowerCase() &&
                 item.client_id === clientId &&
                 item.status === status;
        }

        if (cleanSql.includes('WHERE EMAIL = ? AND CLIENT_ID = ?')) {
          const [email, clientId] = params;
          return String(item.email || '').toLowerCase() === String(email).toLowerCase() &&
                 item.client_id === clientId;
        }

        if (cleanSql.includes('WHERE (ID = ? OR EMAIL = ?) AND CLIENT_ID = ?')) {
          const [id, email, clientId] = params;
          const userMatch = item.id === id || String(item.email || '').toLowerCase() === String(email).toLowerCase();
          return userMatch && item.client_id === clientId;
        }

        if (cleanSql.includes('WHERE ID = ? AND CLIENT_ID = ?') || cleanSql.includes('WHERE (ID = ? OR RUN_ID = ?) AND CLIENT_ID = ?')) {
          const runIdMatch = (item.id === params[0] || item.run_id === params[0] || (params.length === 3 && (item.id === params[1] || item.run_id === params[1])));
          const tenantMatch = item.client_id === (params.length === 3 ? params[2] : params[1]);
          return runIdMatch && tenantMatch;
        }

        if (cleanSql.includes('WHERE CLIENT_ID = ? AND ID = ?')) {
          return item.client_id === params[0] && (item.id === params[1] || item.run_id === params[1]);
        }

        if (cleanSql.includes('WHERE ORGANIZATION_ID = ? AND STATUS = ?')) {
          if (params.length >= 2) {
            return item.organization_id === params[0] && item.status === params[1];
          }
        }

        if (cleanSql.includes('WHERE ORGANIZATION_ID = ?')) {
          if (params[0] && item.organization_id !== params[0]) return false;
        }

        if (cleanSql.includes('WHERE CODE = ?')) {
          if (params[0] && item.code !== params[0]) return false;
        }

        if (cleanSql.includes('WHERE EXTERNAL_EVENT_ID = ?')) {
          if (params[0] && item.external_event_id !== params[0]) return false;
        }

        if (cleanSql.includes('WHERE IS_ACTIVE = ?') || cleanSql.includes('WHERE IS_ACTIVE = TRUE')) {
          if (item.is_active === false) return false;
        }

        if (cleanSql.includes("WHERE STATUS = 'ACTIVE'")) {
          if (item.status !== 'ACTIVE') return false;
        }

        if (cleanSql.includes('WHERE STATUS = ?') && !cleanSql.includes('ORGANIZATION_ID = ?') && !cleanSql.includes('CLIENT_ID = ?')) {
          if (params[0] && item.status !== params[0]) return false;
        }

        if (cleanSql.includes('WHERE CLIENT_ID = ? AND STATUS =')) {
          if (item.client_id !== params[0]) return false;
          if (cleanSql.includes("'CONNECTED'") && item.status !== 'CONNECTED') return false;
          if (cleanSql.includes("'COMPLETED'") && item.status !== 'COMPLETED') return false;
          return true;
        }

        if (cleanSql.includes('WHERE CLIENT_ID = ?')) {
          if (params[0] && item.client_id !== params[0]) return false;
        }

        if (cleanSql.includes('WHERE EMAIL = ?')) {
          if (params[0] && String(item.email || '').toLowerCase() !== String(params[0]).toLowerCase()) return false;
        }

        if (cleanSql.includes('WHERE PLATFORM_ROLE = ?')) {
          if (params[0] && item.platform_role !== params[0]) return false;
        }

        if (cleanSql.includes('WHERE ID = ?') && !cleanSql.includes('CLIENT_ID = ?')) {
          if (params[0] && item.id !== params[0] && item.run_id !== params[0] && item.code !== params[0]) return false;
        }

        if (cleanSql.includes('WHERE USER_ID = ? AND PROVIDER = ?')) {
          if (params.length >= 2) {
            return item.user_id === params[0] && item.provider === params[1];
          }
        }

        if (cleanSql.includes('WHERE USER_ID = ?')) {
          if (params[0] && item.user_id !== params[0]) return false;
        }

        return true;
      });

      if (cleanSql.includes('ORDER BY') && (cleanSql.includes('DESC') || cleanSql.includes('STARTED_AT') || cleanSql.includes('CREATED_AT') || cleanSql.includes('TIMESTAMP'))) {
        rows.sort((a, b) => new Date(b.started_at || b.created_at || b.timestamp || 0) - new Date(a.started_at || a.created_at || a.timestamp || 0));
      }

      if (cleanSql.includes('LIMIT ? OFFSET ?') && params.length >= 2) {
        const limit = params[params.length - 2];
        const offset = params[params.length - 1];
        return { rows: rows.slice(offset, offset + limit) };
      }

      return { rows };
    }

    // INSERT
    if (cleanSql.includes('INSERT INTO CLIENTS')) {
      let id, company_name, phone_number, status, onboarding_status, subscription_status, current_version;
      if (params.length >= 7) {
        [id, company_name, phone_number, status, onboarding_status, subscription_status, current_version] = params;
      } else if (params.length >= 6) {
        [id, company_name, phone_number, status, onboarding_status, subscription_status] = params;
        current_version = 'v1.0';
      } else if (params.length >= 3) {
        [id, company_name, phone_number] = params;
        status = 'ACTIVE';
        onboarding_status = 'completed';
        subscription_status = 'ACTIVE';
        current_version = 'v1.0';
      } else {
        [id, company_name] = params;
        status = 'ACTIVE';
        onboarding_status = 'completed';
        subscription_status = 'ACTIVE';
        current_version = 'v1.0';
      }

      const record = {
        id,
        company_name,
        phone_number: phone_number || null,
        status: status || 'ACTIVE',
        onboarding_status: onboarding_status || 'completed',
        subscription_status: subscription_status || 'ACTIVE',
        current_version: current_version || 'v1.0',
        sync_status: 'IDLE',
        last_sync_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      this.data.clients[id] = record;
      this.save();
      return { rows: [record] };
    }

    if (cleanSql.includes('INSERT INTO USERS')) {
      let id, client_id, full_name, email, phone_number, password_hash, role, platform_role, status, auth_provider, onboarding_status;
      if (params.length === 11) {
        [id, client_id, full_name, email, phone_number, password_hash, role, platform_role, status, auth_provider, onboarding_status] = params;
      } else if (params.length === 10) {
        [id, client_id, full_name, email, phone_number, password_hash, role, status, auth_provider, onboarding_status] = params;
      } else if (params.length === 9) {
        [id, client_id, full_name, email, phone_number, password_hash, role, auth_provider, onboarding_status] = params;
      } else if (params.length === 8) {
        [id, client_id, full_name, email, phone_number, password_hash, role, status] = params;
      } else if (params.length === 7) {
        [id, client_id, full_name, email, phone_number, password_hash, role] = params;
      } else if (params.length === 6) {
        if (cleanSql.includes('PHONE_NUMBER') && cleanSql.includes('PASSWORD_HASH')) {
          [id, client_id, full_name, email, phone_number, password_hash] = params;
        } else {
          [id, client_id, full_name, email, password_hash, role] = params;
          phone_number = '+1 (555) 019-2834';
        }
      } else {
        [id, client_id, full_name, email, password_hash] = params;
      }

      const record = {
        id,
        client_id,
        full_name,
        email,
        phone_number: phone_number || null,
        password_hash,
        role: role || 'ADMIN',
        platform_role: platform_role || (role === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : 'USER'),
        status: status || 'ACTIVE',
        auth_provider: auth_provider || 'local',
        onboarding_status: onboarding_status || 'completed',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      this.data.users[id] = record;
      this.save();
      return { rows: [record] };
    }

    if (cleanSql.includes('INSERT INTO PLANS')) {
      const [id, name, code, description, price, currency, billing_interval, is_active, features_json, limits_json, external_price_id] = params;
      const record = {
        id,
        name,
        code,
        description: description || '',
        price: price || 0,
        currency: currency || 'USD',
        billing_interval: billing_interval || 'monthly',
        is_active: is_active !== false,
        features_json: typeof features_json === 'object' ? JSON.stringify(features_json) : (features_json || '{}'),
        limits_json: typeof limits_json === 'object' ? JSON.stringify(limits_json) : (limits_json || '{}'),
        external_price_id: external_price_id || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      if (!this.data.plans) this.data.plans = {};
      this.data.plans[id] = record;
      this.save();
      return { rows: [record] };
    }

    if (cleanSql.includes('INSERT INTO SUBSCRIPTIONS')) {
      let id, organization_id, plan_id, billing_provider, external_customer_id, external_subscription_id, external_price_id, status, current_period_start, current_period_end, trial_start, trial_end, cancel_at_period_end, canceled_at;
      if (params.length >= 8) {
        [id, organization_id, plan_id, billing_provider, external_customer_id, external_subscription_id, external_price_id, status, current_period_start, current_period_end, trial_start, trial_end, cancel_at_period_end, canceled_at] = params;
      } else {
        [id, organization_id, plan_id, status] = params;
      }

      const record = {
        id,
        organization_id,
        plan_id,
        billing_provider: billing_provider || 'neutral',
        external_customer_id: external_customer_id || null,
        external_subscription_id: external_subscription_id || null,
        external_price_id: external_price_id || null,
        status: status || 'ACTIVE',
        current_period_start: current_period_start || new Date().toISOString(),
        current_period_end: current_period_end || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        trial_start: trial_start || null,
        trial_end: trial_end || null,
        cancel_at_period_end: Boolean(cancel_at_period_end),
        canceled_at: canceled_at || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      if (!this.data.subscriptions) this.data.subscriptions = {};
      this.data.subscriptions[organization_id] = record;
      this.save();
      return { rows: [record] };
    }

    if (cleanSql.includes('INSERT INTO BILLING_EVENTS')) {
      const [id, billing_provider, external_event_id, event_type, organization_id, status, payload_hash] = params;
      const record = {
        id,
        billing_provider: billing_provider || 'neutral',
        external_event_id: external_event_id || id,
        event_type,
        organization_id: organization_id || null,
        processed_at: new Date().toISOString(),
        status: status || 'PROCESSED',
        payload_hash: payload_hash || null,
        created_at: new Date().toISOString()
      };
      if (!this.data.billing_events) this.data.billing_events = [];
      this.data.billing_events.unshift(record);
      this.save();
      return { rows: [record] };
    }

    if (cleanSql.includes('INSERT INTO CLIENT_WORKBOOKS')) {
      const [id, client_id, workbook_path, current_version, file_name] = params;
      const record = {
        id,
        client_id,
        workbook_path,
        current_version: current_version || 'v1.0',
        file_name: file_name || 'Controller_Reporting_Model_v5_Cin7_Actuals.xlsx',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      this.data.client_workbooks[client_id] = record;
      this.save();
      return { rows: [record] };
    }

    if (cleanSql.includes('INSERT INTO CIN7_CONNECTIONS')) {
      const [id, client_id, api_username_encrypted, api_key_encrypted, status, last_tested_at] = params;
      const record = {
        id,
        client_id,
        api_username_encrypted,
        api_key_encrypted,
        status: status || 'CONNECTED',
        last_tested_at: last_tested_at || new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      this.data.cin7_connections[client_id] = record;
      this.save();
      return { rows: [record] };
    }

    if (cleanSql.includes('INSERT INTO SYNC_RUNS')) {
      let id, client_id, user_id, run_id, sync_type, status, destination_provider, destination_file_id, destination_file_name, excel_version_id;
      if (params.length >= 10) {
        [id, client_id, user_id, run_id, sync_type, status, destination_provider, destination_file_id, destination_file_name, excel_version_id] = params;
      } else if (params.length >= 6) {
        [id, client_id, user_id, run_id, sync_type, status] = params;
      } else if (params.length === 5) {
        [id, client_id, user_id, run_id, sync_type] = params;
        status = 'RUNNING';
      } else {
        [id, client_id, sync_type, status] = params;
        run_id = id;
      }

      const record = {
        id,
        client_id,
        user_id: user_id || null,
        run_id: run_id || id,
        sync_type: sync_type || 'all',
        status: status || 'RUNNING',
        records_processed: 0,
        duration_ms: 0,
        error_message: null,
        destination_provider: 'server-xlsx',
        destination_file_id: 'reporting.xlsx',
        destination_file_name: 'Controller_Reporting_Model_v5_Cin7_Actuals.xlsx',
        excel_version_id: excel_version_id || null,
        started_at: new Date().toISOString(),
        completed_at: null,
        created_at: new Date().toISOString()
      };
      this.data.sync_runs[id] = record;
      this.save();
      return { rows: [record] };
    }

    if (cleanSql.includes('INSERT INTO DESTINATION_FILES')) {
      const [id, client_id, provider, file_id, file_name, file_url] = params;
      const record = {
        id,
        client_id,
        provider: provider || 'google',
        file_id,
        file_name,
        file_url,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      this.data.destination_files[id] = record;
      this.save();
      return { rows: [record] };
    }

    if (cleanSql.includes('DELETE FROM DESTINATION_FILES')) {
      if (params.length === 2 && cleanSql.includes('CLIENT_ID = ? AND PROVIDER = ?')) {
        const [clientId, provider] = params;
        Object.keys(this.data.destination_files).forEach(k => {
          if (this.data.destination_files[k].client_id === clientId && this.data.destination_files[k].provider === provider) {
            delete this.data.destination_files[k];
          }
        });
      } else if (params.length === 2 && cleanSql.includes('PROVIDER = ? OR FILE_URL LIKE ?')) {
        const [provider, pattern] = params;
        Object.keys(this.data.destination_files).forEach(k => {
          if (this.data.destination_files[k].provider === provider || (this.data.destination_files[k].file_url && this.data.destination_files[k].file_url.includes('onedrive'))) {
            delete this.data.destination_files[k];
          }
        });
      } else {
        this.data.destination_files = {};
      }
      this.save();
      return { rows: [] };
    }

    if (cleanSql.includes('INSERT INTO SYNC_LOGS')) {
      const [id, sync_run_id, client_id, log_level, message] = params;
      const record = { id, sync_run_id, client_id, log_level: log_level || 'INFO', message, timestamp: new Date().toISOString() };
      this.data.sync_logs.unshift(record);
      this.save();
      return { rows: [record] };
    }

    if (cleanSql.includes('INSERT INTO REPORT_SNAPSHOTS')) {
      const [id, client_id, report_type, report_name, period_label, record_count, sync_run_id, file_path, totals_json, created_at] = params;
      const record = {
        id,
        client_id,
        report_type,
        report_name,
        period_label,
        record_count: record_count || 0,
        status: 'SUCCESS',
        sync_run_id: sync_run_id || null,
        file_path: file_path || null,
        totals_json: totals_json || '{}',
        created_at: created_at || new Date().toISOString()
      };
      if (!this.data.report_snapshots) this.data.report_snapshots = {};
      this.data.report_snapshots[id] = record;
      this.save();
      return { rows: [record] };
    }

    if (cleanSql.includes('INSERT INTO AUDIT_LOGS')) {
      const [id, organization_id, user_id, action, resource, result, details_json] = params;
      const record = {
        id,
        organization_id,
        user_id: user_id || null,
        action,
        resource,
        result: result || 'SUCCESS',
        details_json: details_json || '{}',
        created_at: new Date().toISOString()
      };
      if (!this.data.audit_logs) this.data.audit_logs = [];
      this.data.audit_logs.unshift(record);
      this.save();
      return { rows: [record] };
    }

    // DELETE
    if (cleanSql.includes('DELETE FROM CLIENTS')) {
      if (cleanSql.includes('WHERE ID = ?')) {
        delete this.data.clients[params[0]];
      }
      this.save();
      return { rows: [] };
    }

    if (cleanSql.includes('DELETE FROM USERS')) {
      if (cleanSql.includes('WHERE ID = ? AND CLIENT_ID = ?') || cleanSql.includes('WHERE ID = ? AND ORGANIZATION_ID = ?')) {
        const [userId, clientId] = params;
        if (this.data.users[userId] && this.data.users[userId].client_id === clientId) {
          delete this.data.users[userId];
        }
      } else if (cleanSql.includes('WHERE CLIENT_ID = ?')) {
        const clientId = params[0];
        Object.keys(this.data.users || {}).forEach(k => {
          if (this.data.users[k].client_id === clientId) delete this.data.users[k];
        });
      } else if (cleanSql.includes('WHERE ID = ?')) {
        delete this.data.users[params[0]];
      }
      this.save();
      return { rows: [] };
    }

    if (cleanSql.includes('DELETE FROM SUBSCRIPTIONS')) {
      if (cleanSql.includes('WHERE ORGANIZATION_ID = ?')) {
        const orgId = params[0];
        Object.keys(this.data.subscriptions || {}).forEach(k => {
          if (this.data.subscriptions[k].organization_id === orgId) delete this.data.subscriptions[k];
        });
      } else if (cleanSql.includes('WHERE ID = ?')) {
        delete this.data.subscriptions[params[0]];
      }
      this.save();
      return { rows: [] };
    }

    if (cleanSql.includes('DELETE FROM CIN7_CONNECTIONS')) {
      if (cleanSql.includes('WHERE CLIENT_ID = ?')) {
        const clientId = params[0];
        Object.keys(this.data.cin7_connections || {}).forEach(k => {
          if (this.data.cin7_connections[k].client_id === clientId) delete this.data.cin7_connections[k];
        });
      } else if (cleanSql.includes('WHERE ID = ?')) {
        delete this.data.cin7_connections[params[0]];
      }
      this.save();
      return { rows: [] };
    }

    if (cleanSql.includes('DELETE FROM SYNC_RUNS')) {
      if (cleanSql.includes('WHERE CLIENT_ID = ?')) {
        const clientId = params[0];
        Object.keys(this.data.sync_runs || {}).forEach(k => {
          if (this.data.sync_runs[k].client_id === clientId) delete this.data.sync_runs[k];
        });
      }
      this.save();
      return { rows: [] };
    }

    // UPDATE
    if (cleanSql.includes('UPDATE CLIENTS')) {
      const clientId = params[params.length - 1];
      const client = this.data.clients[clientId];
      if (client) {
        if (cleanSql.includes('COMPANY_NAME = ?') && cleanSql.includes('TIMEZONE = ?')) {
          client.company_name = params[0];
          client.timezone = params[1];
        } else if (cleanSql.includes('COMPANY_NAME = ?')) {
          client.company_name = params[0];
        }

        if (cleanSql.includes('TIMEZONE = ?') && !cleanSql.includes('COMPANY_NAME = ?')) {
          client.timezone = params[0];
        }

        if (cleanSql.includes('SYNC_SCHEDULE_JSON = ?')) {
          client.sync_schedule_json = typeof params[0] === 'object' ? JSON.stringify(params[0]) : params[0];
        }

        if (cleanSql.includes('NOTIFICATIONS_CONFIG_JSON = ?')) {
          client.notifications_config_json = typeof params[0] === 'object' ? JSON.stringify(params[0]) : params[0];
        }

        if (cleanSql.includes('SUBSCRIPTION_STATUS = ?')) {
          client.subscription_status = params[0];
        } else if (cleanSql.includes("SUBSCRIPTION_STATUS = 'EXPIRED'")) {
          client.subscription_status = 'EXPIRED';
        } else if (cleanSql.includes("SUBSCRIPTION_STATUS = 'ACTIVE'")) {
          client.subscription_status = 'ACTIVE';
        }

        if (cleanSql.includes('CURRENT_VERSION = ?') && cleanSql.includes('LAST_SYNC_AT = ?')) {
          const [current_version, last_sync_at, sync_status] = params;
          client.current_version = current_version;
          client.last_sync_at = last_sync_at;
          if (sync_status) client.sync_status = sync_status;
        }

        if (cleanSql.includes('ONBOARDING_STATUS =')) {
          client.onboarding_status = 'completed';
          client.onboarding_completed_at = new Date().toISOString();
        }

        client.updated_at = new Date().toISOString();
        this.save();
      }
      return { rows: [] };
    }

    if (cleanSql.includes('UPDATE CLIENT_WORKBOOKS')) {
      const clientId = params[params.length - 1];
      if (this.data.client_workbooks[clientId]) {
        const [current_version, updated_at] = params;
        this.data.client_workbooks[clientId].current_version = current_version;
        this.data.client_workbooks[clientId].updated_at = updated_at || new Date().toISOString();
        this.save();
      }
      return { rows: [] };
    }

    if (cleanSql.includes('UPDATE USERS')) {
      if (cleanSql.includes("SET ONBOARDING_STATUS = 'COMPLETED'") && cleanSql.includes('WHERE CLIENT_ID = ?')) {
        const clientId = params[params.length - 1];
        Object.values(this.data.users).forEach(u => {
          if (u.client_id === clientId || u.id === clientId) {
            u.onboarding_status = 'completed';
            u.onboarding_completed_at = new Date().toISOString();
            u.updated_at = new Date().toISOString();
          }
        });
      } else if (cleanSql.includes('ROLE = ?') && cleanSql.includes('STATUS = ?')) {
        const [role, status, userId, clientId] = params;
        const u = this.data.users[userId];
        if (u && (!clientId || u.client_id === clientId)) {
          u.role = role;
          u.status = status;
          u.updated_at = new Date().toISOString();
        }
      } else if (cleanSql.includes('CLIENT_ID = ?') && cleanSql.includes('FULL_NAME = ?')) {
        const [clientId, fullName, phoneNumber, onboardingStatus, target] = params;
        const u = this.data.users[target] || Object.values(this.data.users).find(x => String(x.email).toLowerCase() === String(target).toLowerCase() || x.id === target);
        if (u) {
          u.client_id = clientId;
          if (fullName) u.full_name = fullName;
          if (phoneNumber) u.phone_number = phoneNumber;
          if (onboardingStatus) u.onboarding_status = onboardingStatus;
          u.updated_at = new Date().toISOString();
        }
      } else if (cleanSql.includes('CLIENT_ID = ?') && cleanSql.includes('ONBOARDING_STATUS = ?')) {
        const [clientId, onboardingStatus, target] = params;
        const u = this.data.users[target] || Object.values(this.data.users).find(x => String(x.email).toLowerCase() === String(target).toLowerCase() || x.id === target);
        if (u) {
          u.client_id = clientId;
          u.onboarding_status = onboardingStatus;
          u.updated_at = new Date().toISOString();
        }
      } else if (cleanSql.includes('CLIENT_ID = ?') && (cleanSql.includes("ONBOARDING_STATUS = 'COMPLETED'") || cleanSql.includes("ONBOARDING_STATUS = 'PENDING_CLIENT_SELECTION'"))) {
        const [clientId, target] = params;
        const u = this.data.users[target] || Object.values(this.data.users).find(x => String(x.email).toLowerCase() === String(target).toLowerCase() || x.id === target);
        if (u) {
          u.client_id = clientId;
          u.onboarding_status = cleanSql.includes("ONBOARDING_STATUS = 'COMPLETED'") ? 'completed' : 'pending_client_selection';
          u.updated_at = new Date().toISOString();
        }
      } else if (cleanSql.includes('CLIENT_ID = ?')) {
        const [clientId, target] = params;
        const u = this.data.users[target] || Object.values(this.data.users).find(x => String(x.email).toLowerCase() === String(target).toLowerCase() || x.id === target);
        if (u) {
          u.client_id = clientId;
          u.updated_at = new Date().toISOString();
        }
      } else if (cleanSql.includes('PASSWORD_HASH = ?')) {
        const target = params[params.length - 1];
        const password_hash = params[0];
        const u = this.data.users[target] || Object.values(this.data.users).find(x => x.id === target || String(x.email).toLowerCase() === String(target).toLowerCase());
        if (u) {
          u.password_hash = password_hash;
          if (cleanSql.includes('PLATFORM_ROLE = ?') && params.length >= 3) {
            u.platform_role = params[1];
          }
          u.updated_at = new Date().toISOString();
        }
      } else if (cleanSql.includes('FULL_NAME = ?')) {
        const [full_name, phone_number, userId] = params;
        const u = this.data.users[userId] || Object.values(this.data.users).find(x => x.id === userId || String(x.email).toLowerCase() === String(userId).toLowerCase());
        if (u) {
          u.full_name = full_name;
          if (phone_number) u.phone_number = phone_number;
          u.updated_at = new Date().toISOString();
        }
      } else {
        const clientId = params[params.length - 1];
        Object.values(this.data.users).forEach(u => {
          if (u.client_id === clientId || u.id === clientId) {
            u.onboarding_status = 'completed';
            u.onboarding_completed_at = new Date().toISOString();
          }
        });
      }
      this.save();
      return { rows: [] };
    }

    if (cleanSql.includes('UPDATE CIN7_CONNECTIONS')) {
      const [api_username_encrypted, api_key_encrypted, status, last_tested_at, updated_at, client_id] = params;
      if (this.data.cin7_connections[client_id]) {
        Object.assign(this.data.cin7_connections[client_id], {
          api_username_encrypted, api_key_encrypted, status: status || 'CONNECTED', last_tested_at, updated_at
        });
        this.save();
      }
      return { rows: [] };
    }

    if (cleanSql.includes('UPDATE SYNC_RUNS')) {
      let runRecord = null;
      for (const p of params) {
        if (typeof p === 'string' && (this.data.sync_runs[p] || Object.values(this.data.sync_runs).find(r => r.run_id === p || r.id === p))) {
          runRecord = this.data.sync_runs[p] || Object.values(this.data.sync_runs).find(r => r.run_id === p || r.id === p);
          break;
        }
      }

      if (runRecord) {
        if (cleanSql.includes("STATUS = 'COMPLETED'")) {
          let records_processed, duration_ms, excel_version_id;
          if (params.length >= 4) {
            [records_processed, duration_ms, excel_version_id] = params;
          } else {
            [records_processed, duration_ms] = params;
          }
          Object.assign(runRecord, {
            status: 'COMPLETED',
            records_processed: records_processed || 0,
            duration_ms: duration_ms || 0,
            excel_version_id: excel_version_id || 'v1.0',
            completed_at: new Date().toISOString()
          });
        } else if (cleanSql.includes("STATUS = 'FAILED'")) {
          const [error_message, duration_ms] = params;
          Object.assign(runRecord, {
            status: 'FAILED',
            error_message: error_message || 'Sync failed',
            duration_ms: duration_ms || 0,
            completed_at: new Date().toISOString()
          });
        }
        this.save();
      }
      return { rows: [] };
    }

    if (cleanSql.includes('UPDATE SUBSCRIPTIONS')) {
      const orgId = params[params.length - 1];
      const sub = this.data.subscriptions[orgId] || Object.values(this.data.subscriptions || {}).find(s => s.organization_id === orgId || s.id === orgId);
      if (sub) {
        if (cleanSql.includes("STATUS = 'EXPIRED'")) {
          sub.status = 'EXPIRED';
        } else if (cleanSql.includes("STATUS = 'ACTIVE'")) {
          sub.status = 'ACTIVE';
        } else if (cleanSql.includes("STATUS = 'TRIALING'")) {
          sub.status = 'TRIALING';
        } else if (cleanSql.includes("STATUS = 'PAST_DUE'")) {
          sub.status = 'PAST_DUE';
        } else if (cleanSql.includes("STATUS = 'CANCELED'")) {
          sub.status = 'CANCELED';
        }

        if (cleanSql.includes('STATUS = ?') && cleanSql.includes('PLAN_ID = ?')) {
          const [status, plan_id] = params;
          sub.status = status;
          sub.plan_id = plan_id;
        } else if (cleanSql.includes('STATUS = ?')) {
          sub.status = params[0];
        } else if (cleanSql.includes('PLAN_ID = ?')) {
          sub.plan_id = params[0];
        }

        if (cleanSql.includes('CANCEL_AT_PERIOD_END = ?')) {
          sub.cancel_at_period_end = Boolean(params[0]);
          if (sub.cancel_at_period_end) {
            sub.canceled_at = new Date().toISOString();
          }
        }

        if (cleanSql.includes('CURRENT_PERIOD_END = ?')) {
          sub.current_period_end = params[0];
        }

        sub.updated_at = new Date().toISOString();
        this.save();
      }
      return { rows: [] };
    }

    if (cleanSql.includes('UPDATE CLIENTS')) {
      const clientId = params[params.length - 1];
      const client = this.data.clients[clientId] || Object.values(this.data.clients || {}).find(c => c.id === clientId);
      if (client) {
        if (cleanSql.includes('CURRENT_VERSION = ?') && cleanSql.includes('LAST_SYNC_AT = ?')) {
          const [current_version, last_sync_at] = params;
          client.current_version = current_version;
          client.last_sync_at = last_sync_at;
        } else if (cleanSql.includes('LAST_SYNC_AT = ?')) {
          const [last_sync_at] = params;
          client.last_sync_at = last_sync_at;
        }
        if (cleanSql.includes("SYNC_STATUS = 'SYNCED'")) {
          client.sync_status = 'SYNCED';
        }
        client.updated_at = new Date().toISOString();
        this.save();
      }
      return { rows: [] };
    }

    if (cleanSql.includes('UPDATE CLIENT_WORKBOOKS')) {
      const clientId = params[params.length - 1];
      const wb = this.data.client_workbooks[clientId] || Object.values(this.data.client_workbooks || {}).find(w => w.client_id === clientId || w.id === clientId);
      if (wb) {
        if (params.length >= 2) {
          wb.current_version = params[0];
          wb.updated_at = params[1] || new Date().toISOString();
        }
        this.save();
      }
      return { rows: [] };
    }

    return { rows: [] };
  }

  async getOne(sql, params = []) {
    const res = await this.query(sql, params);
    return res.rows && res.rows.length > 0 ? res.rows[0] : null;
  }

  async getAll(sql, params = []) {
    const res = await this.query(sql, params);
    return res.rows || [];
  }
}

class PostgresDatabaseAdapter {
  constructor() {
    this.pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL
    });
    this.initSchema();
  }

  async initSchema() {
    try {
      const schemaPath = path.join(__dirname, 'schema.sql');
      if (fs.existsSync(schemaPath)) {
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');
        await this.pool.query(schemaSql);
        console.log('PostgreSQL Schema initialized successfully.');
      }
    } catch (err) {
      console.error('Warning initializing PostgreSQL schema:', err.message);
    }
  }

  async query(sql, params = []) {
    let paramCount = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++paramCount}`);
    const res = await this.pool.query(pgSql, params);
    return res;
  }

  async getOne(sql, params = []) {
    const res = await this.query(sql, params);
    return res.rows && res.rows.length > 0 ? res.rows[0] : null;
  }

  async getAll(sql, params = []) {
    const res = await this.query(sql, params);
    return res.rows || [];
  }
}

const isPgMode = process.env.USE_SQLITE_DEV === 'false' && pg;

if (isPgMode) {
  console.log('Connecting to PostgreSQL Database:', process.env.DATABASE_URL);
}

module.exports = isPgMode ? new PostgresDatabaseAdapter() : new MemoryDatabaseAdapter();