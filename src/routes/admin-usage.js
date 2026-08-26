const { Router } = require('express');
const { requireAuth, requireAdmin } = require('../auth');
const { dashboardPool, aitmPool } = require('../db');
const { getUserQuotaSummary } = require('../services/quota');

const router = Router();

// All routes require HR admin auth
router.use(requireAuth, requireAdmin);

// ─── GET /api/admin/overview ──────────────────────────────────────────────────
router.get('/overview', async (req, res) => {
  try {
    const { from, to, sourceService, featureName, modelName } = req.query;
    const periodFrom = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const periodTo   = to   || new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59).toISOString();

    const params = [periodFrom, periodTo];
    let serviceFilter = '';
    if (sourceService) { params.push(sourceService); serviceFilter = `AND source_service = $${params.length}`; }
    let featureFilter = '';
    if (featureName) { params.push(featureName); featureFilter = `AND feature_name = $${params.length}`; }

    // Summary totals
    const totalsRes = await dashboardPool.query(`
      SELECT
        COALESCE(SUM(total_tokens), 0)                                          AS total_tokens,
        COALESCE(SUM(cost_amount), 0)                                           AS total_cost,
        COUNT(*) FILTER (WHERE status = 'SUCCESS')                              AS successful_requests,
        COUNT(*) FILTER (WHERE status = 'FAILED')                               AS failed_requests,
        COUNT(*) FILTER (WHERE status = 'REJECTED')                             AS rejected_requests,
        COUNT(DISTINCT user_id)                                                 AS active_users
      FROM llm_usage_events
      WHERE created_at BETWEEN $1 AND $2 ${serviceFilter} ${featureFilter}
    `, params);

    // Users with exhausted quota
    const exhaustedRes = await dashboardPool.query(`
      SELECT COUNT(DISTINCT user_id) AS exhausted_count
      FROM llm_usage_events
      WHERE status = 'REJECTED' AND created_at BETWEEN $1 AND $2
    `, [periodFrom, periodTo]);

    // By source service
    const bySourceRes = await dashboardPool.query(`
      SELECT source_service,
             SUM(total_tokens)                              AS total_tokens,
             SUM(cost_amount)                               AS total_cost,
             COUNT(*) FILTER (WHERE status = 'SUCCESS')    AS success_count,
             COUNT(*) FILTER (WHERE status = 'REJECTED')   AS rejected_count
      FROM llm_usage_events
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY source_service ORDER BY total_tokens DESC
    `, [periodFrom, periodTo]);

    // By feature
    const byFeatureRes = await dashboardPool.query(`
      SELECT feature_name,
             SUM(total_tokens) AS total_tokens,
             SUM(cost_amount)  AS total_cost,
             COUNT(*)          AS request_count
      FROM llm_usage_events
      WHERE created_at BETWEEN $1 AND $2 AND feature_name IS NOT NULL ${serviceFilter}
      GROUP BY feature_name ORDER BY total_tokens DESC
      LIMIT 10
    `, params);

    // By model
    const byModelRes = await dashboardPool.query(`
      SELECT model_name,
             SUM(total_tokens) AS total_tokens,
             COUNT(*)          AS request_count
      FROM llm_usage_events
      WHERE created_at BETWEEN $1 AND $2 AND model_name IS NOT NULL ${serviceFilter}
      GROUP BY model_name ORDER BY total_tokens DESC
      LIMIT 10
    `, params);

    // Top token consumers (from Dashboard DB first, then resolve names from AITM)
    const topConsumersRes = await dashboardPool.query(`
      SELECT
        user_id,
        SUM(total_tokens)   AS total_tokens,
        SUM(cost_amount)    AS total_cost,
        COUNT(*) FILTER (WHERE status = 'SUCCESS') AS success_count
      FROM llm_usage_events
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY user_id
      ORDER BY total_tokens DESC
      LIMIT 20
    `, [periodFrom, periodTo]);

    let topUsersRows = [];
    if (topConsumersRes.rows.length > 0) {
      const uIds = topConsumersRes.rows.map(r => r.user_id);
      const { rows: userInfo } = await aitmPool.query(`
        SELECT u.id AS user_id, u.name, u.email, ur.role_name AS role
        FROM users u
        JOIN employees emp ON emp.user_id = u.id
        JOIN user_roles ur ON ur.id = emp.user_role_id
        WHERE u.id = ANY($1) AND ur.role_name IN ('HUMAN RESOURCES', 'HIRING MANAGER')
      `, [uIds]);
      const userDict = new Map(userInfo.map(u => [u.user_id, u]));

      topUsersRows = topConsumersRes.rows
        .filter(r => userDict.has(r.user_id))
        .map(r => ({
          ...r,
          name: userDict.get(r.user_id).name,
          email: userDict.get(r.user_id).email,
          role: userDict.get(r.user_id).role,
        }))
        .slice(0, 10);
    }

    // Daily trend for chart
    const trendRes = await dashboardPool.query(`
      SELECT
        DATE_TRUNC('day', created_at) AS day,
        SUM(total_tokens)             AS total_tokens,
        SUM(cost_amount)              AS total_cost,
        COUNT(*)                      AS requests
      FROM llm_usage_events
      WHERE created_at BETWEEN $1 AND $2 ${serviceFilter}
      GROUP BY day ORDER BY day ASC
    `, params);

    const totals = totalsRes.rows[0];
    res.json({
      period: { from: periodFrom, to: periodTo },
      totalTokens:        Number(totals.total_tokens),
      totalCost:          parseFloat(totals.total_cost),
      successfulRequests: Number(totals.successful_requests),
      failedRequests:     Number(totals.failed_requests),
      rejectedRequests:   Number(totals.rejected_requests),
      activeUsers:        Number(totals.active_users),
      exhaustedUsers:     Number(exhaustedRes.rows[0].exhausted_count),
      bySource:   bySourceRes.rows.map(r => ({ ...r, totalTokens: Number(r.total_tokens), totalCost: parseFloat(r.total_cost) })),
      byFeature:  byFeatureRes.rows.map(r => ({ ...r, totalTokens: Number(r.total_tokens), totalCost: parseFloat(r.total_cost) })),
      byModel:    byModelRes.rows.map(r => ({ ...r, totalTokens: Number(r.total_tokens) })),
      topUsers:   topUsersRows.map(r => ({ ...r, totalTokens: Number(r.total_tokens), totalCost: parseFloat(r.total_cost) })),
      dailyTrend: trendRes.rows.map(r => ({ day: r.day, totalTokens: Number(r.total_tokens), totalCost: parseFloat(r.total_cost), requests: Number(r.requests) })),
    });
  } catch (err) {
    console.error('[Admin] GET /overview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/users ─────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const { search, skip = 0, take = 20 } = req.query;

    const params = [];
    let whereClause = "WHERE ur.role_name IN ('HUMAN RESOURCES', 'HIRING MANAGER')";
    if (search) {
      params.push(`%${search}%`);
      whereClause += ` AND (u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`;
    }

    const countRes = await aitmPool.query(`
      SELECT COUNT(*) AS total FROM users u
      JOIN employees emp ON emp.user_id = u.id
      JOIN user_roles ur ON ur.id = emp.user_role_id
      ${whereClause}
    `, params);

    params.push(parseInt(take));
    const limitParam = `$${params.length}`;
    params.push(parseInt(skip));
    const offsetParam = `$${params.length}`;

    // 1. Fetch page users from AITM DB
    const { rows: users } = await aitmPool.query(`
      SELECT u.id AS user_id, u.name, u.email, ur.role_name AS role
      FROM users u
      JOIN employees emp ON emp.user_id = u.id
      JOIN user_roles ur ON ur.id = emp.user_role_id
      ${whereClause}
      ORDER BY u.name ASC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `, params);

    // 2. Fetch quota summaries for these users
    const items = await Promise.all(users.map(async u => {
      const summary = await getUserQuotaSummary(u.user_id);

      // Fetch n8n_scout usage this month from dashboardPool
      const scoutRes = await dashboardPool.query(`
        SELECT COUNT(*) AS hits, COALESCE(SUM(cost_amount), 0) AS cost
        FROM llm_usage_events
        WHERE user_id = $1 AND feature_name = 'n8n_scout'
          AND status = 'SUCCESS' AND created_at >= DATE_TRUNC('month', NOW())
      `, [u.user_id]);

      const planQuota = summary.planQuota || 0;
      const usedRecurring = summary.usedRecurringTokens || 0;
      const remainRecurring = summary.remainingRecurringTokens || 0;
      const remainBundle = summary.remainingBundleTokens || 0;
      const totalRemaining = summary.totalRemainingTokens || 0;

      let status = 'NO_PLAN';
      if (planQuota > 0 || remainBundle > 0) {
        const pct = planQuota > 0 ? (usedRecurring / planQuota) * 100 : 100;
        if (totalRemaining === 0)  status = 'EXHAUSTED';
        else if (pct >= 90)        status = 'CRITICAL';
        else if (pct >= 70)        status = 'WARNING';
        else                       status = 'HEALTHY';
      }

      return {
        userId: u.user_id,
        name: u.name,
        email: u.email,
        role: u.role,
        planName: summary.assignment?.plan_name || null,
        quotaType: summary.assignment?.quota_type || null,
        quotaTokens: planQuota,
        usedRecurringTokens: usedRecurring,
        remainingRecurringTokens: remainRecurring,
        remainingBundleTokens: remainBundle,
        totalRemainingTokens: totalRemaining,
        resetAt: summary.assignment?.reset_at || null,
        goclawSenderId: summary.goclawSenderId || null,
        n8nScoutHitsMonth: Number(scoutRes.rows[0]?.hits || 0),
        n8nScoutCostMonth: parseFloat(scoutRes.rows[0]?.cost || 0),
        status,
      };
    }));

    res.json({ items, total: Number(countRes.rows[0].total) });
  } catch (err) {
    console.error('[Admin] GET /users error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/users/:userId ────────────────────────────────────────────
router.get('/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const summary = await getUserQuotaSummary(userId);

    // User info from AITM
    const userRes = await aitmPool.query(`
      SELECT u.id, u.name, u.email, ur.role_name AS role
      FROM users u
      JOIN employees emp ON emp.user_id = u.id
      JOIN user_roles ur ON ur.id = emp.user_role_id
      WHERE u.id = $1
    `, [userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    // User mapping from Dashboard DB
    const mappingRes = await dashboardPool.query(`
      SELECT goclaw_sender_id, goclaw_display_name FROM llm_user_mappings WHERE user_id = $1
    `, [userId]);
    const mapping = mappingRes.rows[0] || {};

    // Usage by feature
    const byFeatureRes = await dashboardPool.query(`
      SELECT feature_name, SUM(total_tokens) AS total_tokens, SUM(cost_amount) AS total_cost, COUNT(*) AS requests
      FROM llm_usage_events
      WHERE user_id = $1 AND feature_name IS NOT NULL
      GROUP BY feature_name ORDER BY total_tokens DESC
    `, [userId]);

    // Usage by source
    const bySourceRes = await dashboardPool.query(`
      SELECT source_service, SUM(total_tokens) AS total_tokens, SUM(cost_amount) AS total_cost
      FROM llm_usage_events WHERE user_id = $1
      GROUP BY source_service ORDER BY total_tokens DESC
    `, [userId]);

    // Recent events
    const recentRes = await dashboardPool.query(`
      SELECT id, source_service, feature_name, workflow_name, model_name,
             prompt_tokens, completion_tokens, total_tokens, cost_amount,
             status, latency_ms, created_at
      FROM llm_usage_events WHERE user_id = $1
      ORDER BY created_at DESC LIMIT 20
    `, [userId]);

    const user = userRes.rows[0];
    res.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role,
              goclawSenderId: mapping.goclaw_sender_id || null, goclawDisplayName: mapping.goclaw_display_name || null },
      plan:  summary.assignment,
      quota: {
        usedRecurringTokens:      summary.usedRecurringTokens,
        remainingRecurringTokens: summary.remainingRecurringTokens,
        remainingBundleTokens:    summary.remainingBundleTokens,
        totalRemainingTokens:     summary.totalRemainingTokens,
        planQuota:                summary.planQuota,
      },
      bundles:    summary.bundles,
      byFeature:  byFeatureRes.rows.map(r => ({ ...r, totalTokens: Number(r.total_tokens), totalCost: parseFloat(r.total_cost) })),
      bySource:   bySourceRes.rows.map(r => ({ ...r, totalTokens: Number(r.total_tokens), totalCost: parseFloat(r.total_cost) })),
      recentEvents: recentRes.rows.map(r => ({ ...r,
        promptTokens: Number(r.prompt_tokens), completionTokens: Number(r.completion_tokens),
        totalTokens: Number(r.total_tokens), costAmount: parseFloat(r.cost_amount),
      })),
    });
  } catch (err) {
    console.error('[Admin] GET /users/:userId error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/events ────────────────────────────────────────────────────
router.get('/events', async (req, res) => {
  try {
    const { from, to, userId, sourceService, featureName, workflowName, modelName, status, skip = 0, take = 20 } = req.query;
    const periodFrom = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const periodTo   = to   || new Date().toISOString();

    const params = [periodFrom, periodTo];
    const conditions = [];
    if (userId)        { params.push(userId);        conditions.push(`user_id = $${params.length}`); }
    if (sourceService) { params.push(sourceService); conditions.push(`source_service = $${params.length}`); }
    if (featureName)   { params.push(featureName);   conditions.push(`feature_name = $${params.length}`); }
    if (workflowName)  { params.push(workflowName);  conditions.push(`workflow_name = $${params.length}`); }
    if (modelName)     { params.push(modelName);     conditions.push(`model_name = $${params.length}`); }
    if (status)        { params.push(status);        conditions.push(`status = $${params.length}`); }
    const whereExtra = conditions.length ? 'AND ' + conditions.join(' AND ') : '';

    const queryParams = [...params, parseInt(take), parseInt(skip)];
    const takeParam = `$${queryParams.length - 1}`;
    const skipParam = `$${queryParams.length}`;

    const { rows: events } = await dashboardPool.query(`
      SELECT id, user_id, source_service, feature_name, workflow_name, execution_id,
             request_id, model_name, provider_name, prompt_tokens, completion_tokens,
             total_tokens, cost_amount, cost_currency, status, latency_ms, quota_source,
             metadata_json, created_at
      FROM llm_usage_events
      WHERE created_at BETWEEN $1 AND $2 ${whereExtra}
      ORDER BY created_at DESC
      LIMIT ${takeParam} OFFSET ${skipParam}
    `, queryParams);

    const countRes = await dashboardPool.query(`
      SELECT COUNT(*) AS total FROM llm_usage_events
      WHERE created_at BETWEEN $1 AND $2 ${whereExtra}
    `, params);

    // Resolve user names & emails from AITM DB
    const userIds = [...new Set(events.map(e => e.user_id).filter(Boolean))];
    let userDict = new Map();
    if (userIds.length > 0) {
      const { rows: users } = await aitmPool.query(`
        SELECT u.id, u.name, u.email FROM users u WHERE u.id = ANY($1)
      `, [userIds]);
      userDict = new Map(users.map(u => [u.id, u]));
    }

    const items = events.map(e => {
      const u = userDict.get(e.user_id) || {};
      return {
        id: e.id,
        userId: e.user_id,
        userName: u.name || null,
        userEmail: u.email || null,
        sourceService: e.source_service,
        featureName: e.feature_name,
        workflowName: e.workflow_name,
        executionId: e.execution_id,
        modelName: e.model_name,
        promptTokens: Number(e.prompt_tokens),
        completionTokens: Number(e.completion_tokens),
        totalTokens: Number(e.total_tokens),
        costAmount: parseFloat(e.cost_amount),
        costCurrency: e.cost_currency,
        status: e.status,
        latencyMs: e.latency_ms,
        createdAt: e.created_at,
      };
    });

    res.json({ items, total: Number(countRes.rows[0].total) });
  } catch (err) {
    console.error('[Admin] GET /events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/workflows ─────────────────────────────────────────────────
router.get('/workflows', async (req, res) => {
  try {
    const { from, to, sourceService } = req.query;
    const periodFrom = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const periodTo   = to   || new Date().toISOString();
    const params = [periodFrom, periodTo];
    let svcFilter = '';
    if (sourceService) { params.push(sourceService); svcFilter = `AND source_service = $${params.length}`; }

    const { rows } = await dashboardPool.query(`
      SELECT
        source_service,
        COALESCE(workflow_name, feature_name, 'unknown') AS workflow_name,
        feature_name,
        SUM(total_tokens)                                    AS total_tokens,
        SUM(cost_amount)                                     AS total_cost,
        COUNT(*) FILTER (WHERE status = 'SUCCESS')           AS success_count,
        COUNT(*) FILTER (WHERE status = 'FAILED')            AS failed_count,
        COUNT(*) FILTER (WHERE status = 'REJECTED')          AS rejected_count,
        CASE WHEN COUNT(*) FILTER (WHERE status = 'SUCCESS') > 0
             THEN SUM(total_tokens) / COUNT(*) FILTER (WHERE status = 'SUCCESS')
             ELSE 0 END                                      AS avg_tokens_per_request
      FROM llm_usage_events
      WHERE created_at BETWEEN $1 AND $2 ${svcFilter}
      GROUP BY source_service, COALESCE(workflow_name, feature_name, 'unknown'), feature_name
      ORDER BY total_tokens DESC
    `, params);

    res.json({ items: rows.map(r => ({ ...r, totalTokens: Number(r.total_tokens), totalCost: parseFloat(r.total_cost), avgTokensPerRequest: Number(r.avg_tokens_per_request) })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/services ──────────────────────────────────────────────────
router.get('/services', async (req, res) => {
  try {
    const { rows } = await dashboardPool.query(`SELECT * FROM llm_service_registry ORDER BY source_service, service_name`);
    res.json({ items: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/admin/services ─────────────────────────────────────────────────
router.post('/services', async (req, res) => {
  try {
    const { serviceName, sourceService, displayName, description, pricingType, costPerHit, costCurrency = 'USD', hitLimitMonthly, costLimitMonthly, pricingDetails } = req.body;
    if (!serviceName || !sourceService || !displayName) {
      return res.status(400).json({ error: 'serviceName, sourceService, and displayName required' });
    }

    const { rows } = await dashboardPool.query(`
      INSERT INTO llm_service_registry (
        id, service_name, source_service, display_name, description, pricing_type,
        cost_per_hit, cost_currency, hit_limit_monthly, cost_limit_monthly,
        is_active, pricing_details, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        true, $10, NOW(), NOW()
      ) RETURNING *
    `, [
      serviceName, sourceService, displayName, description || null, pricingType || 'per_hit',
      costPerHit || 0, costCurrency, hitLimitMonthly !== undefined ? hitLimitMonthly : null,
      costLimitMonthly !== undefined ? costLimitMonthly : null, JSON.stringify(pricingDetails || {}),
    ]);

    await dashboardPool.query(`INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
      VALUES (gen_random_uuid(), $1, 'service.create', 'llm_service_registry', $2, $3, NOW())`,
      [req.user.id, rows[0].id, JSON.stringify(rows[0])]);

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Service name already registered' });
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/admin/services/:id ────────────────────────────────────────────
router.patch('/services/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { displayName, description, pricingType, costPerHit, costCurrency, hitLimitMonthly, costLimitMonthly, isActive, pricingDetails } = req.body;

    const existing = await dashboardPool.query(`SELECT * FROM llm_service_registry WHERE id = $1`, [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Service not found' });

    const { rows } = await dashboardPool.query(`
      UPDATE llm_service_registry SET
        display_name       = COALESCE($1, display_name),
        description        = COALESCE($2, description),
        pricing_type       = COALESCE($3, pricing_type),
        cost_per_hit       = COALESCE($4, cost_per_hit),
        cost_currency      = COALESCE($5, cost_currency),
        hit_limit_monthly  = COALESCE($6, hit_limit_monthly),
        cost_limit_monthly = COALESCE($7, cost_limit_monthly),
        is_active          = COALESCE($8, is_active),
        pricing_details    = COALESCE($9, pricing_details),
        updated_at         = NOW()
      WHERE id = $10 RETURNING *
    `, [displayName, description, pricingType, costPerHit, costCurrency, hitLimitMonthly, costLimitMonthly, isActive, pricingDetails ? JSON.stringify(pricingDetails) : null, id]);

    await dashboardPool.query(`INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, before_json, after_json, created_at)
      VALUES (gen_random_uuid(), $1, 'service.update', 'llm_service_registry', $2, $3, $4, NOW())`,
      [req.user.id, id, JSON.stringify(existing.rows[0]), JSON.stringify(rows[0])]);

    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── DELETE /api/admin/services/:id (soft) ────────────────────────────────────
router.delete('/services/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await dashboardPool.query(`SELECT * FROM llm_service_registry WHERE id = $1`, [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Service not found' });

    await dashboardPool.query(`UPDATE llm_service_registry SET is_active = false, updated_at = NOW() WHERE id = $1`, [id]);

    await dashboardPool.query(`INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, before_json, created_at)
      VALUES (gen_random_uuid(), $1, 'service.delete', 'llm_service_registry', $2, $3, NOW())`,
      [req.user.id, id, JSON.stringify(existing.rows[0])]);

    res.json({ ok: true, message: 'Service deactivated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/admin/features — distinct feature_names for service dropdown ────
router.get('/features', async (req, res) => {
  try {
    const { rows } = await dashboardPool.query(`
      SELECT feature_name, COUNT(*) AS event_count, SUM(total_tokens) AS total_tokens,
             MAX(created_at) AS last_seen
      FROM llm_usage_events
      WHERE feature_name IS NOT NULL
      GROUP BY feature_name
      ORDER BY event_count DESC
    `);
    const { rows: services } = await dashboardPool.query(`SELECT service_name FROM llm_service_registry`);
    const registered = new Set(services.map(s => s.service_name));
    
    const featureMap = new Map();
    // Default known backend and N8N features
    const defaultFeatures = [
      'cv_parser', 'n8n_read_data', 'n8n_talent_pool', 'n8n_chatbot',
      'candidate_analysis', 'llm_call', 'n8n_scout', 'linkedin'
    ];
    for (const df of defaultFeatures) {
      featureMap.set(df, { featureName: df, eventCount: 0, totalTokens: 0, lastSeen: null, hasService: registered.has(df) });
    }
    for (const s of services) {
      if (!featureMap.has(s.service_name)) {
        featureMap.set(s.service_name, { featureName: s.service_name, eventCount: 0, totalTokens: 0, lastSeen: null, hasService: true });
      }
    }
    for (const r of rows) {
      featureMap.set(r.feature_name, {
        featureName: r.feature_name,
        eventCount: Number(r.event_count),
        totalTokens: Number(r.total_tokens),
        lastSeen: r.last_seen,
        hasService: registered.has(r.feature_name),
      });
    }

    res.json({ items: Array.from(featureMap.values()) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── POST /api/admin/services/recalculate — recalculate costs from pricing ────
router.post('/services/recalculate', async (req, res) => {
  try {
    // Load all active services
    const { rows: services } = await dashboardPool.query(`
      SELECT service_name, cost_per_hit, pricing_type, cost_currency FROM llm_service_registry WHERE is_active = true
    `);

    let updated = 0;
    for (const svc of services) {
      let result;
      if (svc.pricing_type === 'per_1k_tokens') {
        result = await dashboardPool.query(`
          UPDATE llm_usage_events
          SET cost_amount = (total_tokens::numeric / 1000.0) * $1,
              cost_currency = $3
          WHERE feature_name = $2
        `, [svc.cost_per_hit, svc.service_name, svc.cost_currency]);
      } else {
        result = await dashboardPool.query(`
          UPDATE llm_usage_events
          SET cost_amount = $1,
              cost_currency = $3
          WHERE feature_name = $2
        `, [svc.cost_per_hit, svc.service_name, svc.cost_currency]);
      }
      updated += result.rowCount;
    }

    await dashboardPool.query(`INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
      VALUES (gen_random_uuid(), $1, 'service.recalculate', 'llm_usage_events', 'all', $2, NOW())`,
      [req.user.id, JSON.stringify({ servicesProcessed: services.length, eventsUpdated: updated })]);

    res.json({ ok: true, servicesProcessed: services.length, eventsUpdated: updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── POST /api/admin/users — create new user ─────────────────────────────────
router.post('/users', async (req, res) => {
  try {
    const { name, email, password, role, companyId } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'name, email, password, role required' });
    }

    const validRoles = ['ADMIN', 'HUMAN RESOURCES', 'HIRING MANAGER'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
    }

    // Check if email already exists in AITM DB
    const existing = await aitmPool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }

    // Hash password with bcryptjs
    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash(password, 10);

    // Get role ID from AITM DB
    const roleResult = await aitmPool.query('SELECT id FROM user_roles WHERE role_name = $1', [role]);
    if (roleResult.rows.length === 0) {
      return res.status(400).json({ error: `Role '${role}' not found in database` });
    }
    const roleId = roleResult.rows[0].id;

    // Get a default employee_position_id from AITM DB
    const posResult = await aitmPool.query('SELECT id FROM employee_positions LIMIT 1');
    const posId = posResult.rows.length > 0 ? posResult.rows[0].id : null;

    // Create user in AITM DB
    const userId = require('crypto').randomUUID();
    await aitmPool.query(`
      INSERT INTO users (id, name, email, password, password_set_required, created_at, updated_at)
      VALUES ($1, $2, $3, $4, false, NOW(), NOW())
    `, [userId, name, email, hashedPassword]);

    // Create employee record in AITM DB
    const empId = require('crypto').randomUUID();
    const empNum = 'EMP-' + userId.slice(0, 8).toUpperCase();
    await aitmPool.query(`
      INSERT INTO employees (id, user_id, user_role_id, employee_position_id, employee_identification_number, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
    `, [empId, userId, roleId, posId, empNum]);

    // Create user mapping with company in Dashboard DB
    await dashboardPool.query(`
      INSERT INTO llm_user_mappings (id, user_id, company_id, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, NOW(), NOW())
      ON CONFLICT (user_id) DO UPDATE SET company_id = EXCLUDED.company_id, updated_at = NOW()
    `, [userId, companyId || null]);

    // Audit log in Dashboard DB
    await dashboardPool.query(`
      INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
      VALUES (gen_random_uuid(), $1, 'user.create', 'user', $2, $3, NOW())
    `, [req.user.id, userId, JSON.stringify({ name, email, role, companyId })]);

    res.status(201).json({ ok: true, userId, name, email, role });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── PATCH /api/admin/users/:id — update user ────────────────────────────────
router.patch('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, password, role, companyId } = req.body;

    // Check user exists in AITM DB
    const userRes = await aitmPool.query('SELECT id FROM users WHERE id = $1', [id]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    // Update user fields in AITM DB
    if (name) await aitmPool.query('UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2', [name, id]);
    if (email) await aitmPool.query('UPDATE users SET email = $1, updated_at = NOW() WHERE id = $2', [email, id]);
    if (password) {
      const bcrypt = require('bcryptjs');
      const hashed = await bcrypt.hash(password, 10);
      await aitmPool.query('UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2', [hashed, id]);
    }

    // Update role if provided in AITM DB
    if (role) {
      const validRoles = ['ADMIN', 'HUMAN RESOURCES', 'HIRING MANAGER'];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
      }
      const roleResult = await aitmPool.query('SELECT id FROM user_roles WHERE role_name = $1', [role]);
      if (roleResult.rows.length > 0) {
        await aitmPool.query('UPDATE employees SET user_role_id = $1, updated_at = NOW() WHERE user_id = $2', [roleResult.rows[0].id, id]);
      }
    }

    // Update company mapping in Dashboard DB if provided
    if (companyId !== undefined) {
      await dashboardPool.query(`
        INSERT INTO llm_user_mappings (id, user_id, company_id, created_at, updated_at)
        VALUES (gen_random_uuid(), $1, $2, NOW(), NOW())
        ON CONFLICT (user_id) DO UPDATE SET company_id = $2, updated_at = NOW()
      `, [id, companyId || null]);
    }

    // Audit log in Dashboard DB
    await dashboardPool.query(`
      INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
      VALUES (gen_random_uuid(), $1, 'user.update', 'user', $2, $3, NOW())
    `, [req.user.id, id, JSON.stringify({ name, email, role, companyId, passwordChanged: !!password })]);

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── DELETE /api/admin/users/:id — delete user ───────────────────────────────
router.delete('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Prevent deleting yourself
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    // Delete employee record first in AITM DB
    await aitmPool.query('DELETE FROM employees WHERE user_id = $1', [id]);
    // Delete user in AITM DB
    const result = await aitmPool.query('DELETE FROM users WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });

    // Audit log
    await aitmPool.query(`
      INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
      VALUES (gen_random_uuid(), $1, 'user.delete', 'user', $2, $3, NOW())
    `, [req.user.id, id, JSON.stringify({ deletedUserId: id })]);

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
