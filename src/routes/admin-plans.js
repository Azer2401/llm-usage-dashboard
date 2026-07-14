'use strict';

const { Router } = require('express');
const { requireAuth, requireAdmin } = require('../auth');
const { aitmPool } = require('../db');

const router = Router();
router.use(requireAuth, requireAdmin);

// ─── Plans CRUD ───────────────────────────────────────────────────────────────
router.get('/plans', async (req, res) => {
  try {
    const { rows } = await aitmPool.query(`
      SELECT p.*,
             COUNT(a.id) AS assignment_count
      FROM llm_token_plans p
      LEFT JOIN llm_plan_assignments a ON a.plan_id = p.id AND a.is_active = true
      GROUP BY p.id ORDER BY p.created_at DESC
    `);
    res.json({ items: rows.map(r => ({ ...r, quotaTokens: Number(r.quota_tokens), assignmentCount: Number(r.assignment_count) })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/plans', async (req, res) => {
  try {
    const { name, quotaType, quotaTokens, priceAmount = 0, currency = 'IDR', description, isActive = true } = req.body;
    if (!name || !quotaType || !quotaTokens) return res.status(400).json({ error: 'name, quotaType, quotaTokens required' });
    if (!['MONTHLY', 'YEARLY'].includes(quotaType)) return res.status(400).json({ error: 'quotaType must be MONTHLY or YEARLY' });
    if (quotaTokens <= 0) return res.status(400).json({ error: 'quotaTokens must be > 0' });

    const { rows } = await aitmPool.query(`
      INSERT INTO llm_token_plans (id, name, quota_type, quota_tokens, price_amount, currency, description, is_active, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      RETURNING *
    `, [name, quotaType, quotaTokens, priceAmount, currency, description || null, isActive]);

    await aitmPool.query(`INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
      VALUES (gen_random_uuid(), $1, 'plan.create', 'llm_token_plan', $2, $3, NOW())`,
      [req.user.id, rows[0].id, JSON.stringify(rows[0])]);

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Plan name already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.patch('/plans/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, quotaTokens, priceAmount, currency, description, isActive } = req.body;

    const existing = await aitmPool.query(`SELECT * FROM llm_token_plans WHERE id = $1`, [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Plan not found' });

    const { rows } = await aitmPool.query(`
      UPDATE llm_token_plans
      SET name = COALESCE($1, name),
          quota_tokens = COALESCE($2, quota_tokens),
          price_amount = COALESCE($3, price_amount),
          currency = COALESCE($4, currency),
          description = COALESCE($5, description),
          is_active = COALESCE($6, is_active),
          updated_at = NOW()
      WHERE id = $7 RETURNING *
    `, [name, quotaTokens, priceAmount, currency, description, isActive, id]);

    await aitmPool.query(`INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, before_json, after_json, created_at)
      VALUES (gen_random_uuid(), $1, 'plan.update', 'llm_token_plan', $2, $3, $4, NOW())`,
      [req.user.id, id, JSON.stringify(existing.rows[0]), JSON.stringify(rows[0])]);

    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Plan Assignments ─────────────────────────────────────────────────────────
router.post('/assignments', async (req, res) => {
  try {
    const { userId, planId, startsAt } = req.body;
    if (!userId || !planId) return res.status(400).json({ error: 'userId and planId required' });

    // Validate user is HR/HM
    const userRes = await aitmPool.query(`
      SELECT u.id, ur.role_name FROM users u
      JOIN employees e ON e.user_id = u.id
      JOIN user_roles ur ON ur.id = e.user_role_id
      WHERE u.id = $1 AND ur.role_name IN ('HUMAN RESOURCES', 'HIRING MANAGER')
    `, [userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found or not HR/HM role' });

    // Validate plan is active
    const planRes = await aitmPool.query(`SELECT * FROM llm_token_plans WHERE id = $1 AND is_active = true`, [planId]);
    if (planRes.rows.length === 0) return res.status(400).json({ error: 'Plan not found or inactive' });
    const plan = planRes.rows[0];

    // Deactivate previous assignment
    await aitmPool.query(`
      UPDATE llm_plan_assignments SET is_active = false, ended_at = NOW(), updated_at = NOW()
      WHERE user_id = $1 AND is_active = true
    `, [userId]);

    // Calculate reset date
    const start = startsAt ? new Date(startsAt) : new Date();
    const reset = new Date(start);
    if (plan.quota_type === 'MONTHLY') { reset.setMonth(reset.getMonth() + 1); reset.setDate(1); reset.setHours(0,0,0,0); }
    else { reset.setFullYear(reset.getFullYear() + 1); reset.setMonth(0); reset.setDate(1); reset.setHours(0,0,0,0); }

    const { rows } = await aitmPool.query(`
      INSERT INTO llm_plan_assignments (id, user_id, plan_id, starts_at, reset_at, is_active, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, true, NOW(), NOW()) RETURNING *
    `, [userId, planId, start, reset]);

    await aitmPool.query(`INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
      VALUES (gen_random_uuid(), $1, 'plan.assign', 'llm_plan_assignment', $2, $3, NOW())`,
      [req.user.id, rows[0].id, JSON.stringify({ userId, planId, quotaType: plan.quota_type })]);

    res.status(201).json({ ...rows[0], planName: plan.name, quotaType: plan.quota_type, quotaTokens: Number(plan.quota_tokens) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Bundle Management ────────────────────────────────────────────────────────
router.post('/bundles', async (req, res) => {
  try {
    const { userId, quotaTokens, expiresAt, note } = req.body;
    if (!userId || !quotaTokens || quotaTokens <= 0) return res.status(400).json({ error: 'userId and quotaTokens > 0 required' });
    if (expiresAt && new Date(expiresAt) <= new Date()) return res.status(400).json({ error: 'expiresAt must be in the future' });

    const { rows } = await aitmPool.query(`
      INSERT INTO llm_quota_bundles (id, user_id, quota_tokens, remaining_tokens, expires_at, note, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $2, $3, $4, NOW(), NOW()) RETURNING *
    `, [userId, quotaTokens, expiresAt || null, note || null]);

    await aitmPool.query(`INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
      VALUES (gen_random_uuid(), $1, 'bundle.add', 'llm_quota_bundle', $2, $3, NOW())`,
      [req.user.id, rows[0].id, JSON.stringify({ userId, quotaTokens, expiresAt, note })]);

    res.status(201).json({ ...rows[0], quotaTokens: Number(rows[0].quota_tokens), remainingTokens: Number(rows[0].remaining_tokens) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/bundles/:userId', async (req, res) => {
  try {
    const { rows } = await aitmPool.query(`
      SELECT * FROM llm_quota_bundles WHERE user_id = $1 ORDER BY created_at DESC
    `, [req.params.userId]);
    res.json({ items: rows.map(r => ({ ...r, quotaTokens: Number(r.quota_tokens), remainingTokens: Number(r.remaining_tokens) })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Audit Log ────────────────────────────────────────────────────────────────
router.get('/audit', async (req, res) => {
  try {
    const { skip = 0, take = 50 } = req.query;
    const { rows } = await aitmPool.query(`
      SELECT a.*, u.name AS actor_name, u.email AS actor_email
      FROM llm_audit_logs a
      LEFT JOIN users u ON u.id = a.actor_user_id
      ORDER BY a.created_at DESC LIMIT $1 OFFSET $2
    `, [parseInt(take), parseInt(skip)]);
    res.json({ items: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── User Mappings ────────────────────────────────────────────────────────────
router.get('/mappings', async (req, res) => {
  try {
    // All HR/HM users with their mapping status
    const { rows } = await aitmPool.query(`
      SELECT
        u.id AS user_id, u.name, u.email, ur.role_name AS role,
        m.goclaw_sender_id, m.goclaw_display_name, m.match_confidence, m.updated_at AS mapped_at
      FROM users u
      JOIN employees emp ON emp.user_id = u.id
      JOIN user_roles ur ON ur.id = emp.user_role_id
      LEFT JOIN llm_user_mappings m ON m.user_id = u.id
      WHERE ur.role_name IN ('HUMAN RESOURCES', 'HIRING MANAGER')
      ORDER BY u.name
    `);
    res.json({ items: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/mappings', async (req, res) => {
  try {
    const { userId, goclawSenderId, goclawDisplayName } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const { rows } = await aitmPool.query(`
      INSERT INTO llm_user_mappings (id, user_id, goclaw_sender_id, goclaw_display_name, match_confidence, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, 'manual', NOW(), NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        goclaw_sender_id = EXCLUDED.goclaw_sender_id,
        goclaw_display_name = EXCLUDED.goclaw_display_name,
        match_confidence = 'manual',
        updated_at = NOW()
      RETURNING *
    `, [userId, goclawSenderId || null, goclawDisplayName || null]);

    await aitmPool.query(`INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
      VALUES (gen_random_uuid(), $1, 'mapping.update', 'llm_user_mapping', $2, $3, NOW())`,
      [req.user.id, userId, JSON.stringify({ userId, goclawSenderId })]);

    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get GoClaw contacts for mapping UI suggestions
router.get('/mappings/goclaw-contacts', async (req, res) => {
  try {
    const { goclawPool } = require('../db');
    const client = await goclawPool.connect();
    try {
      const { rows } = await client.query(`
        SELECT sender_id, display_name, channel_type, last_seen_at
        FROM channel_contacts WHERE contact_type = 'user'
        ORDER BY last_seen_at DESC LIMIT 100
      `);
      res.json({ items: rows });
    } finally { client.release(); }
  } catch (err) {
    res.status(200).json({ items: [], error: 'GoClaw DB not available' });
  }
});

// Manual throttle reset
router.post('/throttle/reset/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { runThrottleCheck } = require('../services/throttle');
    // Force-clear from config
    const { readGoclawConfig, writeGoclawConfig, reloadGoclaw } = require('../services/throttle');
    const mappingRes = await aitmPool.query(`SELECT goclaw_sender_id FROM llm_user_mappings WHERE user_id = $1`, [userId]);
    if (mappingRes.rows.length && mappingRes.rows[0].goclaw_sender_id) {
      const senderId = mappingRes.rows[0].goclaw_sender_id;
      const config = readGoclawConfig();
      delete config.gateway?.quota?.groups?.[`user:${senderId}`];
      writeGoclawConfig(config);
      reloadGoclaw();
    }
    res.json({ ok: true, message: 'Throttle reset' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manual throttle trigger
router.post('/throttle/run', async (req, res) => {
  try {
    const { runThrottleCheck } = require('../services/throttle');
    const result = await runThrottleCheck();
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
