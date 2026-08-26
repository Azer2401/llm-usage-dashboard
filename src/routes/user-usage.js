'use strict';

const { Router } = require('express');
const { requireAuth, requireHRorHM } = require('../auth');
const { dashboardPool } = require('../db');
const { getUserQuotaSummary } = require('../services/quota');

const router = Router();
router.use(requireAuth, requireHRorHM);

// ─── GET /api/me/summary ──────────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const userId = req.user.id;
    const summary = await getUserQuotaSummary(userId);

    // Usage this period
    const periodFrom = summary.assignment?.starts_at || new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const usageRes = await dashboardPool.query(`
      SELECT
        COALESCE(SUM(total_tokens), 0)                               AS total_tokens,
        COUNT(*) FILTER (WHERE status = 'SUCCESS')                   AS successful_requests,
        COUNT(*) FILTER (WHERE status = 'FAILED')                    AS failed_requests,
        COUNT(*) FILTER (WHERE status = 'REJECTED')                  AS rejected_requests
      FROM llm_usage_events
      WHERE user_id = $1 AND created_at >= $2
    `, [userId, periodFrom]);

    // Quota status badge
    const pct = summary.planQuota > 0 ? (summary.usedRecurringTokens / summary.planQuota) * 100 : 0;
    let quotaStatus = 'NO_PLAN';
    if (summary.planQuota > 0 || summary.remainingBundleTokens > 0) {
      if (summary.totalRemainingTokens === 0) quotaStatus = 'EXHAUSTED';
      else if (pct >= 90) quotaStatus = 'CRITICAL';
      else if (pct >= 70) quotaStatus = 'WARNING';
      else quotaStatus = 'HEALTHY';
    }

    const usage = usageRes.rows[0];
    res.json({
      userId,
      plan: summary.assignment ? {
        name:       summary.assignment.plan_name,
        quotaType:  summary.assignment.quota_type,
        quotaTokens: Number(summary.assignment.quota_tokens),
        startsAt:   summary.assignment.starts_at,
        resetAt:    summary.assignment.reset_at,
      } : null,
      quota: {
        usedRecurringTokens:      summary.usedRecurringTokens,
        remainingRecurringTokens: summary.remainingRecurringTokens,
        remainingBundleTokens:    summary.remainingBundleTokens,
        totalRemainingTokens:     summary.totalRemainingTokens,
        planQuota:                summary.planQuota,
        usagePercentage:          Math.min(100, Math.round(pct)),
        quotaStatus,
      },
      bundles: summary.bundles.map(b => ({
        id:              b.id,
        quotaTokens:     Number(b.quota_tokens),
        remainingTokens: Number(b.remaining_tokens),
        expiresAt:       b.expires_at,
      })),
      usageThisPeriod: {
        totalTokens:        Number(usage.total_tokens),
        successfulRequests: Number(usage.successful_requests),
        failedRequests:     Number(usage.failed_requests),
        rejectedRequests:   Number(usage.rejected_requests),
      },
    });
  } catch (err) {
    console.error('[User] GET /me/summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/me/events ───────────────────────────────────────────────────────
router.get('/events', async (req, res) => {
  try {
    const userId = req.user.id; // NEVER accept userId from query params on /me routes
    const { from, to, sourceService, featureName, workflowName, status, skip = 0, take = 20 } = req.query;
    const periodFrom = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const periodTo   = to   || new Date().toISOString();

    const params = [userId, periodFrom, periodTo, parseInt(take), parseInt(skip)];
    const conditions = [];
    if (sourceService) { params.push(sourceService); conditions.push(`source_service = $${params.length}`); }
    if (featureName)   { params.push(featureName);   conditions.push(`feature_name = $${params.length}`); }
    if (workflowName)  { params.push(workflowName);  conditions.push(`workflow_name = $${params.length}`); }
    if (status)        { params.push(status);        conditions.push(`status = $${params.length}`); }
    const whereExtra = conditions.length ? 'AND ' + conditions.join(' AND ') : '';

    const { rows } = await dashboardPool.query(`
      SELECT id, source_service, feature_name, workflow_name, model_name,
             prompt_tokens, completion_tokens, total_tokens, cost_amount,
             status, latency_ms, created_at
      FROM llm_usage_events
      WHERE user_id = $1 AND created_at BETWEEN $2 AND $3 ${whereExtra}
      ORDER BY created_at DESC LIMIT $4 OFFSET $5
    `, params);

    const countRes = await dashboardPool.query(`
      SELECT COUNT(*) AS total FROM llm_usage_events
      WHERE user_id = $1 AND created_at BETWEEN $2 AND $3 ${whereExtra}
    `, params.slice(0, 3 + conditions.length));

    res.json({
      items: rows.map(r => ({
        ...r,
        promptTokens: Number(r.prompt_tokens), completionTokens: Number(r.completion_tokens),
        totalTokens: Number(r.total_tokens), costAmount: parseFloat(r.cost_amount),
      })),
      total: Number(countRes.rows[0].total),
    });
  } catch (err) {
    console.error('[User] GET /me/events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/me/plan ─────────────────────────────────────────────────────────
router.get('/plan', async (req, res) => {
  try {
    const userId = req.user.id;
    const { rows } = await dashboardPool.query(`
      SELECT a.id, a.plan_id, p.name, p.quota_type, p.quota_tokens, a.starts_at, a.reset_at
      FROM llm_plan_assignments a
      JOIN llm_token_plans p ON p.id = a.plan_id
      WHERE a.user_id = $1 AND a.is_active = true LIMIT 1
    `, [userId]);
    if (rows.length === 0) return res.status(404).json({ error: 'No active plan' });
    const r = rows[0];
    res.json({ ...r, quotaTokens: Number(r.quota_tokens) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/me/bundles ──────────────────────────────────────────────────────
router.get('/bundles', async (req, res) => {
  try {
    const userId = req.user.id;
    const { rows } = await dashboardPool.query(`
      SELECT id, quota_tokens, remaining_tokens, expires_at, note, created_at,
             CASE
               WHEN remaining_tokens = 0 THEN 'EXHAUSTED'
               WHEN expires_at IS NOT NULL AND expires_at <= NOW() THEN 'EXPIRED'
               ELSE 'ACTIVE'
             END AS bundle_status
      FROM llm_quota_bundles WHERE user_id = $1 ORDER BY created_at DESC
    `, [userId]);
    res.json({ items: rows.map(r => ({ ...r, quotaTokens: Number(r.quota_tokens), remainingTokens: Number(r.remaining_tokens) })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
