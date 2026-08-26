'use strict';

/**
 * One-time backfill: Reads all existing GoClaw trace execution_ids from llm_usage_events,
 * then fetches their spans from the GoClaw DB and inserts them as additional usage events.
 */

const path = require('path');
const fs = require('fs');

// Load env
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
}

const { aitmPool, goclawPool } = require('../src/db');

async function backfillSpans() {
  let goclawClient;
  try {
    goclawClient = await goclawPool.connect();
  } catch (err) {
    console.error('Cannot connect to GoClaw DB:', err.message);
    process.exit(1);
  }

  try {
    // Get all trace-level events (goclaw_trace or goclaw_internal_workflow)
    const { rows: traceEvents } = await aitmPool.query(`
      SELECT DISTINCT execution_id, user_id
      FROM llm_usage_events
      WHERE source_service = 'GOCLAW'
        AND feature_name IN ('goclaw_trace', 'goclaw_internal_workflow')
        AND execution_id IS NOT NULL
    `);

    console.log(`Found ${traceEvents.length} trace events to backfill spans for`);

    const traceIds = traceEvents.map(t => t.execution_id);
    const traceUserMap = {};
    for (const t of traceEvents) traceUserMap[t.execution_id] = t.user_id;

    // Get all spans for these traces
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
    `, [traceIds]);

    console.log(`Found ${spans.length} spans to sync`);

    let inserted = 0;
    let skipped = 0;

    for (const span of spans) {
      const userId = traceUserMap[span.trace_id];
      if (!userId) { skipped++; continue; }

      const featureName = span.span_type === 'tool_call'
        ? (span.tool_name || span.span_name || 'unknown_tool')
        : 'llm_call';

      const spanStatus = span.status === 'completed' || span.status === 'ok' ? 'SUCCESS'
                       : span.status === 'error' ? 'FAILED'
                       : 'SUCCESS';

      try {
        await aitmPool.query(`
          INSERT INTO llm_usage_events (
            id, user_id, source_service, feature_name, workflow_name,
            execution_id, request_id, model_name, provider_name,
            prompt_tokens, completion_tokens, total_tokens,
            cost_amount, status, latency_ms, quota_source, metadata_json, created_at
          ) VALUES (
            gen_random_uuid(), $1, 'GOCLAW', $2, $3,
            $4, $5, $6, $7,
            $8, $9, $10,
            $11, $12, $13, 'NONE', $14, $15
          )
          ON CONFLICT (request_id) DO NOTHING
        `, [
          userId,
          featureName,
          span.span_type,
          span.trace_id,
          `span:${span.span_id}`,
          span.model || null,
          span.provider || null,
          span.input_tokens || 0,
          span.output_tokens || 0,
          span.total_tokens || 0,
          parseFloat(span.total_cost || 0),
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
        inserted++;
      } catch (err) {
        if (!err.message.includes('unique')) {
          console.error('Insert error:', err.message);
        }
        skipped++;
      }
    }

    console.log(`Backfill complete: ${inserted} inserted, ${skipped} skipped`);
  } finally {
    goclawClient.release();
    await aitmPool.end();
    await goclawPool.end();
  }
}

backfillSpans().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
