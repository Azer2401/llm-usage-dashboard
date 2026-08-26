/**
 * Script to migrate all llm_* table data from n8n_db (port 5432) to llm_dashboard_db (port 5434).
 */
const { Client } = require('pg');

const sourceConfig = {
  host: '127.0.0.1',
  port: 5432,
  user: 'n8n_user',
  password: 'n8ndevops',
  database: 'n8n_db',
  connectionTimeoutMillis: 5000,
};

const targetConfig = {
  host: '127.0.0.1',
  port: 5434,
  user: 'llm_user',
  password: 'llmdevops2026',
  database: 'llm_dashboard_db',
  connectionTimeoutMillis: 5000,
};

const tablesToMigrate = [
  'llm_companies',
  'llm_token_plans',
  'llm_service_registry',
  'llm_plan_services',
  'llm_user_mappings',
  'llm_plan_assignments',
  'llm_quota_bundles',
  'llm_usage_events',
  'llm_usage_daily_aggregates',
  'llm_internal_service_keys',
  'llm_audit_logs',
];

async function migrateData() {
  console.log('=== Starting LLM Dashboard Data Migration ===\n');

  const source = new Client(sourceConfig);
  const target = new Client(targetConfig);

  await source.connect();
  await target.connect();

  try {
    for (const table of tablesToMigrate) {
      // 1. Fetch rows from source
      const res = await source.query(`SELECT * FROM ${table}`);
      const rows = res.rows;
      console.log(`Copying ${rows.length} rows for table ${table}...`);

      if (rows.length === 0) continue;

      // 2. Insert into target
      const columns = Object.keys(rows[0]);
      const colNames = columns.map(c => `"${c}"`).join(', ');

      for (const row of rows) {
        const values = columns.map(c => row[c]);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

        const insertQuery = `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
        await target.query(insertQuery, values);
      }
    }

    console.log('\n=== Data Migration Summary & Verification ===');
    for (const table of tablesToMigrate) {
      const srcCountRes = await source.query(`SELECT count(*) FROM ${table}`);
      const tgtCountRes = await target.query(`SELECT count(*) FROM ${table}`);
      const srcCount = srcCountRes.rows[0].count;
      const tgtCount = tgtCountRes.rows[0].count;
      const match = srcCount === tgtCount ? '✅ MATCH' : '❌ MISMATCH';
      console.log(`${table.padEnd(30)} Source: ${srcCount.padStart(4)} | Target: ${tgtCount.padStart(4)} ${match}`);
    }

    console.log('\n✅ Migration finished successfully!');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await source.end();
    await target.end();
  }
}

migrateData();
