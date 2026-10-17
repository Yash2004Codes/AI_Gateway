-- ═══════════════════════════════════════════════════════
-- AI Gateway Database Schema
-- PostgreSQL 16 - ACID-compliant configuration & audit ledger
-- ═══════════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";

-- ─────────────────────────────────────────────
-- Tenants (Organizations using the gateway)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL UNIQUE,
    api_key_hash CHAR(64) NOT NULL UNIQUE,   -- SHA-256 hex of the raw key; raw key is never stored
    api_key_prefix VARCHAR(16) NOT NULL,     -- non-secret prefix for identifying a key in the UI
    tpm_limit INTEGER NOT NULL DEFAULT 10000,
    rpm_limit INTEGER NOT NULL DEFAULT 100,
    monthly_token_budget BIGINT DEFAULT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- LLM Providers (OpenAI, Anthropic, Gemini)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS providers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE,   -- 'openai', 'anthropic', 'gemini'
    display_name VARCHAR(255) NOT NULL,
    base_url VARCHAR(500) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    priority INTEGER NOT NULL DEFAULT 1,  -- Lower = higher priority
    health_status VARCHAR(50) NOT NULL DEFAULT 'healthy',  -- 'healthy','degraded','down'
    last_health_check TIMESTAMPTZ DEFAULT NULL,
    error_rate NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    avg_latency_ms INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- Models (GPT-4, Claude-3, etc.)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS models (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    context_window INTEGER NOT NULL DEFAULT 4096,
    input_cost_per_1k_tokens NUMERIC(10, 6) NOT NULL DEFAULT 0,
    output_cost_per_1k_tokens NUMERIC(10, 6) NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_default BOOLEAN NOT NULL DEFAULT false,  -- model used for this provider when none is requested
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(provider_id, name)
);

-- ─────────────────────────────────────────────
-- Routing Policies (Fallback chains per tenant)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS routing_policies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT false,
    strategy VARCHAR(50) NOT NULL DEFAULT 'priority',  -- 'priority','round_robin','lowest_latency'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- Routing Policy Steps (Ordered fallback chain)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS routing_policy_steps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    policy_id UUID NOT NULL REFERENCES routing_policies(id) ON DELETE CASCADE,
    model_id UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    step_order INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(policy_id, step_order)
);

-- ─────────────────────────────────────────────
-- ─────────────────────────────────────────────
-- Gateway Requests (Main audit ledger - Time-Partitioned by Range)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gateway_requests (
    id UUID NOT NULL DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    idempotency_key VARCHAR(128),
    job_id VARCHAR(128),
    status VARCHAR(50) NOT NULL DEFAULT 'pending',  -- pending,queued,processing,completed,failed
    priority INTEGER NOT NULL DEFAULT 5,

    -- Request metadata
    requested_model VARCHAR(255),
    system_prompt TEXT,
    user_message TEXT NOT NULL,
    max_tokens INTEGER DEFAULT 1024,

    -- Execution results
    provider_used VARCHAR(100),
    model_used VARCHAR(255),
    response_text TEXT,
    prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    estimated_cost_usd NUMERIC(10, 6) DEFAULT 0,

    -- Failover tracking
    attempt_count INTEGER NOT NULL DEFAULT 0,
    providers_tried JSONB DEFAULT '[]',

    -- Timing
    queued_at TIMESTAMPTZ,
    processing_started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    total_latency_ms INTEGER,

    -- Error details
    error_code VARCHAR(100),
    error_message TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Monthly partitions for gateway_requests
CREATE TABLE IF NOT EXISTS gateway_requests_2026_10 PARTITION OF gateway_requests
    FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS gateway_requests_2026_11 PARTITION OF gateway_requests
    FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS gateway_requests_default PARTITION OF gateway_requests DEFAULT;

-- ─────────────────────────────────────────────
-- Provider Health Events (Time-series log)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS provider_health_events (
    id BIGSERIAL PRIMARY KEY,
    provider_id UUID NOT NULL REFERENCES providers(id),
    event_type VARCHAR(50) NOT NULL,  -- 'success','error','timeout','rate_limit'
    status_code INTEGER,
    latency_ms INTEGER,
    error_message TEXT,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- Token Usage Ledger (Billing audit trail - Time-Partitioned by Range)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS token_usage_ledger (
    id BIGSERIAL,
    request_id UUID NOT NULL,
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    provider VARCHAR(100) NOT NULL,
    model VARCHAR(255) NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);

-- Monthly partitions for token_usage_ledger
CREATE TABLE IF NOT EXISTS token_usage_ledger_2026_10 PARTITION OF token_usage_ledger
    FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS token_usage_ledger_2026_11 PARTITION OF token_usage_ledger
    FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS token_usage_ledger_default PARTITION OF token_usage_ledger DEFAULT;

-- ─────────────────────────────────────────────
-- Users (Admin dashboard users)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'viewer',  -- 'admin','operator','viewer'
    tenant_id UUID REFERENCES tenants(id),
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- Indexes for performance
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_gateway_requests_tenant_id ON gateway_requests(tenant_id);
CREATE INDEX IF NOT EXISTS idx_gateway_requests_status ON gateway_requests(status);
CREATE INDEX IF NOT EXISTS idx_gateway_requests_created_at ON gateway_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gateway_requests_idempotency ON gateway_requests(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_token_usage_tenant_recorded ON token_usage_ledger(tenant_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_health_events_provider ON provider_health_events(provider_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_routing_policy_steps_policy ON routing_policy_steps(policy_id, step_order);

-- ─────────────────────────────────────────────
-- Auto-update updated_at trigger
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_tenants_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_providers_updated_at BEFORE UPDATE ON providers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_gateway_requests_updated_at BEFORE UPDATE ON gateway_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_routing_policies_updated_at BEFORE UPDATE ON routing_policies FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────────
-- Seed: Default providers
-- ─────────────────────────────────────────────
INSERT INTO providers (name, display_name, base_url, priority) VALUES
    ('openai', 'OpenAI', 'https://api.openai.com/v1', 1),
    ('anthropic', 'Anthropic', 'https://api.anthropic.com', 2),
    ('gemini', 'Google Gemini', 'https://generativelanguage.googleapis.com', 3)
ON CONFLICT (name) DO NOTHING;

-- Seed: Models
-- One default per provider is used for failover; prices are per 1K tokens and
-- drive cost accounting. Verify against vendor pricing pages before billing.
WITH openai_id AS (SELECT id FROM providers WHERE name = 'openai'),
     anthropic_id AS (SELECT id FROM providers WHERE name = 'anthropic'),
     gemini_id AS (SELECT id FROM providers WHERE name = 'gemini')
INSERT INTO models (provider_id, name, display_name, context_window, input_cost_per_1k_tokens, output_cost_per_1k_tokens, is_default)
VALUES
    ((SELECT id FROM openai_id), 'gpt-5-mini', 'GPT-5 Mini', 400000, 0.00025, 0.002, true),
    ((SELECT id FROM openai_id), 'gpt-5-nano', 'GPT-5 Nano', 400000, 0.00005, 0.0004, false),
    ((SELECT id FROM anthropic_id), 'claude-haiku-5-5', 'Claude Haiku 5.5', 200000, 0.001, 0.005, true),
    ((SELECT id FROM anthropic_id), 'claude-sonnet-5-5', 'Claude Sonnet 5.5', 200000, 0.003, 0.015, false),
    ((SELECT id FROM gemini_id), 'gemini-2.5-flash', 'Gemini 2.5 Flash', 1000000, 0.0003, 0.0025, true),
    ((SELECT id FROM gemini_id), 'gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 1000000, 0.0001, 0.0004, false)
ON CONFLICT (provider_id, name) DO NOTHING;

-- Seed: Demo tenant (raw key: demo-api-key-change-in-production)
INSERT INTO tenants (name, api_key_hash, api_key_prefix, tpm_limit, rpm_limit)
VALUES (
    'Demo Tenant',
    encode(sha256(convert_to('demo-api-key-change-in-production', 'UTF8')), 'hex'),
    'demo-api-ke',
    50000,
    500
)
ON CONFLICT (name) DO NOTHING;

-- Seed: Demo traffic tenants (used by the dashboard's Demo Control page).
-- Initech is deliberately the "noisy neighbour" with a tight RPM limit.
INSERT INTO tenants (name, api_key_hash, api_key_prefix, tpm_limit, rpm_limit)
VALUES
    ('Acme Corp', encode(sha256(convert_to('demo-key-acme', 'UTF8')), 'hex'), 'demo-key-ac', 60000, 600),
    ('Globex', encode(sha256(convert_to('demo-key-globex', 'UTF8')), 'hex'), 'demo-key-gl', 60000, 600),
    ('Initech (noisy)', encode(sha256(convert_to('demo-key-initech', 'UTF8')), 'hex'), 'demo-key-in', 25000, 200)
ON CONFLICT (name) DO NOTHING;

-- Seed: Admin user (password: admin123 - CHANGE IN PRODUCTION)
INSERT INTO users (email, password_hash, name, role)
VALUES (
    'admin@gateway.local',
    '$2a$10$NGRDuTd0Te5BvYNRTNjFjOFIpBQAh.Se4JS4X7T6WbQED4ccmUPd.',
    'System Admin',
    'admin'
)
ON CONFLICT (email) DO NOTHING;
