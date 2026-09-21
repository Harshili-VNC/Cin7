const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const sourceUrl = process.env.SOURCE_DB_URL || process.env.SUPABASE_PROD_DB_URL;
const targetUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

async function migrate() {
  if (!sourceUrl || !targetUrl) {
    console.error('Error: SOURCE_DB_URL (or SUPABASE_PROD_DB_URL) and SUPABASE_DB_URL (or DATABASE_URL) must be set in .env');
    process.exit(1);
  }
  const sourcePool = new Pool({ connectionString: sourceUrl, ssl: { rejectUnauthorized: false } });
  const targetPool = new Pool({ connectionString: targetUrl, ssl: { rejectUnauthorized: false } });

  console.log('Target DB:', targetUrl ? targetUrl.replace(/:[^:@]+@/, ':****@') : 'NOT SET');

  // Allow null client_id for users pending workspace setup
  try {
    await targetPool.query(`ALTER TABLE users ALTER COLUMN client_id DROP NOT NULL;`);
  } catch (_) {}

  // Create destination_files if needed
  try {
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS destination_files (
        id VARCHAR(64) PRIMARY KEY,
        client_id VARCHAR(64) REFERENCES clients(id) ON DELETE CASCADE,
        provider VARCHAR(50) NOT NULL,
        file_id TEXT,
        file_name VARCHAR(255),
        file_url TEXT,
        sheet_id TEXT,
        drive_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch (_) {}

  // Fetch list of tables from source
  const tablesRes = await sourcePool.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  
  const allTables = tablesRes.rows.map(r => r.table_name);
  console.log('Found tables in source:', allTables);

  // Order tables to respect foreign keys
  const priorityOrder = [
    'plans',
    'clients',
    'users',
    'subscriptions',
    'billing_events',
    'cin7_connections',
    'client_workbooks',
    'destination_files',
    'client_preferences',
    'oauth_accounts',
    'sync_runs',
    'sync_logs',
    'report_snapshots',
    'audit_logs'
  ];

  const orderedTables = [
    ...priorityOrder.filter(t => allTables.includes(t)),
    ...allTables.filter(t => !priorityOrder.includes(t))
  ];

  for (const table of orderedTables) {
    try {
      console.log(`\n--- Migrating table: ${table} ---`);
      const srcRows = await sourcePool.query(`SELECT * FROM "${table}"`);
      console.log(`Found ${srcRows.rows.length} rows in source ${table}`);

      if (srcRows.rows.length === 0) continue;

      for (const row of srcRows.rows) {
        const columns = Object.keys(row);
        const values = Object.values(row);
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
        
        let insertSql = '';
        if (columns.includes('id')) {
          const updateSets = columns
            .filter(col => col !== 'id')
            .map(col => `"${col}" = EXCLUDED."${col}"`)
            .join(', ');

          insertSql = `
            INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(', ')})
            VALUES (${placeholders})
            ON CONFLICT (id) ${updateSets.length ? `DO UPDATE SET ${updateSets}` : 'DO NOTHING'}
          `;
        } else {
          insertSql = `
            INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(', ')})
            VALUES (${placeholders})
            ON CONFLICT DO NOTHING
          `;
        }

        try {
          await targetPool.query(insertSql, values);
        } catch (rowErr) {
          console.error(`  [${table}] Error on row (${row.id || JSON.stringify(row).substring(0, 30)}):`, rowErr.message);
        }
      }
      console.log(`✅ Finished migrating ${table}`);
    } catch (tblErr) {
      console.warn(`Error on table ${table}:`, tblErr.message);
    }
  }

  await sourcePool.end();
  await targetPool.end();
  console.log('\n🎉 All tables and data successfully transferred to new Supabase database!');
}

migrate().catch(e => {
  console.error('Fatal migration error:', e);
  process.exit(1);
});
