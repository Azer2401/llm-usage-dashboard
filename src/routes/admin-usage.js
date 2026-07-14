'use strict';

const { Router } = require('express');
const { requireAuth, requireAdmin } = require('../auth');
const { aitmPool } = require('../db');
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
    const totalsRes = await aitmPool.query(`
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
    const exhaustedRes = await aitmPool.query(`
      SELECT COUNT(DISTINCT user_id) AS exhausted_count
      FROM llm_usage_events
      WHERE status = 'REJECTED' AND created_at BETWEEN $1 AND $2
    `, [periodFrom, periodTo]);

    // By source service
    const bySourceRes = await aitmPool.query(`
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
    const byFeatureRes = await aitmPool.query(`
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
    const byModelRes = await aitmPool.query(`
      SELECT model_name,
             SUM(total_tokens) AS total_tokens,
             COUNT(*)          AS request_count
      FROM llm_usage_events
      WHERE created_at BETWEEN $1 AND $2 AND model_name IS NOT NULL ${serviceFilter}
      GROUP BY model_name ORDER BY total_tokens DESC
      LIMIT 10
    `, params);

    // Top token consumers (HR/HM only)
    const topUsersRes = await aitmPool.query(`
      SELECT
        e.user_id,
        u.name,
        u.email,
        ur.role_name AS role,
        SUM(e.total_tokens)   AS total_tokens,
        SUM(e.cost_amount)    AS total_cost,
        COUNT(*) FILTER (WHERE e.status = 'SUCCESS') AS success_count
      FROM llm_usage_events e
      JOIN users u ON u.id = e.user_id
      JOIN employees emp ON emp.user_id = u.id
      JOIN user_roles ur ON ur.id = emp.user_role_id
      WHERE e.created_at BETWEEN $1 AND $2
        AND ur.role_name IN ('HUMAN RESOURCES', 'HIRING MANAGER')
      GROUP BY e.user_id, u.name, u.email, ur.role_name
      ORDER BY total_tokens DESC
      LIMIT 10
    `, [periodFrom, periodTo]);

    // Daily trend for chart (last 30 days or selected period)
    const trendRes = await aitmPool.query(`
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
      topUsers:   topUsersRes.rows.map(r => ({ ...r, totalTokens: Number(r.total_tokens), totalCost: parseFloat(r.total_cost) })),
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
    const { search, quotaType, usageStatus, from, to, skip = 0, take = 20 } = req.query;
    const periodFrom = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const periodTo   = to   || new Date().toISOString();

    const params = [parseInt(take), parseInt(skip)];
    const conditions = ["ur.role_name IN ('HUMAN RESOURCES', 'HIRING MANAGER')"];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
    }
    if (quotaType) {
      params.push(quotaType);
      conditions.push(`p.quota_type = $${params.length}`);
    }

    const { rows } = await aitmPool.query(`
      SELECT
        u.id          AS user_id,
        u.name,
        u.email,
        ur.role_name  AS role,
        p.name        AS plan_name,
        p.quota_type,
        p.quota_tokens,
        a.reset_at,
        a.starts_at,
        m.goclaw_sender_id,
        m.goclaw_display_name,
        -- Used tokens this period
        COALESCE(
          (SELECT SUM(total_tokens) FROM llm_usage_events
           WHERE user_id = u.id AND status = 'SUCCESS'
             AND quota_source IN ('RECURRING','BOTH')
             AND created_at >= a.starts_at AND created_at < a.reset_at),
          0
        ) AS used_recurring_tokens,
        -- Bundle remaining
        COALESCE(
          (SELECT SUM(remaining_tokens) FROM llm_quota_bundles
           WHERE user_id = u.id AND remaining_tokens > 0
             AND (expires_at IS NULL OR expires_at > NOW())),
          0
        ) AS remaining_bundle_tokens,
        -- N8N Scout hits this month
        COALESCE(
          (SELECT COUNT(*) FROM llm_usage_events
           WHERE user_id = u.id AND feature_name = 'n8n_scout'
             AND status = 'SUCCESS' AND created_at >= DATE_TRUNC('month', NOW())),
          0
        ) AS n8n_scout_hits_month,
        -- N8N Scout cost this month
        COALESCE(
          (SELECT SUM(cost_amount) FROM llm_usage_events
           WHERE user_id = u.id AND feature_name = 'n8n_scout'
             AND status = 'SUCCESS' AND created_at >= DATE_TRUNC('month', NOW())),
          0
        ) AS n8n_scout_cost_month
      FROM users u
      JOIN employees emp ON emp.user_id = u.id
      JOIN user_roles ur ON ur.id = emp.user_role_id
      LEFT JOIN llm_plan_assignments a ON a.user_id = u.id AND a.is_active = true
      LEFT JOIN llm_token_plans p ON p.id = a.plan_id
      LEFT JOIN llm_user_mappings m ON m.user_id = u.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY u.name ASC
      LIMIT $1 OFFSET $2
    `, params);

    // Compute quota status for each user
    const items = rows.map(r => {
      const planQuota        = Number(r.quota_tokens || 0);
      const usedRecurring    = Number(r.used_recurring_tokens);
      const remainRecurring  = Math.max(0, planQuota - usedRecurring);
      const remainBundle     = Number(r.remaining_bundle_tokens);
      const totalRemaining   = remainRecurring + remainBundle;

      let status = 'NO_PLAN';
      if (planQuota > 0 || remainBundle > 0) {
        const pct = planQuota > 0 ? (usedRecurring / planQuota) * 100 : 100;
        if (totalRemaining === 0)  status = 'EXHAUSTED';
        else if (pct >= 90)        status = 'CRITICAL';
        else if (pct >= 70)        status = 'WARNING';
        else                       status = 'HEALTHY';
      }

      return {
        userId: r.user_id,
        name: r.name,
        email: r.email,
        role: r.role,
        planName: r.plan_name || null,
        quotaType: r.quota_type || null,
        quotaTokens: planQuota,
        usedRecurringTokens: usedRecurring,
        remainingRecurringTokens: remainRecurring,
        remainingBundleTokens: remainBundle,
        totalRemainingTokens: totalRemaining,
        resetAt: r.reset_at,
        goclawSenderId: r.goclaw_sender_id,
        n8nScoutHitsMonth: Number(r.n8n_scout_hits_month),
        n8nScoutCostMonth: parseFloat(r.n8n_scout_cost_month),
        status,
      };
    });

    const countRes = await aitmPool.query(`
      SELECT COUNT(*) AS total FROM users u
      JOIN employees emp ON emp.user_id = u.id
      JOIN user_roles ur ON ur.id = emp.user_role_id
      WHERE ur.role_name IN ('HUMAN RESOURCES', 'HIRING MANAGER')
      ${search ? `AND (u.name ILIKE $1 OR u.email ILIKE $1)` : ''}
    `, search ? [`%${search}%`] : []);

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

    // User info
    const userRes = await aitmPool.query(`
      SELECT u.id, u.name, u.email, ur.role_name AS role,
             m.goclaw_sender_id, m.goclaw_display_name
      FROM users u
      JOIN employees emp ON emp.user_id = u.id
      JOIN user_roles ur ON ur.id = emp.user_role_id
      LEFT JOIN llm_user_mappings m ON m.user_id = u.id
      WHERE u.id = $1
    `, [userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    // Usage by feature
    const byFeatureRes = await aitmPool.query(`
      SELECT feature_name, SUM(total_tokens) AS total_tokens, SUM(cost_amount) AS total_cost, COUNT(*) AS requests
      FROM llm_usage_events
      WHERE user_id = $1 AND feature_name IS NOT NULL
      GROUP BY feature_name ORDER BY total_tokens DESC
    `, [userId]);

    // Usage by source
    const bySourceRes = await aitmPool.query(`
      SELECT source_service, SUM(total_tokens) AS total_tokens, SUM(cost_amount) AS total_cost
      FROM llm_usage_events WHERE user_id = $1
      GROUP BY source_service ORDER BY total_tokens DESC
    `, [userId]);

    // Recent events
    const recentRes = await aitmPool.query(`
      SELECT id, source_service, feature_name, workflow_name, model_name,
             prompt_tokens, completion_tokens, total_tokens, cost_amount,
             status, latency_ms, created_at
      FROM llm_usage_events WHERE user_id = $1
      ORDER BY created_at DESC LIMIT 20
    `, [userId]);

    const user = userRes.rows[0];
    res.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role,
              goclawSenderId: user.goclaw_sender_id, goclawDisplayName: user.goclaw_display_name },
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

    const params = [periodFrom, periodTo, parseInt(take), parseInt(skip)];
    const conditions = [];
    if (userId)        { params.push(userId);        conditions.push(`e.user_id = $${params.length}`); }
    if (sourceService) { params.push(sourceService); conditions.push(`e.source_service = $${params.length}`); }
    if (featureName)   { params.push(featureName);   conditions.push(`e.feature_name = $${params.length}`); }
    if (workflowName)  { params.push(workflowName);  conditions.push(`e.workflow_name = $${params.length}`); }
    if (modelName)     { params.push(modelName);     conditions.push(`e.model_name = $${params.length}`); }
    if (status)        { params.push(status);        conditions.push(`e.status = $${params.length}`); }
    const whereExtra = conditions.length ? 'AND ' + conditions.join(' AND ') : '';

    const { rows } = await aitmPool.query(`
      SELECT
        e.id, e.user_id, u.name AS user_name, u.email AS user_email,
        e.source_service, e.feature_name, e.workflow_name, e.model_name,
        e.prompt_tokens, e.completion_tokens, e.total_tokens,
        e.cost_amount, e.status, e.latency_ms, e.execution_id, e.created_at
      FROM llm_usage_events e
      LEFT JOIN users u ON u.id = e.user_id
      WHERE e.created_at BETWEEN $1 AND $2 ${whereExtra}
      ORDER BY e.created_at DESC
      LIMIT $3 OFFSET $4
    `, params);

    const countParams = [periodFrom, periodTo, ...params.slice(4)];
    const countWhere = conditions.length ? 'AND ' + conditions.map((c, i) => c.replace(/\$\d+/, `$${i+3}`)).join(' AND ') : '';
    const countRes = await aitmPool.query(
      `SELECT COUNT(*) AS total FROM llm_usage_events e WHERE e.created_at BETWEEN $1 AND $2 ${whereExtra}`,
      params.slice(0, 2 + conditions.length)
    );

    res.json({
      items: rows.map(r => ({
        ...r,
        promptTokens: Number(r.prompt_tokens), completionTokens: Number(r.completion_tokens),
        totalTokens: Number(r.total_tokens), costAmount: parseFloat(r.cost_amount),
      })),
      total: Number(countRes.rows[0].total),
    });
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

    const { rows } = await aitmPool.query(`
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
    const { rows } = await aitmPool.query(`SELECT * FROM llm_service_registry ORDER BY source_service, service_name`);
    res.json({ items: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
