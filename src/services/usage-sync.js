'use strict';

const { dashboardPool, goclawPool, aitmPool } = require('../db');

// Helper to resolve any GoClaw sender ID / user ID to an AITM user_id UUID
async function resolveSenderToUserId(senderIds) {
  const senderToUser = {};
  if (!senderIds || senderIds.length === 0) return senderToUser;

  // 1. Check existing llm_user_mappings
  try {
    const mappingRes = await dashboardPool.query(`
      SELECT goclaw_sender_id, user_id
      FROM llm_user_mappings
      WHERE goclaw_sender_id = ANY($1) OR user_id::text = ANY($1)
    `, [senderIds]);
    for (const m of mappingRes.rows) {
      if (m.goclaw_sender_id) senderToUser[m.goclaw_sender_id] = m.user_id;
      senderToUser[m.user_id] = m.user_id;
    }
  } catch (err) {
    console.warn('[Sync] Failed to query llm_user_mappings:', err.message);
  }

  // 2. Check for aitm_<UUID> or plain <UUID> format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const candidateUuids = [];
  const senderToCandidate = {};

  for (const sid of senderIds) {
    if (senderToUser[sid]) continue;
    let candidate = sid;
    if (sid.startsWith('aitm_')) {
      candidate = sid.slice(5);
    }
    if (uuidRegex.test(candidate)) {
      candidateUuids.push(candidate);
      senderToCandidate[sid] = candidate;
    }
  }

  if (candidateUuids.length > 0) {
    try {
      const placeholders = candidateUuids.map((_, i) => `$${i + 1}`).join(',');
      const userRes = await aitmPool.query(`SELECT id FROM users WHERE id IN (${placeholders})`, candidateUuids);
      const validUserIds = new Set(userRes.rows.map(u => u.id));

      for (const [sid, candidate] of Object.entries(senderToCandidate)) {
        if (validUserIds.has(candidate)) {
          senderToUser[sid] = candidate;
          // Auto-upsert into llm_user_mappings
          try {
            await dashboardPool.query(`
              INSERT INTO llm_user_mappings (id, user_id, goclaw_sender_id, goclaw_display_name, match_confidence, created_at, updated_at)
              VALUES (gen_random_uuid(), $1, $2, 'WebSocket User', 'auto', NOW(), NOW())
              ON CONFLICT (user_id) DO UPDATE SET
                goclaw_sender_id = COALESCE(llm_user_mappings.goclaw_sender_id, EXCLUDED.goclaw_sender_id),
                updated_at = NOW()
            `, [candidate, sid]);
          } catch (e) {
            // ignore conflict
          }
        }
      }
    } catch (err) {
      console.warn('[Sync] Failed to verify candidate UUIDs with AITM users:', err.message);
    }
  }

  // 3. Fallback: match by username / email prefix (e.g. 'falih1')
  for (const sid of senderIds) {
    if (senderToUser[sid] || sid === 'system') continue;
    try {
      const userRes = await aitmPool.query(`
        SELECT id FROM users
        WHERE name ILIKE $1 OR email ILIKE $1
        LIMIT 1
      `, [`%${sid}%`]);
      if (userRes.rows.length > 0) {
        const uid = userRes.rows[0].id;
        senderToUser[sid] = uid;
        try {
          await dashboardPool.query(`
            INSERT INTO llm_user_mappings (id, user_id, goclaw_sender_id, goclaw_display_name, match_confidence, created_at, updated_at)
            VALUES (gen_random_uuid(), $1, $2, $3, 'auto', NOW(), NOW())
            ON CONFLICT (user_id) DO UPDATE SET
              goclaw_sender_id = COALESCE(llm_user_mappings.goclaw_sender_id, EXCLUDED.goclaw_sender_id),
              updated_at = NOW()
          `, [uid, sid, sid]);
        } catch (e) {
          // ignore
        }
      }
    } catch (e) {
      // ignore
    }
  }

  return senderToUser;
}

// ─── GoClaw Traces → llm_usage_events Sync ───────────────────────────────────
/**
 * Reads GoClaw traces and inserts them as llm_usage_events.
 * Resolves GoClaw sender_id → AITM user_id.
 * Skips traces already imported (uses request_id for idempotency).
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
    // Read traces from GoClaw
    const { rows: traces } = await goclawClient.query(`
      SELECT
        t.id::text AS execution_id,
        t.user_id AS goclaw_sender_id,
        t.agent_id,
        t.channel,
        COALESCE(t.total_input_tokens, 0)  AS prompt_tokens,
        COALESCE(t.total_output_tokens, 0) AS completion_tokens,
        (COALESCE(t.total_input_tokens, 0) + COALESCE(t.total_output_tokens, 0)) AS total_tokens,
        t.status,
        COALESCE(t.duration_ms, 0) AS latency_ms,
        t.created_at,
        t.input_preview
      FROM traces t
      WHERE t.parent_trace_id IS NULL
        AND t.user_id IS NOT NULL
      ORDER BY t.created_at ASC
      LIMIT 1000
    `);

    if (traces.length === 0) return { synced: 0, skipped: 0, spans: 0 };

    // Resolve sender_id → AITM user_id map
    const senderIds = [...new Set(traces.map(t => t.goclaw_sender_id))];
    const senderToUser = await resolveSenderToUserId(senderIds);

    // Get models for all traces from spans
    const traceIds = traces.map(t => t.execution_id);
    const traceModels = {};
    try {
      const { rows: spanModels } = await goclawClient.query(`
        SELECT DISTINCT ON (trace_id) trace_id::text AS trace_id, model, provider
        FROM spans
        WHERE trace_id::text = ANY($1) AND model IS NOT NULL
        ORDER BY trace_id, created_at ASC
      `, [traceIds]);
      for (const sm of spanModels) {
        traceModels[sm.trace_id] = { model: sm.model, provider: sm.provider };
      }
    } catch (err) {
      console.warn('[Sync] Could not fetch span models:', err.message);
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

    // Collect trace IDs for span sync
    const traceIdsForSpans = [];

    for (const trace of traces) {
      const userId = senderToUser[trace.goclaw_sender_id];
      if (!userId) {
        skipped++;
        continue;
      }

      // Map GoClaw status to standard status
      const status = (trace.status === 'completed' || trace.status === 'ok') ? 'SUCCESS'
                   : trace.status === 'error' ? 'FAILED'
                   : 'SUCCESS';

      const modelInfo = traceModels[trace.execution_id] || { model: 'qwen3.7-plus', provider: 'sumopod' };
      const featureName = 'goclaw_chat';
      const requestId = `trace:${trace.execution_id}`;

      // Calculate cost based on service registry or token pricing
      const pricing = pricingMap[featureName];
      let costAmount = 0;
      let costCurrency = 'IDR';
      if (pricing) {
        costCurrency = pricing.cost_currency || 'IDR';
        if (pricing.pricing_type === 'per_1k_tokens') {
          costAmount = (Number(trace.total_tokens) / 1000.0) * parseFloat(pricing.cost_per_hit || 0);
        } else {
          costAmount = parseFloat(pricing.cost_per_hit || 0);
        }
      }

      try {
        const insertRes = await dashboardPool.query(`
          INSERT INTO llm_usage_events (
            id, user_id, source_service, feature_name, workflow_name,
            execution_id, request_id, model_name, provider_name,
            prompt_tokens, completion_tokens, total_tokens,
            cost_amount, cost_currency, status, latency_ms, quota_source, metadata_json, created_at
          ) VALUES (
            gen_random_uuid(), $1, 'GOCLAW', $2, $3,
            $4, $5, $6, $7,
            $8, $9, $10,
            $11, $12, $13, $14, 'RECURRING', $15, $16
          )
          ON CONFLICT (request_id) DO UPDATE SET
            prompt_tokens = EXCLUDED.prompt_tokens,
            completion_tokens = EXCLUDED.completion_tokens,
            total_tokens = EXCLUDED.total_tokens,
            model_name = COALESCE(EXCLUDED.model_name, llm_usage_events.model_name),
            status = EXCLUDED.status,
            latency_ms = EXCLUDED.latency_ms
        `, [
          userId,
          featureName,
          trace.agent_id || 'a-l-i-c-e-solo',
          trace.execution_id,
          requestId,
          modelInfo.model || 'qwen3.7-plus',
          modelInfo.provider || 'sumopod',
          trace.prompt_tokens || 0,
          trace.completion_tokens || 0,
          trace.total_tokens || 0,
          costAmount,
          costCurrency,
          status,
          trace.latency_ms || 0,
          JSON.stringify({
            goclawSenderId: trace.goclaw_sender_id,
            channel: trace.channel,
            preview: trace.input_preview?.slice(0, 200),
          }),
          trace.created_at,
        ]);
        synced++;
        traceIdsForSpans.push({ traceId: trace.execution_id, userId, createdAt: trace.created_at });
      } catch (err) {
        console.error('[Sync] Insert trace error:', err.message);
        skipped++;
      }
    }

    // ── Sync individual spans (tool_call + llm_call) for mapped traces ──
    if (traceIdsForSpans.length > 0) {
      const traceIdList = traceIdsForSpans.map(t => t.traceId);
      const traceUserMap = {};
      for (const t of traceIdsForSpans) traceUserMap[t.traceId] = t.userId;

      try {
        const { rows: spans } = await goclawClient.query(`
          SELECT
            s.id::text AS span_id,
            s.trace_id::text AS trace_id,
            s.span_type,
            s.name AS span_name,
            s.tool_name,
            s.model,
            s.provider,
            COALESCE(s.input_tokens, 0) AS input_tokens,
            COALESCE(s.output_tokens, 0) AS output_tokens,
            (COALESCE(s.input_tokens, 0) + COALESCE(s.output_tokens, 0)) AS total_tokens,
            s.total_cost,
            COALESCE(s.duration_ms, 0) AS duration_ms,
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

          const featureName = span.span_type === 'tool_call'
            ? (span.tool_name || span.span_name || 'unknown_tool')
            : 'llm_call';

          const spanStatus = (span.status === 'completed' || span.status === 'ok') ? 'SUCCESS'
                           : span.status === 'error' ? 'FAILED'
                           : 'SUCCESS';

          const pricing = pricingMap[featureName];
          let costAmount = 0;
          let costCurrency = 'IDR';
          if (pricing) {
            costCurrency = pricing.cost_currency || 'IDR';
            if (pricing.pricing_type === 'per_1k_tokens') {
              costAmount = (Number(span.total_tokens) / 1000.0) * parseFloat(pricing.cost_per_hit || 0);
            } else {
              costAmount = parseFloat(pricing.cost_per_hit || 0);
            }
          }

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
              ON CONFLICT (request_id) DO UPDATE SET
                prompt_tokens = EXCLUDED.prompt_tokens,
                completion_tokens = EXCLUDED.completion_tokens,
                total_tokens = EXCLUDED.total_tokens,
                status = EXCLUDED.status,
                latency_ms = EXCLUDED.latency_ms
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
              costAmount,
              costCurrency,
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
            // ignore duplicate errors
          }
        }
      } catch (err) {
        console.warn('[Sync] Span query error:', err.message);
      }
    }

    console.log(`[Sync] GoClaw traces synced: ${synced} traces, ${skipped} skipped, ${spansSynced} spans`);
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
