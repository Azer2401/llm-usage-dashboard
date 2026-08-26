'use strict';

const { Router } = require('express');
const { requireAuth, requireAdmin } = require('../auth');
const { dashboardPool, aitmPool } = require('../db');

const router = Router();
router.use(requireAuth, requireAdmin);

// ─── Plans CRUD ───────────────────────────────────────────────────────────────
router.get('/plans', async (req, res) => {
  try {
    const { rows } = await dashboardPool.query(`
      SELECT p.*,
             COUNT(a.id) AS assignment_count
      FROM llm_token_plans p
      LEFT JOIN llm_plan_assignments a ON a.plan_id = p.id AND a.is_active = true
      GROUP BY p.id ORDER BY p.created_at DESC
    `);
    
    const items = [];
    for (const r of rows) {
      const { rows: svcs } = await dashboardPool.query(`
        SELECT ps.service_id, ps.hit_limit_monthly, ps.cost_limit_monthly,
               sr.service_name, sr.display_name
        FROM llm_plan_services ps
        JOIN llm_service_registry sr ON sr.id = ps.service_id
        WHERE ps.plan_id = $1
      `, [r.id]);
      
      items.push({
        ...r,
        quotaTokens: Number(r.quota_tokens),
        assignmentCount: Number(r.assignment_count),
        services: svcs.map(s => ({
          serviceId: s.service_id,
          serviceName: s.service_name,
          displayName: s.display_name,
          hitLimitMonthly: s.hit_limit_monthly,
          costLimitMonthly: s.cost_limit_monthly ? parseFloat(s.cost_limit_monthly) : null
        }))
      });
    }
    res.json({ items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/plans', async (req, res) => {
  const client = await dashboardPool.connect();
  try {
    await client.query('BEGIN');
    const { name, quotaType, quotaTokens, priceAmount = 0, currency = 'IDR', description, isActive = true, services = [] } = req.body;
    if (!name || !quotaType || !quotaTokens) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'name, quotaType, quotaTokens required' });
    }
    if (!['MONTHLY', 'YEARLY'].includes(quotaType)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'quotaType must be MONTHLY or YEARLY' });
    }
    if (quotaTokens <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'quotaTokens must be > 0' });
    }

    const { rows } = await client.query(`
      INSERT INTO llm_token_plans (id, name, quota_type, quota_tokens, price_amount, currency, description, is_active, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      RETURNING *
    `, [name, quotaType, quotaTokens, priceAmount, currency, description || null, isActive]);

    const plan = rows[0];
    plan.services = [];

    for (const svc of services) {
      const { serviceId, hitLimitMonthly, costLimitMonthly } = svc;
      const { rows: insertedSvc } = await client.query(`
        INSERT INTO llm_plan_services (id, plan_id, service_id, hit_limit_monthly, cost_limit_monthly, created_at, updated_at)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW(), NOW())
        RETURNING service_id, hit_limit_monthly, cost_limit_monthly
      `, [plan.id, serviceId, hitLimitMonthly !== undefined ? hitLimitMonthly : null, costLimitMonthly !== undefined ? costLimitMonthly : null]);
      
      plan.services.push(insertedSvc[0]);
    }

    await client.query(`INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
      VALUES (gen_random_uuid(), $1, 'plan.create', 'llm_token_plan', $2, $3, NOW())`,
      [req.user.id, plan.id, JSON.stringify(plan)]);

    await client.query('COMMIT');
    res.status(201).json(plan);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Plan name already exists' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.patch('/plans/:id', async (req, res) => {
  const client = await dashboardPool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { name, quotaTokens, priceAmount, currency, description, isActive, services } = req.body;

    const existing = await client.query(`SELECT * FROM llm_token_plans WHERE id = $1`, [id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Plan not found' });
    }

    const { rows } = await client.query(`
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

    if (services && Array.isArray(services)) {
      await client.query(`DELETE FROM llm_plan_services WHERE plan_id = $1`, [id]);
      for (const svc of services) {
        await client.query(`
          INSERT INTO llm_plan_services (id, plan_id, service_id, hit_limit_monthly, cost_limit_monthly, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW(), NOW())
        `, [id, svc.serviceId, svc.hitLimitMonthly !== undefined ? svc.hitLimitMonthly : null, svc.costLimitMonthly !== undefined ? svc.costLimitMonthly : null]);
      }
    }

    await client.query(`INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
      VALUES (gen_random_uuid(), $1, 'plan.update', 'llm_token_plan', $2, $3, NOW())`,
      [req.user.id, id, JSON.stringify(rows[0])]);

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── Plan Assignments ─────────────────────────────────────────────────────────
router.get('/assignments', async (req, res) => {
  try {
    const { rows } = await dashboardPool.query(`
      SELECT a.*, p.name AS plan_name, p.quota_type, p.quota_tokens
      FROM llm_plan_assignments a
      JOIN llm_token_plans p ON p.id = a.plan_id
      ORDER BY a.created_at DESC
    `);
    res.json({ items: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/assignments', async (req, res) => {
  try {
    const { userId, companyId, planId, startsAt } = req.body;
    if ((!userId && !companyId) || !planId) return res.status(400).json({ error: 'userId or companyId, and planId required' });

    if (userId) {
      const userRes = await aitmPool.query(`
        SELECT u.id, ur.role_name FROM users u
        JOIN employees e ON e.user_id = u.id
        JOIN user_roles ur ON ur.id = e.user_role_id
        WHERE u.id = $1 AND ur.role_name IN ('HUMAN RESOURCES', 'HIRING MANAGER')
      `, [userId]);
      if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found or not HR/HM role' });
    }
    if (companyId) {
      const compRes = await dashboardPool.query(`SELECT id FROM llm_companies WHERE id = $1 AND is_active = true`, [companyId]);
      if (compRes.rows.length === 0) return res.status(404).json({ error: 'Company not found or inactive' });
    }

    const planRes = await dashboardPool.query(`SELECT * FROM llm_token_plans WHERE id = $1 AND is_active = true`, [planId]);
    if (planRes.rows.length === 0) return res.status(400).json({ error: 'Plan not found or inactive' });
    const plan = planRes.rows[0];

    if (userId) {
      await dashboardPool.query(`UPDATE llm_plan_assignments SET is_active = false, ended_at = NOW(), updated_at = NOW() WHERE user_id = $1 AND is_active = true`, [userId]);
    }
    if (companyId) {
      await dashboardPool.query(`UPDATE llm_plan_assignments SET is_active = false, ended_at = NOW(), updated_at = NOW() WHERE company_id = $1 AND is_active = true`, [companyId]);
    }

    const start = startsAt ? new Date(startsAt) : new Date();
    const reset = new Date(start);
    if (plan.quota_type === 'MONTHLY') { reset.setMonth(reset.getMonth() + 1); reset.setDate(1); reset.setHours(0,0,0,0); }
    else { reset.setFullYear(reset.getFullYear() + 1); reset.setMonth(0); reset.setDate(1); reset.setHours(0,0,0,0); }

    const { rows } = await dashboardPool.query(`
      INSERT INTO llm_plan_assignments (id, user_id, company_id, plan_id, starts_at, reset_at, is_active, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, true, NOW(), NOW()) RETURNING *
    `, [userId || null, companyId || null, planId, start, reset]);

    await dashboardPool.query(`INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
      VALUES (gen_random_uuid(), $1, 'plan.assign', 'llm_plan_assignment', $2, $3, NOW())`,
      [req.user.id, rows[0].id, JSON.stringify({ userId, companyId, planId, quotaType: plan.quota_type })]);

    res.status(201).json({ ...rows[0], planName: plan.name, quotaType: plan.quota_type, quotaTokens: Number(plan.quota_tokens) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Bundle Management ────────────────────────────────────────────────────────
router.post('/bundles', async (req, res) => {
  try {
    const { userId, companyId, quotaTokens, expiresAt, note } = req.body;
    if ((!userId && !companyId) || !quotaTokens || quotaTokens <= 0) return res.status(400).json({ error: 'userId or companyId, and quotaTokens > 0 required' });
    if (expiresAt && new Date(expiresAt) <= new Date()) return res.status(400).json({ error: 'expiresAt must be in the future' });

    const { rows } = await dashboardPool.query(`
      INSERT INTO llm_quota_bundles (id, user_id, company_id, quota_tokens, remaining_tokens, expires_at, note, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, $3, $4, $5, NOW(), NOW()) RETURNING *
    `, [userId || null, companyId || null, quotaTokens, expiresAt || null, note || null]);

    await dashboardPool.query(`INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
      VALUES (gen_random_uuid(), $1, 'bundle.add', 'llm_quota_bundle', $2, $3, NOW())`,
      [req.user.id, rows[0].id, JSON.stringify({ userId, companyId, quotaTokens, expiresAt, note })]);

    res.status(201).json({ ...rows[0], quotaTokens: Number(rows[0].quota_tokens), remainingTokens: Number(rows[0].remaining_tokens) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/bundles/:userId', async (req, res) => {
  try {
    const { rows } = await dashboardPool.query(`
      SELECT * FROM llm_quota_bundles WHERE user_id = $1 ORDER BY created_at DESC
    `, [req.params.userId]);
    res.json({ items: rows.map(r => ({ ...r, quotaTokens: Number(r.quota_tokens), remainingTokens: Number(r.remaining_tokens) })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Audit Log ────────────────────────────────────────────────────────────────
router.get('/audit', async (req, res) => {
  try {
    const { skip = 0, take = 50 } = req.query;
    const { rows: logs } = await dashboardPool.query(`
      SELECT * FROM llm_audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2
    `, [parseInt(take), parseInt(skip)]);

    const actorIds = [...new Set(logs.map(l => l.actor_user_id).filter(id => id && id !== 'system'))];
    let userMap = {};
    if (actorIds.length > 0) {
      const { rows: users } = await aitmPool.query(`
        SELECT id, name, email FROM users WHERE id = ANY($1)
      `, [actorIds]);
      for (const u of users) userMap[u.id] = u;
    }

    const items = logs.map(l => ({
      ...l,
      actor_name: userMap[l.actor_user_id]?.name || (l.actor_user_id === 'system' ? 'System' : null),
      actor_email: userMap[l.actor_user_id]?.email || null,
    }));
    res.json({ items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── User Mappings ────────────────────────────────────────────────────────────
router.get('/mappings', async (req, res) => {
  try {
    const { rows: users } = await aitmPool.query(`
      SELECT
        u.id AS user_id, u.name, u.email, ur.role_name AS role
      FROM users u
      JOIN employees emp ON emp.user_id = u.id
      JOIN user_roles ur ON ur.id = emp.user_role_id
      WHERE ur.role_name IN ('HUMAN RESOURCES', 'HIRING MANAGER')
      ORDER BY u.name
    `);

    const { rows: mappings } = await dashboardPool.query(`
      SELECT user_id, goclaw_sender_id, goclaw_display_name, match_confidence, updated_at AS mapped_at, company_id
      FROM llm_user_mappings
    `);
    const mappingMap = new Map(mappings.map(m => [m.user_id, m]));

    const items = users.map(u => {
      const m = mappingMap.get(u.user_id) || {};
      return {
        ...u,
        goclaw_sender_id: m.goclaw_sender_id || null,
        goclaw_display_name: m.goclaw_display_name || null,
        match_confidence: m.match_confidence || null,
        mapped_at: m.mapped_at || null,
        company_id: m.company_id || null,
      };
    });
    res.json({ items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/mappings', async (req, res) => {
  try {
    const { userId, goclawSenderId, goclawDisplayName } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const { rows } = await dashboardPool.query(`
      INSERT INTO llm_user_mappings (id, user_id, goclaw_sender_id, goclaw_display_name, match_confidence, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, 'manual', NOW(), NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        goclaw_sender_id = EXCLUDED.goclaw_sender_id,
        goclaw_display_name = EXCLUDED.goclaw_display_name,
        match_confidence = 'manual',
        updated_at = NOW()
      RETURNING *
    `, [userId, goclawSenderId || null, goclawDisplayName || null]);

    await dashboardPool.query(`INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
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
    const { readGoclawConfig, writeGoclawConfig, reloadGoclaw } = require('../services/throttle');
    const mappingRes = await dashboardPool.query(`SELECT goclaw_sender_id FROM llm_user_mappings WHERE user_id = $1`, [userId]);
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

// ─── Company CRUD ─────────────────────────────────────────────────────────────
router.get('/companies', async (req, res) => {
  try {
    const { rows } = await dashboardPool.query(`
      SELECT c.*,
             COUNT(DISTINCT m.user_id) AS member_count,
             COUNT(DISTINCT a.id) FILTER (WHERE a.is_active = true) AS active_plans
      FROM llm_companies c
      LEFT JOIN llm_user_mappings m ON m.company_id = c.id
      LEFT JOIN llm_plan_assignments a ON a.company_id = c.id
      GROUP BY c.id ORDER BY c.name
    `);
    res.json({ items: rows.map(r => ({ ...r, memberCount: Number(r.member_count), activePlans: Number(r.active_plans) })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/companies', async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const { rows } = await dashboardPool.query(`
      INSERT INTO llm_companies (id, name, description, is_active, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, true, NOW(), NOW()) RETURNING *
    `, [name, description || null]);

    await dashboardPool.query(`INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
      VALUES (gen_random_uuid(), $1, 'company.create', 'llm_company', $2, $3, NOW())`,
      [req.user.id, rows[0].id, JSON.stringify(rows[0])]);

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Company name already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.patch('/companies/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, isActive } = req.body;
    const { rows } = await dashboardPool.query(`
      UPDATE llm_companies SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        is_active = COALESCE($3, is_active),
        updated_at = NOW()
      WHERE id = $4 RETURNING *
    `, [name, description, isActive, id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Company not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/companies/:id/members', async (req, res) => {
  try {
    const { rows: mappings } = await dashboardPool.query(`
      SELECT user_id, goclaw_sender_id, goclaw_display_name
      FROM llm_user_mappings
      WHERE company_id = $1
    `, [req.params.id]);

    if (mappings.length === 0) return res.json({ items: [] });
    const userIds = mappings.map(m => m.user_id);

    const { rows: users } = await aitmPool.query(`
      SELECT u.id AS user_id, u.name, u.email, ur.role_name AS role
      FROM users u
      JOIN employees e ON e.user_id = u.id
      JOIN user_roles ur ON ur.id = e.user_role_id
      WHERE u.id = ANY($1)
      ORDER BY u.name
    `, [userIds]);

    const mapDict = {};
    for (const m of mappings) mapDict[m.user_id] = m;

    const items = users.map(u => ({
      ...u,
      goclaw_sender_id: mapDict[u.user_id]?.goclaw_sender_id || null,
      goclaw_display_name: mapDict[u.user_id]?.goclaw_display_name || null,
    }));
    res.json({ items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update user mapping company
router.patch('/mappings/:userId/company', async (req, res) => {
  try {
    const { userId } = req.params;
    const { companyId } = req.body;
    const { rows } = await dashboardPool.query(`
      INSERT INTO llm_user_mappings (id, user_id, company_id, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, NOW(), NOW())
      ON CONFLICT (user_id) DO UPDATE SET company_id = $2, updated_at = NOW()
      RETURNING *
    `, [userId, companyId || null]);

    await aitmPool.query(`INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
      VALUES (gen_random_uuid(), $1, 'mapping.company', 'llm_user_mapping', $2, $3, NOW())`,
      [req.user.id, userId, JSON.stringify({ userId, companyId })]);

    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
