'use strict';

const { aitmPool, goclawPool } = require('../db');

// ─── GoClaw Traces → llm_usage_events Sync ───────────────────────────────────
/**
 * Reads new GoClaw traces (since last sync) and inserts them as llm_usage_events.
 * Resolves GoClaw sender_id → AITM user_id via llm_user_mappings.
 * Skips traces already imported (uses execution_id for idempotency).
 */
async function syncGoclawTraces() {
  let goclawClient;
  try {
    goclawClient = await goclawPool.connect();
  } catch (err) {
    console.warn('[Sync] GoClaw DB not available — skipping sync:', err.message);
    return { synced: 0, skipped: 0 };
  }

  try {
    // Get last sync timestamp from audit log
    const lastSyncRes = await aitmPool.query(`
      SELECT MAX(created_at) AS last_sync
      FROM llm_usage_events
      WHERE source_service = 'GOCLAW'
    `);
    const lastSync = lastSyncRes.rows[0].last_sync || new Date('2020-01-01');

    // Read new traces from GoClaw
    const { rows: traces } = await goclawClient.query(`
      SELECT
        t.id::text AS execution_id,
        t.user_id AS goclaw_sender_id,
        t.agent_id,
        t.channel,
        t.total_input_tokens  AS prompt_tokens,
        t.total_output_tokens AS completion_tokens,
        (t.total_input_tokens + t.total_output_tokens) AS total_tokens,
        t.status,
        t.duration_ms AS latency_ms,
        t.created_at,
        t.input_preview
      FROM traces t
      WHERE t.parent_trace_id IS NULL
        AND t.user_id IS NOT NULL
        AND t.created_at > $1
      ORDER BY t.created_at ASC
      LIMIT 500
    `, [lastSync]);

    if (traces.length === 0) return { synced: 0, skipped: 0 };

    // Build sender_id → AITM user_id map
    const senderIds = [...new Set(traces.map(t => t.goclaw_sender_id))];
    const mappingRes = await aitmPool.query(`
      SELECT goclaw_sender_id, user_id
      FROM llm_user_mappings
      WHERE goclaw_sender_id = ANY($1)
    `, [senderIds]);
    const senderToUser = {};
    for (const m of mappingRes.rows) {
      senderToUser[m.goclaw_sender_id] = m.user_id;
    }

    let synced = 0;
    let skipped = 0;

    for (const trace of traces) {
      const userId = senderToUser[trace.goclaw_sender_id];
      if (!userId) { skipped++; continue; } // No mapping — skip

      // Map GoClaw status to our status
      const status = trace.status === 'completed' ? 'SUCCESS'
                   : trace.status === 'error'     ? 'FAILED'
                   : 'SUCCESS';

      try {
        await aitmPool.query(`
          INSERT INTO llm_usage_events (
            id, user_id, source_service, feature_name, workflow_name,
            execution_id, prompt_tokens, completion_tokens, total_tokens,
            cost_amount, status, latency_ms, quota_source, metadata_json, created_at
          ) VALUES (
            gen_random_uuid(), $1, 'GOCLAW', 'goclaw_internal_workflow', $2,
            $3, $4, $5, $6,
            0, $7, $8, 'RECURRING', $9, $10
          )
          ON CONFLICT (request_id) DO NOTHING
        `, [
          userId,
          trace.agent_id || 'goclaw-agent',
          trace.execution_id,
          trace.prompt_tokens || 0,
          trace.completion_tokens || 0,
          trace.total_tokens || 0,
          status,
          trace.latency_ms || 0,
          JSON.stringify({ goclawSenderId: trace.goclaw_sender_id, channel: trace.channel, preview: trace.input_preview?.slice(0, 200) }),
          trace.created_at,
        ]);
        synced++;
      } catch (err) {
        if (!err.message.includes('unique')) {
          console.error('[Sync] Insert error:', err.message);
        }
        skipped++;
      }
    }

    console.log(`[Sync] GoClaw traces synced: ${synced} new, ${skipped} skipped`);
    return { synced, skipped };
  } finally {
    goclawClient.release();
  }
}

// ─── Daily Aggregate Computation ─────────────────────────────────────────────
async function computeDailyAggregates(date) {
  const targetDate = date || new Date();
  targetDate.setHours(0, 0, 0, 0);
  const nextDate = new Date(targetDate);
  nextDate.setDate(nextDate.getDate() + 1);

  const { rows } = await aitmPool.query(`
    SELECT
      user_id,
      source_service,
      feature_name,
      SUM(total_tokens)   AS total_tokens,
      SUM(cost_amount)    AS total_cost,
      COUNT(*) FILTER (WHERE status = 'SUCCESS')  AS success_count,
      COUNT(*) FILTER (WHERE status = 'FAILED')   AS failed_count,
      COUNT(*) FILTER (WHERE status = 'REJECTED') AS rejected_count
    FROM llm_usage_events
    WHERE created_at >= $1 AND created_at < $2
    GROUP BY user_id, source_service, feature_name
  `, [targetDate, nextDate]);

  for (const row of rows) {
    await aitmPool.query(`
      INSERT INTO llm_usage_daily_aggregates
        (id, user_id, date, source_service, feature_name, total_tokens, total_cost,
         success_count, failed_count, rejected_count)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (user_id, date, source_service, feature_name)
      DO UPDATE SET
        total_tokens  = EXCLUDED.total_tokens,
        total_cost    = EXCLUDED.total_cost,
        success_count = EXCLUDED.success_count,
        failed_count  = EXCLUDED.failed_count,
        rejected_count= EXCLUDED.rejected_count
    `, [
      row.user_id, targetDate, row.source_service, row.feature_name || '',
      row.total_tokens, row.total_cost,
      row.success_count, row.failed_count, row.rejected_count,
    ]);
  }

  console.log(`[Aggregator] Daily aggregates computed for ${targetDate.toISOString().slice(0, 10)}: ${rows.length} groups`);
  return rows.length;
}

module.exports = { syncGoclawTraces, computeDailyAggregates };
