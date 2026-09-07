const fs = require('fs');
const path = require('path');

const storePath = path.join(__dirname, '../src/db/portal_db_store.json');
const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));

console.log('--- BEFORE CLEANUP ---');
console.log('Clients count:', Object.keys(data.clients || {}).length);
console.log('Users count:', Object.keys(data.users || {}).length);

// Keep only legitimate VNC master client and real VNC team members
const validClientIds = new Set(['client-vnc-master']);

const cleanedClients = {};
for (const [id, c] of Object.entries(data.clients || {})) {
  if (id === 'client-vnc-master') {
    c.company_name = 'VNC Global Business Edge';
    cleanedClients[id] = c;
  }
}
data.clients = cleanedClients;

const cleanedUsers = {};
const validUserEmails = new Set([
  'harshili.patni@vnc.global',
  'superadmin@vnc.global',
  'manager@vnc.global',
  'viewer@vnc.global'
]);

for (const [id, u] of Object.entries(data.users || {})) {
  if (u.email && validUserEmails.has(u.email.toLowerCase())) {
    u.client_id = 'client-vnc-master';
    cleanedUsers[id] = u;
  }
}
data.users = cleanedUsers;

// Clean cin7_connections
const cleanedCin7 = {};
for (const [id, conn] of Object.entries(data.cin7_connections || {})) {
  if (conn.client_id === 'client-vnc-master') {
    cleanedCin7[id] = conn;
  }
}
data.cin7_connections = cleanedCin7;

// Clean destination_files
const cleanedDest = {};
for (const [id, df] of Object.entries(data.destination_files || {})) {
  if (df.client_id === 'client-vnc-master') {
    cleanedDest[id] = df;
  }
}
data.destination_files = cleanedDest;

// Clean subscriptions
const cleanedSubs = {};
for (const [id, sub] of Object.entries(data.subscriptions || {})) {
  if (sub.organization_id === 'client-vnc-master') {
    cleanedSubs[id] = sub;
  }
}
data.subscriptions = cleanedSubs;

// Clean sync_runs
const cleanedSyncRuns = {};
for (const [id, run] of Object.entries(data.sync_runs || {})) {
  if (run.client_id === 'client-vnc-master') {
    cleanedSyncRuns[id] = run;
  }
}
data.sync_runs = cleanedSyncRuns;

// Clean workbooks
const cleanedWorkbooks = {};
for (const [id, wb] of Object.entries(data.client_workbooks || {})) {
  if (wb.client_id === 'client-vnc-master') {
    cleanedWorkbooks[id] = wb;
  }
}
data.client_workbooks = cleanedWorkbooks;

// Save cleaned data
fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf8');

console.log('\n--- AFTER CLEANUP ---');
console.log('Clients count:', Object.keys(data.clients).length);
console.log('Clients:', Object.values(data.clients).map(c => ({ id: c.id, name: c.company_name })));
console.log('Users count:', Object.keys(data.users).length);
console.log('Users:', Object.values(data.users).map(u => ({ id: u.id, email: u.email, name: u.full_name })));
