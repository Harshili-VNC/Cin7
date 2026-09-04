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
      report_snapshots: {}
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

        // Backfill new fields for existing client records
        Object.values(this.data.clients || {}).forEach(c => {
          if (!c.subscription_status) c.subscription_status = 'ACTIVE';
          if (!c.current_version) c.current_version = 'v1.0';
          if (!c.sync_status) c.sync_status = 'IDLE';
          if (!c.last_sync_at) c.last_sync_at = null;
        });
      } catch (err) {}
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
      else return { rows: [{ test: 1 }] };

      const rows = collection.filter(item => {
        if (cleanSql.includes('WHERE ID = ? AND CLIENT_ID = ?') || cleanSql.includes('WHERE (ID = ? OR RUN_ID = ?) AND CLIENT_ID = ?')) {
          const runIdMatch = (item.id === params[0] || item.run_id === params[0] || (params.length === 3 && (item.id === params[1] || item.run_id === params[1])));
          const tenantMatch = item.client_id === (params.length === 3 ? params[2] : params[1]);
          return runIdMatch && tenantMatch;
        }

        if (cleanSql.includes('WHERE CLIENT_ID = ? AND ID = ?')) {
          return item.client_id === params[0] && (item.id === params[1] || item.run_id === params[1]);
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
          if (params[0] && item.email !== params[0]) return false;
        }

        if (cleanSql.includes('WHERE ID = ?') && !cleanSql.includes('CLIENT_ID = ?')) {
          if (params[0] && item.id !== params[0] && item.run_id !== params[0]) return false;
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

      if (cleanSql.includes('ORDER BY') && (cleanSql.includes('DESC') || cleanSql.includes('STARTED_AT') || cleanSql.includes('CREATED_AT'))) {
        rows.sort((a, b) => new Date(b.started_at || b.created_at || 0) - new Date(a.started_at || a.created_at || 0));
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
      const [id, client_id, full_name, email, phone_number, password_hash, role, auth_provider, onboarding_status] = params;
      const record = {
        id,
        client_id,
        full_name,
        email,
        phone_number: phone_number || null,
        password_hash,
        role: role || 'CLIENT',
        auth_provider: auth_provider || 'local',
        onboarding_status: onboarding_status || 'completed',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      this.data.users[id] = record;
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

    // UPDATE
    if (cleanSql.includes('UPDATE CLIENTS')) {
      const clientId = params[params.length - 1];
      const client = this.data.clients[clientId];
      if (client) {
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
      const clientId = params[params.length - 1];
      Object.values(this.data.users).forEach(u => {
        if (u.client_id === clientId || u.id === clientId) {
          u.onboarding_status = 'completed';
          u.onboarding_completed_at = new Date().toISOString();
        }
      });
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
      const targetId = params[params.length - 1];
      const runRecord = this.data.sync_runs[targetId] || Object.values(this.data.sync_runs).find(r => r.run_id === targetId || r.id === targetId);

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

    return { rows: [] };
  }

  async getOne(sql, params = []) {
    const res = await this.query(sql, params);
    return res.rows && res.rows.length > 0 ? res.rows[0] : null;
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
}

const isPgMode = process.env.USE_SQLITE_DEV === 'false' && pg;

if (isPgMode) {
  console.log('Connecting to PostgreSQL Database:', process.env.DATABASE_URL);
}

module.exports = isPgMode ? new PostgresDatabaseAdapter() : new MemoryDatabaseAdapter();