'use strict';

const { dashboardPool, goclawPool } = require('../db');

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
    return { synced: 0, skipped: 0, spans: 0 };
  }

  try {
    // Get last sync timestamp from audit log
    const lastSyncRes = await dashboardPool.query(`
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

    if (traces.length === 0) return { synced: 0, skipped: 0, spans: 0 };

    // Build sender_id → AITM user_id map
    const senderIds = [...new Set(traces.map(t => t.goclaw_sender_id))];
    const mappingRes = await dashboardPool.query(`
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
    let spansSynced = 0;

    // Load service pricing for auto-cost calculation
    const { rows: pricingRows } = await dashboardPool.query(`
      SELECT service_name, cost_per_hit, pricing_type, cost_currency FROM llm_service_registry WHERE is_active = true
    `);
    const pricingMap = {};
    for (const p of pricingRows) pricingMap[p.service_name] = p;

    // Collect all trace IDs that have mapped users for span sync
    const traceIdsForSpans = [];

    for (const trace of traces) {
      const userId = senderToUser[trace.goclaw_sender_id];
      if (!userId) { skipped++; continue; } // No mapping — skip

      // Map GoClaw status to our status
      const status = trace.status === 'completed' ? 'SUCCESS'
                   : trace.status === 'error'     ? 'FAILED'
                   : 'SUCCESS';

      try {
        await dashboardPool.query(`
          INSERT INTO llm_usage_events (
            id, user_id, source_service, feature_name, workflow_name,
            execution_id, prompt_tokens, completion_tokens, total_tokens,
            cost_amount, status, latency_ms, quota_source, metadata_json, created_at
          ) VALUES (
            gen_random_uuid(), $1, 'GOCLAW', 'goclaw_trace', $2,
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
        traceIdsForSpans.push({ traceId: trace.execution_id, userId, createdAt: trace.created_at });
      } catch (err) {
        if (!err.message.includes('unique')) {
          console.error('[Sync] Insert error:', err.message);
        }
        skipped++;
      }
    }

    // ── Sync individual spans (tool_call + llm_call) for mapped traces ──
    if (traceIdsForSpans.length > 0) {
      const traceIdList = traceIdsForSpans.map(t => t.traceId);
      const traceUserMap = {};
      for (const t of traceIdsForSpans) traceUserMap[t.traceId] = t.userId;

      const { rows: spans } = await goclawClient.query(`
        SELECT
          s.id::text AS span_id,
          s.trace_id::text AS trace_id,
          s.span_type,
          s.name AS span_name,
          s.tool_name,
          s.model,
          s.provider,
          s.input_tokens,
          s.output_tokens,
          COALESCE(s.input_tokens, 0) + COALESCE(s.output_tokens, 0) AS total_tokens,
          s.total_cost,
          s.duration_ms,
          s.status,
          s.input_preview,
          s.output_preview,
          s.created_at
        FROM spans s
        WHERE s.trace_id::text = ANY($1)
          AND s.span_type IN ('tool_call', 'llm_call')
        ORDER BY s.created_at ASC
      `, [traceIdList]);

      for (const span of spans) {
        const userId = traceUserMap[span.trace_id];
        if (!userId) continue;

        // Determine feature_name based on span type
        const featureName = span.span_type === 'tool_call'
          ? (span.tool_name || span.span_name || 'unknown_tool')
          : 'llm_call';

        const spanStatus = span.status === 'completed' || span.status === 'ok' ? 'SUCCESS'
                         : span.status === 'error' ? 'FAILED'
                         : 'SUCCESS';

        // Use span_id as request_id for idempotency
        try {
          await dashboardPool.query(`
            INSERT INTO llm_usage_events (
              id, user_id, source_service, feature_name, workflow_name,
              execution_id, request_id, model_name, provider_name,
              prompt_tokens, completion_tokens, total_tokens,
              cost_amount, cost_currency, status, latency_ms, quota_source, metadata_json, created_at
            ) VALUES (
              gen_random_uuid(), $1, 'GOCLAW', $2, $3,
              $4, $5, $6, $7,
              $8, $9, $10,
              $11, $12, $13, $14, 'NONE', $15, $16
            )
            ON CONFLICT (request_id) DO NOTHING
          `, [
            userId,
            featureName,
            span.span_type,
            span.trace_id,          // execution_id = parent trace
            `span:${span.span_id}`, // request_id for dedup
            span.model || null,
            span.provider || null,
            span.input_tokens || 0,
            span.output_tokens || 0,
            span.total_tokens || 0,
            (() => {
              const pricing = pricingMap[featureName];
              if (!pricing) return parseFloat(span.total_cost || 0);
              if (pricing.pricing_type === 'per_1k_tokens') return ((span.total_tokens || 0) / 1000.0) * parseFloat(pricing.cost_per_hit);
              return parseFloat(pricing.cost_per_hit);
            })(),
            pricingMap[featureName] ? pricingMap[featureName].cost_currency : 'IDR',
            spanStatus,
            span.duration_ms || 0,
            JSON.stringify({
              spanType: span.span_type,
              spanName: span.span_name,
              toolName: span.tool_name,
              inputPreview: span.input_preview?.slice(0, 200),
              outputPreview: span.output_preview?.slice(0, 200),
            }),
            span.created_at,
          ]);
          spansSynced++;
        } catch (err) {
          if (!err.message.includes('unique')) {
            console.error('[Sync] Span insert error:', err.message);
          }
        }
      }
    }

    console.log(`[Sync] GoClaw traces synced: ${synced} new, ${skipped} skipped, ${spansSynced} spans`);
    return { synced, skipped, spans: spansSynced };
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

  const { rows } = await dashboardPool.query(`
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
    await dashboardPool.query(`
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
