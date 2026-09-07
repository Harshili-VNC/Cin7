const fs = require('fs');
const path = require('path');

const storePath = path.join(__dirname, '../src/db/portal_db_store.json');
const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));

console.log('====================================================');
console.log('PURGING ALL DUMMY DATA ACROSS THE ADMIN PORTAL');
console.log('====================================================');

// 1. Clients: Retain only real master organization
const MASTER_CLIENT_ID = 'client-vnc-master';
const cleanedClients = {};
if (data.clients && data.clients[MASTER_CLIENT_ID]) {
  const c = data.clients[MASTER_CLIENT_ID];
  c.company_name = 'VNC Global Business Edge';
  c.status = 'ACTIVE';
  c.subscription_status = 'ACTIVE';
  cleanedClients[MASTER_CLIENT_ID] = c;
} else {
  cleanedClients[MASTER_CLIENT_ID] = {
    id: MASTER_CLIENT_ID,
    company_name: 'VNC Global Business Edge',
    phone_number: null,
    status: 'ACTIVE',
    onboarding_status: 'completed',
    subscription_status: 'ACTIVE',
    current_version: 'v5.0',
    sync_status: 'IDLE',
    last_sync_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    timezone: 'Asia/Kolkata',
    sync_schedule_json: JSON.stringify({ daily_sync: true, schedule_time: '03:30', timezone: 'Asia/Kolkata', incremental_sync: true }),
    notifications_config_json: JSON.stringify({ email_daily_summary: true, email_sync_completed: true, email_sync_failed: true, email_critical_errors: true, email_weekly_reports: false, slack_status: 'Not Connected', teams_status: 'Not Connected' })
  };
}
data.clients = cleanedClients;

// 2. Users: Retain only Admin and Super Admin
const ALLOWED_EMAILS = new Set([
  'harshili.patni@vnc.global',
  'superadmin@vnc.global'
]);
const cleanedUsers = {};
for (const [id, u] of Object.entries(data.users || {})) {
  if (u.email && ALLOWED_EMAILS.has(u.email.toLowerCase())) {
    u.client_id = MASTER_CLIENT_ID;
    cleanedUsers[id] = u;
  }
}
data.users = cleanedUsers;

// 3. Subscriptions: Retain only master subscription
const cleanedSubs = {};
if (data.subscriptions && data.subscriptions[MASTER_CLIENT_ID]) {
  cleanedSubs[MASTER_CLIENT_ID] = data.subscriptions[MASTER_CLIENT_ID];
} else {
  cleanedSubs[MASTER_CLIENT_ID] = {
    id: 'sub-vnc-master',
    organization_id: MASTER_CLIENT_ID,
    plan_id: 'plan-professional',
    billing_provider: 'neutral',
    external_customer_id: null,
    external_subscription_id: null,
    external_price_id: null,
    status: 'ACTIVE',
    current_period_start: new Date().toISOString(),
    current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    trial_start: null,
    trial_end: null,
    cancel_at_period_end: false,
    canceled_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}
data.subscriptions = cleanedSubs;

// 4. Cin7 Connections: Retain only master connection
const cleanedCin7 = {};
if (data.cin7_connections && data.cin7_connections[MASTER_CLIENT_ID]) {
  cleanedCin7[MASTER_CLIENT_ID] = data.cin7_connections[MASTER_CLIENT_ID];
} else {
  // Find any cin7 connection for client-vnc-master
  for (const [id, conn] of Object.entries(data.cin7_connections || {})) {
    if (conn.client_id === MASTER_CLIENT_ID) {
      cleanedCin7[MASTER_CLIENT_ID] = conn;
      break;
    }
  }
}
data.cin7_connections = cleanedCin7;

// 5. Destination Files (Google Sheets)
const cleanedDest = {};
for (const [id, df] of Object.entries(data.destination_files || {})) {
  if (df.client_id === MASTER_CLIENT_ID) {
    cleanedDest[id] = df;
  }
}
data.destination_files = cleanedDest;

// 6. OAuth Accounts: Clear out all dummy test oauth tokens
data.oauth_accounts = {};

// 7. Client Preferences
const cleanedPrefs = {};
if (data.client_preferences && data.client_preferences[MASTER_CLIENT_ID]) {
  cleanedPrefs[MASTER_CLIENT_ID] = data.client_preferences[MASTER_CLIENT_ID];
}
data.client_preferences = cleanedPrefs;

// 8. Client Workbooks
const cleanedWb = {};
for (const [id, wb] of Object.entries(data.client_workbooks || {})) {
  if (wb.client_id === MASTER_CLIENT_ID) {
    cleanedWb[id] = wb;
  }
}
data.client_workbooks = cleanedWb;

// 9. Sync Runs: Keep only valid sync runs for client-vnc-master
const cleanedSyncRuns = {};
for (const [id, run] of Object.entries(data.sync_runs || {})) {
  if (run.client_id === MASTER_CLIENT_ID) {
    cleanedSyncRuns[id] = run;
  }
}
data.sync_runs = cleanedSyncRuns;

// 10. Sync Logs
data.sync_logs = (data.sync_logs || []).filter(l => l.client_id === MASTER_CLIENT_ID);

// 11. Report Snapshots: Keep only valid snapshots for client-vnc-master
const cleanedSnapshots = {};
for (const [id, snap] of Object.entries(data.report_snapshots || {})) {
  if (snap.client_id === MASTER_CLIENT_ID) {
    cleanedSnapshots[id] = snap;
  }
}
data.report_snapshots = cleanedSnapshots;

// 12. Audit Logs: Retain clean system start audit log
data.audit_logs = [
  {
    id: `audit-${Date.now()}`,
    organization_id: MASTER_CLIENT_ID,
    user_id: 'user-superadmin',
    action: 'SYSTEM_INITIALIZED',
    resource: 'platform',
    result: 'SUCCESS',
    details_json: JSON.stringify({ message: 'Clean SaaS platform state initialized' }),
    created_at: new Date().toISOString()
  }
];

// 13. Billing Events: Clear dummy billing events
data.billing_events = [];

// Save cleaned database store
fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf8');

console.log('✅ Clean database successfully written to portal_db_store.json');
console.log('Clients:', Object.keys(data.clients));
console.log('Users:', Object.values(data.users).map(u => ({ email: u.email, role: u.role, platform_role: u.platform_role })));
console.log('Subscriptions:', Object.keys(data.subscriptions));
console.log('Cin7 Connections:', Object.keys(data.cin7_connections));
console.log('Sync Runs:', Object.keys(data.sync_runs).length);
console.log('Snapshots:', Object.keys(data.report_snapshots).length);
console.log('Audit Logs:', data.audit_logs.length);
console.log('====================================================');
