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

// ─────────────────────────────────────────────
// Contract every provider must follow
// ─────────────────────────────────────────────
export interface LLMProvider {
  readonly name: string;
  complete(model: string, request: LLMRequest): Promise<LLMResponse>;
}

// ─────────────────────────────────────────────
// Abstract base: shared logic (timing + cost) lives in ONE place
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

type RawResult = { responseText: string; promptTokens: number; completionTokens: number };

abstract class BaseLLMProvider implements LLMProvider {
  abstract readonly name: string;

  // Each vendor only implements this: call the API, return text + token counts
  protected abstract call(model: string, request: LLMRequest): Promise<RawResult>;

  // Template method: same steps for every vendor
  async complete(model: string, request: LLMRequest): Promise<LLMResponse> {
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
      costUsd: this.estimateCost(model, raw.promptTokens, raw.completionTokens),
    };
  }

  private estimateCost(model: string, promptTokens: number, completionTokens: number): number {
    const costs = MODEL_COSTS[model] ?? { input: 0.001, output: 0.002 };
    return (promptTokens / 1000) * costs.input + (completionTokens / 1000) * costs.output;
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

    const response = await client.chat.completions.create({
      model,
      messages,
      max_tokens: request.maxTokens ?? 1024,
      temperature: request.temperature ?? 0.7,
    });

    return {
      responseText: response.choices[0]?.message?.content ?? '',
      promptTokens: response.usage!.prompt_tokens,
      completionTokens: response.usage!.completion_tokens,
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
    const apiKey = process.env.GEMINI_API_KEY;
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

    const candidate = response.data.candidates?.[0];
    const usage = response.data.usageMetadata ?? {};
    return {
      responseText: candidate?.content?.parts?.map((p: any) => p.text).join('') ?? '',
      promptTokens: usage.promptTokenCount ?? 0,
      completionTokens: usage.candidatesTokenCount ?? 0,
    };
  }
}

// ─────────────────────────────────────────────
// Mock vendor: lets the full pipeline (queue, failover, ledger, dashboard)
// run without real vendor keys. Enabled with LLM_MOCK_MODE=true.
// ─────────────────────────────────────────────
export class MockProvider extends BaseLLMProvider {
  constructor(readonly name: string) {
    super();
  }

  protected async call(model: string, request: LLMRequest): Promise<RawResult> {
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 600));
    const failureRate = Number(process.env.LLM_MOCK_FAILURE_RATE ?? 0);
    if (Math.random() < failureRate) {
      throw Object.assign(new Error(`[mock] simulated ${this.name} outage`), { status: 503 });
    }

    const responseText = `[mock ${this.name}/${model}] You said: "${request.userMessage.slice(0, 200)}"`;
    return {
      responseText,
      promptTokens: Math.ceil(((request.systemPrompt?.length ?? 0) + request.userMessage.length) / 4),
      completionTokens: Math.ceil(responseText.length / 4),
    };
  }
}

// ─────────────────────────────────────────────
// Registry: look up a provider by name (no if/else or switch needed)
// ─────────────────────────────────────────────
const registry = new Map<string, LLMProvider>(
  [new OpenAIProvider(), new AnthropicProvider(), new GeminiProvider()].map((p) => [p.name, p])
);

export function getProvider(name: string): LLMProvider {
  if (process.env.LLM_MOCK_MODE === 'true') return new MockProvider(name);
  const provider = registry.get(name);
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  return provider;
}
