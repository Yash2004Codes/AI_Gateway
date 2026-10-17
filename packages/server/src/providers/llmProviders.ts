// ═══════════════════════════════════════════════════════
// LLM Providers - OOP design
// One interface, one abstract base class, one class per vendor.
// Adding a new vendor = add one class + register it. The dispatcher
// (failover logic) never changes.
// ═══════════════════════════════════════════════════════

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import type { LLMRequest, LLMResponse } from './dispatcher';

// Per-1K-token prices, read from the models table by the dispatcher
export interface ModelPricing {
  inputPer1k: number;
  outputPer1k: number;
}

// ─────────────────────────────────────────────
// Contract every provider must follow
// ─────────────────────────────────────────────
export interface LLMProvider {
  readonly name: string;
  readonly mode: 'live' | 'mock';
  complete(model: string, request: LLMRequest, pricing: ModelPricing): Promise<LLMResponse>;
}

type RawResult = { responseText: string; promptTokens: number; completionTokens: number };

// ─────────────────────────────────────────────
// Abstract base: shared logic (timing + cost) lives in ONE place
// ─────────────────────────────────────────────
abstract class BaseLLMProvider implements LLMProvider {
  abstract readonly name: string;
  readonly mode: 'live' | 'mock' = 'live';

  // Each vendor only implements this: call the API, return text + token counts
  protected abstract call(model: string, request: LLMRequest): Promise<RawResult>;

  // Template method: same steps for every vendor
  async complete(model: string, request: LLMRequest, pricing: ModelPricing): Promise<LLMResponse> {
    const start = Date.now();
    const raw = await this.call(model, request);
    return {
      provider: this.name,
      model,
      responseText: raw.responseText,
      promptTokens: raw.promptTokens,
      completionTokens: raw.completionTokens,
      totalTokens: raw.promptTokens + raw.completionTokens,
      latencyMs: Date.now() - start,
      costUsd:
        (raw.promptTokens / 1000) * pricing.inputPer1k +
        (raw.completionTokens / 1000) * pricing.outputPer1k,
    };
  }
}

// ─────────────────────────────────────────────
// Vendors
// ─────────────────────────────────────────────
export class OpenAIProvider extends BaseLLMProvider {
  readonly name = 'openai';

  protected async call(model: string, request: LLMRequest): Promise<RawResult> {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const messages: OpenAI.ChatCompletionMessageParam[] = [];
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    messages.push({ role: 'user', content: request.userMessage });

    // GPT-5 family: max_completion_tokens replaces max_tokens, and only the
    // default temperature is accepted
    const isReasoningModel = model.startsWith('gpt-5') || model.startsWith('o');
    const response = await client.chat.completions.create({
      model,
      messages,
      ...(isReasoningModel
        ? { max_completion_tokens: request.maxTokens ?? 1024 }
        : { max_tokens: request.maxTokens ?? 1024, temperature: request.temperature ?? 0.7 }),
    } as OpenAI.ChatCompletionCreateParamsNonStreaming);

    return {
      responseText: response.choices[0]?.message?.content ?? '',
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
    };
  }
}

export class AnthropicProvider extends BaseLLMProvider {
  readonly name = 'anthropic';

  protected async call(model: string, request: LLMRequest): Promise<RawResult> {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model,
      max_tokens: request.maxTokens ?? 1024,
      system: request.systemPrompt,
      messages: [{ role: 'user', content: request.userMessage }],
    });

    return {
      responseText: response.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as Anthropic.TextBlock).text)
        .join(''),
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    };
  }
}

export class GeminiProvider extends BaseLLMProvider {
  readonly name = 'gemini';

  protected async call(model: string, request: LLMRequest): Promise<RawResult> {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        ...(request.systemPrompt && {
          systemInstruction: { parts: [{ text: request.systemPrompt }] },
        }),
        contents: [{ role: 'user', parts: [{ text: request.userMessage }] }],
        generationConfig: {
          maxOutputTokens: request.maxTokens ?? 1024,
          temperature: request.temperature ?? 0.7,
        },
      },
      // Key in a header rather than the query string, so it never lands in URL logs
      { timeout: 30000, headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '' } }
    );

    const candidate = response.data.candidates?.[0];
    const usage = response.data.usageMetadata ?? {};
    return {
      responseText: candidate?.content?.parts?.map((p: any) => p.text).join('') ?? '',
      promptTokens: usage.promptTokenCount ?? 0,
      completionTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    };
  }
}

// ─────────────────────────────────────────────
// Mock vendor: lets the full pipeline (queue, failover, ledger, dashboard)
// run without real vendor keys.
// ─────────────────────────────────────────────
export class MockProvider extends BaseLLMProvider {
  readonly mode = 'mock' as const;

  constructor(readonly name: string) {
    super();
  }

  protected async call(model: string, request: LLMRequest): Promise<RawResult> {
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
    const failureRate = Number(process.env.LLM_MOCK_FAILURE_RATE ?? 0);
    if (Math.random() < failureRate) {
      throw Object.assign(new Error(`[mock] simulated ${this.name} outage`), { status: 503 });
    }

    const responseText = `[mock ${this.name}/${model}] You said: "${request.userMessage.slice(0, 200)}"`;
    return {
      responseText,
      promptTokens: Math.ceil(((request.systemPrompt?.length ?? 0) + request.userMessage.length) / 4),
      completionTokens: Math.min(request.maxTokens ?? 1024, 40 + Math.floor(Math.random() * 160)),
    };
  }
}

// ─────────────────────────────────────────────
// Registry: look up a provider by name (no if/else or switch needed)
//
// LLM_MOCK_MODE:
//   auto  (default) → live if that vendor's API key is configured, else mock
//   true            → every vendor is mocked
//   false           → every vendor is live (missing keys fail and fail over)
// ─────────────────────────────────────────────
const registry = new Map<string, LLMProvider>(
  [new OpenAIProvider(), new AnthropicProvider(), new GeminiProvider()].map((p) => [p.name, p])
);
const mocks = new Map<string, LLMProvider>();

const API_KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

function hasRealKey(name: string): boolean {
  const value = process.env[API_KEY_ENV[name] ?? ''];
  return !!value && !/your-|-here|changeme/i.test(value);
}

export function getProvider(name: string): LLMProvider {
  const mode = (process.env.LLM_MOCK_MODE ?? 'auto').toLowerCase();
  const useMock = mode === 'true' || (mode === 'auto' && !hasRealKey(name));

  if (useMock) {
    if (!mocks.has(name)) mocks.set(name, new MockProvider(name));
    return mocks.get(name)!;
  }
  const provider = registry.get(name);
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  return provider;
}
