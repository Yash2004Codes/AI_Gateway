// ═══════════════════════════════════════════════════════
// LLM Provider Adapters
// Handles OpenAI, Anthropic, and Google Gemini
// Implements the circuit-breaker + failover pattern
// ═══════════════════════════════════════════════════════

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { logger } from '../utils/logger';
import { query, queryOne } from '../db/pool';
import { publishProviderHealth } from '../db/redis';
import { circuitBreaker } from '../utils/redisCircuitBreaker';

export interface LLMRequest {
  systemPrompt?: string;
  userMessage: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMResponse {
  provider: string;
  model: string;
  responseText: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  costUsd: number;
}

export interface ProviderInfo {
  id: string;
  name: string;
  displayName: string;
  priority: number;
  healthStatus: string;
  errorRate: number;
  avgLatencyMs: number;
}

// ─────────────────────────────────────────────
// Cost estimation per provider/model
// ─────────────────────────────────────────────
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 0.005, output: 0.015 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
  'claude-3-5-sonnet-20241022': { input: 0.003, output: 0.015 },
  'claude-3-haiku-20240307': { input: 0.00025, output: 0.00125 },
  'gemini-1.5-pro': { input: 0.00125, output: 0.005 },
  'gemini-1.5-flash': { input: 0.000075, output: 0.0003 },
};

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const costs = MODEL_COSTS[model] ?? { input: 0.001, output: 0.002 };
  return (promptTokens / 1000) * costs.input + (completionTokens / 1000) * costs.output;
}

// ─────────────────────────────────────────────
// OpenAI Adapter
// ─────────────────────────────────────────────
async function callOpenAI(model: string, request: LLMRequest): Promise<LLMResponse> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const start = Date.now();

  const messages: OpenAI.ChatCompletionMessageParam[] = [];
  if (request.systemPrompt) {
    messages.push({ role: 'system', content: request.systemPrompt });
  }
  messages.push({ role: 'user', content: request.userMessage });

  const response = await client.chat.completions.create({
    model,
    messages,
    max_tokens: request.maxTokens ?? 1024,
    temperature: request.temperature ?? 0.7,
  });

  const latencyMs = Date.now() - start;
  const usage = response.usage!;
  const responseText = response.choices[0]?.message?.content ?? '';

  return {
    provider: 'openai',
    model,
    responseText,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    latencyMs,
    costUsd: estimateCost(model, usage.prompt_tokens, usage.completion_tokens),
  };
}

// ─────────────────────────────────────────────
// Anthropic Adapter
// ─────────────────────────────────────────────
async function callAnthropic(model: string, request: LLMRequest): Promise<LLMResponse> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const start = Date.now();

  const response = await client.messages.create({
    model,
    max_tokens: request.maxTokens ?? 1024,
    system: request.systemPrompt,
    messages: [{ role: 'user', content: request.userMessage }],
  });

  const latencyMs = Date.now() - start;
  const responseText = response.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as Anthropic.TextBlock).text)
    .join('');

  const promptTokens = response.usage.input_tokens;
  const completionTokens = response.usage.output_tokens;

  return {
    provider: 'anthropic',
    model,
    responseText,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    latencyMs,
    costUsd: estimateCost(model, promptTokens, completionTokens),
  };
}

// ─────────────────────────────────────────────
// Google Gemini Adapter
// ─────────────────────────────────────────────
async function callGemini(model: string, request: LLMRequest): Promise<LLMResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  const start = Date.now();

  const contents = [];
  if (request.systemPrompt) {
    contents.push({ role: 'user', parts: [{ text: request.systemPrompt }] });
    contents.push({ role: 'model', parts: [{ text: 'Understood.' }] });
  }
  contents.push({ role: 'user', parts: [{ text: request.userMessage }] });

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 1024,
        temperature: request.temperature ?? 0.7,
      },
    },
    { timeout: 30000 }
  );

  const latencyMs = Date.now() - start;
  const candidate = response.data.candidates?.[0];
  const responseText = candidate?.content?.parts?.map((p: any) => p.text).join('') ?? '';
  const usage = response.data.usageMetadata ?? {};

  const promptTokens = usage.promptTokenCount ?? 0;
  const completionTokens = usage.candidatesTokenCount ?? 0;

  return {
    provider: 'gemini',
    model,
    responseText,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    latencyMs,
    costUsd: estimateCost(model, promptTokens, completionTokens),
  };
}

// ─────────────────────────────────────────────
// Record health event to DB
// ─────────────────────────────────────────────
async function recordHealthEvent(
  providerName: string,
  eventType: string,
  latencyMs: number | null,
  statusCode: number | null,
  errorMessage: string | null
): Promise<void> {
  try {
    const provider = await queryOne<{ id: string }>(
      'SELECT id FROM providers WHERE name = $1',
      [providerName]
    );
    if (!provider) return;

    await query(
      `INSERT INTO provider_health_events (provider_id, event_type, status_code, latency_ms, error_message)
       VALUES ($1, $2, $3, $4, $5)`,
      [provider.id, eventType, statusCode, latencyMs, errorMessage]
    );

    // Update provider rolling stats
    const stats = await queryOne<{ error_rate: number; avg_latency: number }>(
      `SELECT
         ROUND(100.0 * SUM(CASE WHEN event_type = 'error' THEN 1 ELSE 0 END) / COUNT(*), 2) AS error_rate,
         ROUND(AVG(latency_ms)) AS avg_latency
       FROM provider_health_events
       WHERE provider_id = $1 AND recorded_at > NOW() - INTERVAL '5 minutes'`,
      [provider.id]
    );

    const errorRate = stats?.error_rate ?? 0;
    const avgLatency = stats?.avg_latency ?? 0;
    const healthStatus =
      errorRate > 50 ? 'down' : errorRate > 20 ? 'degraded' : 'healthy';

    await query(
      `UPDATE providers SET health_status = $1, error_rate = $2, avg_latency_ms = $3, last_health_check = NOW()
       WHERE id = $4`,
      [healthStatus, errorRate, avgLatency, provider.id]
    );

    // Broadcast health update via Redis pub/sub
    await publishProviderHealth({
      provider: providerName,
      healthStatus,
      errorRate,
      avgLatencyMs: avgLatency,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Failed to record health event', { error: (err as Error).message });
  }
}

// ─────────────────────────────────────────────
// SSRF Protection: validate provider URLs
// Restrict to known public domains only
// ─────────────────────────────────────────────
const ALLOWED_PROVIDER_DOMAINS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'bedrock-runtime.amazonaws.com',
];

export function isAllowedProviderUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Block private/internal IP ranges (SSRF protection)
    const hostname = parsed.hostname;
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('10.') ||
      hostname.startsWith('172.16.') ||
      hostname.startsWith('192.168.') ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.local')
    ) {
      return false;
    }
    return ALLOWED_PROVIDER_DOMAINS.some((d) => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// Main Dispatcher: Try providers in priority order
// ─────────────────────────────────────────────
export async function dispatchToProvider(
  requestedModel: string | undefined,
  request: LLMRequest,
  tenantId: string
): Promise<LLMResponse & { providersTried: string[] }> {
  // Get ordered provider fallback chain
  const providers = await query<{
    name: string;
    health_status: string;
    priority: number;
    model_name: string;
  }>(
    `SELECT p.name, p.health_status, p.priority, m.name AS model_name
     FROM providers p
     JOIN models m ON m.provider_id = p.id
     WHERE p.is_active = true AND m.is_active = true
     ORDER BY p.priority ASC, p.avg_latency_ms ASC`
  );

  if (providers.length === 0) {
    throw new Error('No active providers configured');
  }

  // If a specific model is requested, prefer its provider first
  let orderedProviders = [...providers];
  if (requestedModel) {
    orderedProviders = [
      ...providers.filter((p) => p.model_name === requestedModel),
      ...providers.filter((p) => p.model_name !== requestedModel),
    ];
  }

  const providersTried: string[] = [];
  let lastError: Error | null = null;

  for (const provider of orderedProviders) {
    // Check Redis-backed Circuit Breaker state (CLOSED, OPEN, HALF_OPEN)
    const canExecute = await circuitBreaker.canExecute(provider.name);
    if (!canExecute || provider.health_status === 'down') {
      logger.warn(`Skipping provider ${provider.name} - Circuit Breaker OPEN or HALF_OPEN limit reached`);
      continue;
    }

    const providerKey = `${provider.name}/${provider.model_name}`;
    if (providersTried.includes(providerKey)) continue;
    providersTried.push(providerKey);

    try {
      logger.info(`Attempting provider ${provider.name} with model ${provider.model_name}`);
      let result: LLMResponse;

      switch (provider.name) {
        case 'openai':
          result = await callOpenAI(provider.model_name, request);
          break;
        case 'anthropic':
          result = await callAnthropic(provider.model_name, request);
          break;
        case 'gemini':
          result = await callGemini(provider.model_name, request);
          break;
        default:
          throw new Error(`Unknown provider: ${provider.name}`);
      }

      // Record success in Circuit Breaker state machine (recovers HALF_OPEN -> CLOSED)
      await circuitBreaker.recordSuccess(provider.name);
      await recordHealthEvent(provider.name, 'success', result.latencyMs, 200, null);
      logger.info(`Provider ${provider.name} succeeded`, {
        model: result.model,
        latencyMs: result.latencyMs,
        tokens: result.totalTokens,
      });

      return { ...result, providersTried };
    } catch (err: any) {
      lastError = err;
      const statusCode = err?.status ?? err?.response?.status ?? null;
      const isRateLimit = statusCode === 429 || statusCode === 529;
      const eventType = isRateLimit ? 'rate_limit' : 'error';

      logger.warn(`Provider ${provider.name} failed`, {
        error: err.message,
        statusCode,
        eventType,
      });

      // Record failure in Circuit Breaker (CLOSED -> OPEN or HALF_OPEN -> OPEN)
      await circuitBreaker.recordFailure(provider.name, err.message);
      await recordHealthEvent(provider.name, eventType, null, statusCode, err.message);

      // Continue to next provider (failover)
    }
  }

  throw new Error(
    `All providers failed. Tried: ${providersTried.join(', ')}. Last error: ${lastError?.message}`
  );
}
