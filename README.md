# LLM Usage Dashboard

Centralized LLM token usage monitoring and control dashboard for:
- **AITM** (AI Talent Management backend — CV parsing, AI screening)
- **GoClaw** (Agentic HR WhatsApp assistant)
- **N8N** (Scout workflow — Apify + Serper)

## Architecture

```
AITM DB (ai_talent_db:5432)   ←─── All new llm_* tables + users/roles
GoClaw DB (pgvector:5433)     ←─── Read traces → sync to llm_usage_events
N8N Scout                     ───→ POST /api/internal/events (usage ingest)
GoClaw                        ───→ GET /api/internal/preflight (quota check)
```

## Enforcement: Universal GoClaw Throttle

**All limits** (tokens, bundles, N8N Scout hit count, N8N Scout cost) are enforced via a single mechanism:
- Every 5 minutes, cron reads all limits for HR/HM users
- If any limit is exceeded → writes to `config.json` + sends SIGHUP to GoClaw
- Auto-restores when new period starts or limits are relaxed

## Quick Start

```bash
# 1. Copy and edit environment
cp .env.example .env
# Edit GOCLAW_DB_PASSWORD, GOCLAW_PID, INTERNAL_KEY_* values

# 2. Run setup (migrate + seed)
node scripts/setup.js

# 3. Start dashboard
node server.js
# → http://localhost:3003

# Development (auto-restart)
npm run dev
```

## Manual DB Migration (if setup.js unavailable)

```bash
# On Windows (Docker container)
docker exec ai-talent-management-backend-db-1 psql -U postgres -d ai_talent_db < prisma/migrations/20260714_init_llm_tables/migration.sql
docker exec ai-talent-management-backend-db-1 psql -U postgres -d ai_talent_db < scripts/seed.sql
```

## API Endpoints

### Admin (requires HR JWT + role)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/overview` | Platform-wide usage summary + charts data |
| GET | `/api/admin/users` | All HR/HM users with quota status |
| GET | `/api/admin/users/:id` | Single user detail |
| GET | `/api/admin/events` | Raw usage events (paginated) |
| GET | `/api/admin/workflows` | Usage by workflow/feature |
| GET | `/api/admin/services` | Registered services (N8N Scout, etc.) |
| POST | `/api/admin/plans` | Create token plan |
| PATCH | `/api/admin/plans/:id` | Update token plan |
| POST | `/api/admin/assignments` | Assign plan to user |
| POST | `/api/admin/bundles` | Add one-time bundle |
| GET | `/api/admin/mappings` | AITM ↔ GoClaw user mappings |
| POST | `/api/admin/mappings` | Create/update user mapping |
| POST | `/api/admin/throttle/run` | Trigger manual throttle check |

### User (any HR/HM JWT)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/me/summary` | Own quota summary |
| GET | `/api/me/events` | Own usage history |
| GET | `/api/me/plan` | Own active plan |
| GET | `/api/me/bundles` | Own bundle balances |

### Internal (service key auth)
| Method | Path | Header |
|--------|------|--------|
| POST | `/api/internal/preflight` | `X-Internal-Service: n8n` + `X-Internal-Key: <key>` |
| POST | `/api/internal/events` | `X-Internal-Service: n8n` + `X-Internal-Key: <key>` |

## N8N Scout Integration

Add HTTP Request node at end of N8N Scout workflow:

```
POST http://<dashboard-host>:3003/api/internal/events
Headers:
  X-Internal-Service: n8n
  X-Internal-Key: <INTERNAL_KEY_N8N value>
Body:
{
  "userId": "{{ $json.userId }}",
  "sourceService": "N8N",
  "featureName": "n8n_scout",
  "workflowName": "n8n-scout",
  "executionId": "{{ $execution.id }}",
  "promptTokens": 0,
  "completionTokens": 0,
  "totalTokens": 0,
  "costAmount": 0.251,
  "status": "SUCCESS",
  "metadata": { "apifyRequests": 50, "serperQueries": 1 }
}
```

## User Mapping

Admin must manually link each HR/HM AITM user to their GoClaw WhatsApp sender_id:

1. Go to **User Mapping** tab
2. Find the AITM user row (Junior Diogones, Viranola Rizkiansha, etc.)
3. Click **Link** → pick from GoClaw contacts or enter sender_id manually
4. Save → throttle enforcement activates for that user

## Database Tables Created

```sql
llm_token_plans             -- Recurring quota plans (MONTHLY/YEARLY)
llm_plan_assignments        -- User ↔ Plan assignment
llm_quota_bundles           -- One-time token bundles
llm_usage_events            -- Main usage ledger (every LLM/API call)
llm_usage_daily_aggregates  -- Pre-computed daily summaries
llm_user_mappings           -- AITM User ↔ GoClaw WhatsApp sender_id
llm_service_registry        -- External services (n8n-scout, future MCPs)
llm_internal_service_keys   -- Auth keys for internal service APIs
llm_audit_logs              -- Admin action audit trail
```
