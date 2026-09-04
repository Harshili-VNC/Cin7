const cin7Engine = require('../src/services/cin7Engine');
const snapshotService = require('../src/services/snapshotService');
const { v4: uuidv4 } = require('uuid');

async function seed() {
  const clientId = 'client-vnc-master';
  console.log(`Fetching and seeding initial current reports for ${clientId}...`);

  const runId = `seed-${uuidv4().substring(0, 8)}`;
  const [salesData, invData, poData] = await Promise.all([
    cin7Engine.fetchSales(clientId),
    cin7Engine.fetchInventory(clientId),
    cin7Engine.fetchPurchaseOrders(clientId)
  ]);

  console.log(`Fetched Sales (${salesData.rows.length}), Inventory (${invData.rows.length}), POs (${poData.rows.length})`);

  await Promise.all([
    snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'sales', periodLabel: 'Last 365 Days', dataset: salesData, syncRunId: runId }),
    snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'inventory', periodLabel: 'Current Stock', dataset: invData, syncRunId: runId }),
    snapshotService.saveCurrentAndSnapshot({ clientId, reportType: 'purchase', periodLabel: 'Last 365 Days', dataset: poData, syncRunId: runId })
  ]);

  console.log('✅ Initial current reports & snapshots seeded successfully for client-vnc-master.');
}

seed().catch(console.error);
