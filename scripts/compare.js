const { Client } = require('pg');

async function main() {
  const s = new Client({ host: '127.0.0.1', port: 5432, user: 'n8n_user', password: 'n8ndevops', database: 'n8n_db' });
  const t = new Client({ host: '127.0.0.1', port: 5434, user: 'llm_user', password: 'llmdevops2026', database: 'llm_dashboard_db' });

  await s.connect();
  await t.connect();

  const tables = [
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

  for (const tbl of tables) {
    const resS = await s.query(`SELECT column_name FROM information_schema.columns WHERE table_name='${tbl}'`);
    const resT = await t.query(`SELECT column_name FROM information_schema.columns WHERE table_name='${tbl}'`);

    const colsS = resS.rows.map(r => r.column_name);
    const colsT = resT.rows.map(r => r.column_name);

    const diff = colsS.filter(c => !colsT.includes(c));
    if (diff.length > 0) {
      console.log(`Table ${tbl} missing in target:`, diff);
    } else {
      console.log(`Table ${tbl} OK`);
    }
  }

  await s.end();
  await t.end();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
