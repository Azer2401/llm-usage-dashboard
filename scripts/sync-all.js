'use strict';

const { goclawPool, aitmPool, dashboardPool } = require('../src/db');

async function test() {
  const { rows: traces } = await goclawPool.query(`
    SELECT
      id::text AS execution_id,
      user_id AS goclaw_sender_id,
      agent_id,
      channel,
      total_input_tokens,
      total_output_tokens,
      created_at,
      input_preview
    FROM traces
    WHERE parent_trace_id IS NULL
    ORDER BY created_at DESC
  `);
  console.log(`Found ${traces.length} total parent traces in GoClaw`);

  // Distinct user_id in GoClaw
  const distinctSenders = [...new Set(traces.map(t => t.goclaw_sender_id))];
  console.log('Distinct sender IDs in GoClaw:', distinctSenders);

  // Check all users in AITM
  const { rows: aitmUsers } = await aitmPool.query(`
    SELECT u.id, u.name, u.email, ur.role_name
    FROM users u
    LEFT JOIN employees e ON e.user_id = u.id
    LEFT JOIN user_roles ur ON ur.id = e.user_role_id
  `);
  console.log(`Found ${aitmUsers.length} users in AITM`);

  // Existing mappings
  const { rows: mappings } = await dashboardPool.query(`SELECT * FROM llm_user_mappings`);
  console.log(`Found ${mappings.length} user mappings in Dashboard DB`);

  process.exit(0);
}

test().catch(e => { console.error(e); process.exit(1); });
