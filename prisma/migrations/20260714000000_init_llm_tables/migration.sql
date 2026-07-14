-- CreateTable
CREATE TABLE "llm_token_plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quotaType" TEXT NOT NULL,
    "quotaTokens" BIGINT NOT NULL,
    "priceAmount" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_token_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_plan_assignments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "reset_at" TIMESTAMP(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_plan_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_quota_bundles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "quota_tokens" BIGINT NOT NULL,
    "remaining_tokens" BIGINT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_quota_bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_usage_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "source_service" TEXT NOT NULL,
    "feature_name" TEXT,
    "workflow_name" TEXT,
    "execution_id" TEXT,
    "request_id" TEXT,
    "model_name" TEXT,
    "provider_name" TEXT,
    "prompt_tokens" BIGINT NOT NULL DEFAULT 0,
    "completion_tokens" BIGINT NOT NULL DEFAULT 0,
    "total_tokens" BIGINT NOT NULL DEFAULT 0,
    "cost_amount" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "cost_currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL,
    "latency_ms" INTEGER,
    "quota_source" TEXT,
    "metadata_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_usage_daily_aggregates" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "source_service" TEXT NOT NULL,
    "feature_name" TEXT,
    "total_tokens" BIGINT NOT NULL DEFAULT 0,
    "total_cost" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "rejected_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "llm_usage_daily_aggregates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_user_mappings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "goclaw_sender_id" TEXT,
    "goclaw_display_name" TEXT,
    "match_confidence" TEXT NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_user_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_service_registry" (
    "id" TEXT NOT NULL,
    "service_name" TEXT NOT NULL,
    "source_service" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "cost_per_hit" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "cost_currency" TEXT NOT NULL DEFAULT 'USD',
    "hit_limit_monthly" INTEGER,
    "cost_limit_monthly" DECIMAL(10,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "pricing_details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_service_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_internal_service_keys" (
    "id" TEXT NOT NULL,
    "service_name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_internal_service_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_audit_logs" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "before_json" JSONB,
    "after_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "llm_token_plans_name_key" ON "llm_token_plans"("name");

-- CreateIndex
CREATE INDEX "llm_plan_assignments_user_id_is_active_idx" ON "llm_plan_assignments"("user_id", "is_active");

-- CreateIndex
CREATE INDEX "llm_quota_bundles_user_id_idx" ON "llm_quota_bundles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "llm_usage_events_request_id_key" ON "llm_usage_events"("request_id");

-- CreateIndex
CREATE INDEX "llm_usage_events_user_id_created_at_idx" ON "llm_usage_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "llm_usage_events_source_service_created_at_idx" ON "llm_usage_events"("source_service", "created_at");

-- CreateIndex
CREATE INDEX "llm_usage_events_status_created_at_idx" ON "llm_usage_events"("status", "created_at");

-- CreateIndex
CREATE INDEX "llm_usage_events_feature_name_created_at_idx" ON "llm_usage_events"("feature_name", "created_at");

-- CreateIndex
CREATE INDEX "llm_usage_daily_aggregates_date_idx" ON "llm_usage_daily_aggregates"("date");

-- CreateIndex
CREATE UNIQUE INDEX "llm_usage_daily_aggregates_user_id_date_source_service_feat_key" ON "llm_usage_daily_aggregates"("user_id", "date", "source_service", "feature_name");

-- CreateIndex
CREATE UNIQUE INDEX "llm_user_mappings_user_id_key" ON "llm_user_mappings"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "llm_service_registry_service_name_key" ON "llm_service_registry"("service_name");

-- CreateIndex
CREATE INDEX "llm_audit_logs_actor_user_id_created_at_idx" ON "llm_audit_logs"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "llm_audit_logs_target_type_target_id_idx" ON "llm_audit_logs"("target_type", "target_id");

-- AddForeignKey
ALTER TABLE "llm_plan_assignments" ADD CONSTRAINT "llm_plan_assignments_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "llm_token_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

