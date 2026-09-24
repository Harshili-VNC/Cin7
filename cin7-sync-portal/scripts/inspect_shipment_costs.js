const db = require('../src/db');

async function inspectFulfillments() {
  const { rows: r1 } = await db.queryWithTenant('SELECT detail_json FROM cin7_order_cache', [], 'client-dbb196ec');
  const { rows: r2 } = await db.queryWithTenant('SELECT detail_json FROM cin7_order_cache', [], 'client-039ede71');
  const rows = [...r1, ...r2];
  
  console.log(`Loaded ${rows.length} orders from cache.`);

  let targetOrder = null;
  const samples = [];
  
  for (const r of rows) {
    const detail = JSON.parse(r.detail_json);
    const sale = detail.Order || {};
    const orderNo = sale.OrderNumber || sale.SaleOrderNumber;
    
    // Normalize Fulfilments
    if (detail.Fulfilments) detail.Fulfillments = detail.Fulfilments;
    
    if (orderNo === 'SO-41557' || r.detail_json.includes('SO-41557')) {
       targetOrder = detail;
    }
    
    if (samples.length < 20) {
      if (detail.InventoryMovements && detail.InventoryMovements.length > 0) {
        samples.push(detail);
      } else if (detail.Fulfillments && detail.Fulfillments.length > 0) {
        samples.push(detail);
      }
    }
  }

  if (targetOrder && !samples.includes(targetOrder)) {
    samples.unshift(targetOrder);
  }

  console.log(`\n=== INSPECTING ${samples.length} ORDERS ===\n`);

  for (const detail of samples) {
    const orderNo = (detail.Order || {}).OrderNumber || (detail.Order || {}).SaleOrderNumber || detail.ID;
    console.log(`\n--- Order: ${orderNo} ---`);
    
    const avgCostMap = new Map();
    if (detail.Invoices) {
       for (const inv of detail.Invoices) {
         if (inv.Lines) {
           for (const l of inv.Lines) {
             const sku = l.SKU || l.ProductID;
             if (sku) {
               avgCostMap.set(sku, {
                 AverageCost: l.AverageCost,
                 Price: l.Price,
                 Total: l.Total,
                 ProductID: l.ProductID
               });
             }
           }
         }
       }
    }

    console.log(`InventoryMovements: ${detail.InventoryMovements ? detail.InventoryMovements.length : 0} items`);
    if (detail.InventoryMovements && detail.InventoryMovements.length > 0) {
       const sum = detail.InventoryMovements.reduce((acc, m) => acc + (m.COGS || 0), 0);
       console.log(`  Total IM COGS: ${sum}`);
    }

    if (!detail.Fulfillments) {
      console.log('No Fulfilments array.');
      continue;
    }

    for (let f = 0; f < detail.Fulfillments.length; f++) {
      const ful = detail.Fulfillments[f];
      if (!ful.Shipments || ful.Shipments.length === 0) continue;
      
      for (let s = 0; s < ful.Shipments.length; s++) {
        const ship = ful.Shipments[s];
        console.log(`Shipment ${s}: Status=${ship.Status}, Date=${ship.ShipmentDate}`);
        if (!ship.Lines) continue;
        
        for (let l = 0; l < ship.Lines.length; l++) {
          const line = ship.Lines[l];
          const sku = line.SKU || line.ProductID;
          const qty = line.Quantity || line.ShipmentQuantity || 0;
          
          const keys = Object.keys(line);
          const costKeys = keys.filter(k => k.toLowerCase().includes('cost') || k.toLowerCase().includes('cogs') || k.toLowerCase().includes('total') || k.toLowerCase().includes('price') || k.toLowerCase().includes('amount') || k.toLowerCase().includes('value') || k.toLowerCase().includes('batch'));
          
          const costVals = costKeys.map(k => `${k}=${line[k]}`).join(', ');
          console.log(`  Line ${l}: SKU=${sku} Qty=${qty}`);
          console.log(`    Cost Fields: ${costVals || 'NONE'}`);
          
          const invInfo = avgCostMap.get(sku) || {};
          console.log(`    Invoice AvgCost: ${invInfo.AverageCost}, Invoice Total: ${invInfo.Total}`);
        }
      }
    }
  }
}

inspectFulfillments().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
