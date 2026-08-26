-- ============================================================
-- LLM Usage Dashboard — Seed Script
-- Run AFTER prisma migrate deploy
-- Target DB: ai_talent_db (AITM PostgreSQL :5432)
-- ============================================================

-- ─── 1. LLM Permissions ──────────────────────────────────────────────────────
INSERT INTO permissions (id, permission_name, description, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'llm.dashboard.read.self',         'View own LLM token usage and quota',                NOW(), NOW()),
  (gen_random_uuid(), 'llm.dashboard.read.all',          'View all users LLM token usage and quota',          NOW(), NOW()),
  (gen_random_uuid(), 'llm.plan.create',                  'Create LLM token plans',                            NOW(), NOW()),
  (gen_random_uuid(), 'llm.plan.update',                  'Update LLM token plans',                            NOW(), NOW()),
  (gen_random_uuid(), 'llm.plan.assign',                  'Assign LLM plans to users',                         NOW(), NOW()),
  (gen_random_uuid(), 'llm.quota.bundle.add',             'Add one-time token bundles to users',               NOW(), NOW()),
  (gen_random_uuid(), 'llm.usage.export.self',            'Export own LLM usage report as CSV',                NOW(), NOW()),
  (gen_random_uuid(), 'llm.usage.export.all',             'Export all users LLM usage report as CSV',          NOW(), NOW()),
  (gen_random_uuid(), 'llm.usage.internal.ingest',        'Internal: submit LLM usage events',                 NOW(), NOW()),
  (gen_random_uuid(), 'llm.usage.internal.preflight',     'Internal: run quota preflight check',               NOW(), NOW())
ON CONFLICT DO NOTHING;

-- ─── 2. Assign all LLM permissions to HUMAN RESOURCES role ───────────────────
INSERT INTO role_permissions (id, user_role_id, permission_id, created_at, updated_at)
SELECT
  gen_random_uuid(),
  ur.id,
  p.id,
  NOW(),
  NOW()
FROM user_roles ur
CROSS JOIN permissions p
WHERE ur.role_name = 'HUMAN RESOURCES'
  AND p.permission_name LIKE 'llm.%'
ON CONFLICT DO NOTHING;

-- ─── 3. Assign read-self and export-self to HIRING MANAGER ───────────────────
INSERT INTO role_permissions (id, user_role_id, permission_id, created_at, updated_at)
SELECT
  gen_random_uuid(),
  ur.id,
  p.id,
  NOW(),
  NOW()
FROM user_roles ur
CROSS JOIN permissions p
WHERE ur.role_name = 'HIRING MANAGER'
  AND p.permission_name IN ('llm.dashboard.read.self', 'llm.usage.export.self')
ON CONFLICT DO NOTHING;

-- ─── 4. N8N Scout Service Registry ───────────────────────────────────────────
INSERT INTO llm_service_registry (
  id, service_name, source_service, display_name, description,
  cost_per_hit, cost_currency,
  hit_limit_monthly, cost_limit_monthly,
  is_active, pricing_details, created_at, updated_at
)
VALUES (
  gen_random_uuid(),
  'n8n_scout',
  'N8N',
  'N8N Scout',
  'LinkedIn profile scraping (Apify) + Google search (Serper). Max 50 profiles per hit, 1 search query per hit.',
  0.251000,
  'USD',
  NULL,     -- hit_limit_monthly: set per-user in plans
  NULL,     -- cost_limit_monthly: set per-user in plans
  true,
  '{
    "apify": {
      "service": "LinkedIn Profile Scraper",
      "price_per_1000_requests": 5.00,
      "requests_per_hit": 50,
      "cost_per_hit": 0.250
    },
    "serper": {
      "service": "Google Search API",
      "price_per_1000_queries": 1.00,
      "queries_per_hit": 1,
      "cost_per_hit": 0.001
    },
    "total_cost_per_hit": 0.251
  }'::jsonb,
  NOW(), NOW()
)
ON CONFLICT (service_name) DO NOTHING;

-- ─── 5. Known User Mappings (AITM ↔ GoClaw WhatsApp) ─────────────────────────
-- Based on existing implementation_plan.md matches
-- These are the AITM user UUIDs from the live database
INSERT INTO llm_user_mappings (id, user_id, goclaw_sender_id, goclaw_display_name, match_confidence, created_at, updated_at)
VALUES
  -- Awis Rahmat Trihari (HUMAN RESOURCES)
  (gen_random_uuid(), '25e7ac05-d9fd-47fe-a915-f502deb16311', '78958745890892:65@lid', 'Awis',          'auto', NOW(), NOW()),
  -- Siva Syarafina (HUMAN RESOURCES) — email mismatch noted
  (gen_random_uuid(), 'db988700-b2e3-4e5d-98a6-f79772518c3d', '66688108224636@lid',    'sivasyarafina16','auto', NOW(), NOW())
  -- Note: Sahla Sholiha's GoClaw sender_id needs verification
  -- Note: Junior Diogones (Dio) and Viranola (Ara) need manual confirmation
ON CONFLICT (user_id) DO NOTHING;

-- ─── 6. Default Token Plan Example ───────────────────────────────────────────
-- Create a starter monthly plan
INSERT INTO llm_token_plans (id, name, "quotaType", "quotaTokens", "priceAmount", currency, description, "isActive", created_at, updated_at)
VALUES (
  gen_random_uuid(),
  'Monthly Standard',
  'MONTHLY',
  500000,
  0,
  'IDR',
  'Standard monthly quota for HR team members — 500K tokens/month',
  true,
  NOW(), NOW()
)
ON CONFLICT (name) DO NOTHING;
