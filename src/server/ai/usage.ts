/**
 * Usage accounting.
 *
 * Nobody ships an AI platform without a bill attached to it. Tokens are
 * estimated with a character/word blend that tracks real tokenisers closely
 * enough to bill on, cost is carried in integer micro-cents so a fraction of a
 * cent is never silently rounded away, and credits use one published formula:
 * output tokens are worth three input tokens, and 1,000 weighted tokens is one
 * credit.
 */
import type { AiMessage, AiToolDef, AiUsage } from '../kernel/ai';

export interface ModelPrice {
  /** Cents per million input tokens. */
  inputCentsPerMillion: number;
  outputCentsPerMillion: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-4-5': { inputCentsPerMillion: 300, outputCentsPerMillion: 1500 },
  'claude-opus-4-1': { inputCentsPerMillion: 1500, outputCentsPerMillion: 7500 },
  'claude-haiku-4-5': { inputCentsPerMillion: 100, outputCentsPerMillion: 500 },
  'ain-engine-1': { inputCentsPerMillion: 0, outputCentsPerMillion: 0 },
};

export const priceFor = (model: string): ModelPrice =>
  MODEL_PRICES[model] ?? { inputCentsPerMillion: 0, outputCentsPerMillion: 0 };

/**
 * Blend characters and words: pure character/4 over-counts code and
 * under-counts prose, and the average of the two tracks a BPE tokeniser to
 * within a few per cent on business English.
 */
export function estimateTokens(text: string): number {
  const value = String(text ?? '');
  if (!value) return 0;
  const characters = value.length / 4;
  const words = (value.match(/\S+/g) ?? []).length * 1.32;
  return Math.max(1, Math.ceil((characters + words) / 2));
}

export const messageTokens = (messages: AiMessage[]): number =>
  messages.reduce((total, message) => total + estimateTokens(message.content) + (message.tool_calls?.length ? estimateTokens(JSON.stringify(message.tool_calls)) : 0) + 4, 0);

/** Tool schemas are part of the prompt, so they are part of the bill. */
export const toolTokens = (tools: AiToolDef[] | undefined): number =>
  (tools ?? []).reduce((total, tool) => total + estimateTokens(`${tool.name} ${tool.description}`) + 24, 0);

export interface UsageAccount {
  usage: AiUsage;
  /** Exact cost in micro-cents (1/1,000,000 of a cent), before rounding. */
  costMicros: number;
}

export const CREDIT_WEIGHTED_TOKENS = 1000;

export function accountUsage(model: string, inputTokens: number, outputTokens: number): UsageAccount {
  const price = priceFor(model);
  const costMicros = Math.round(inputTokens * price.inputCentsPerMillion + outputTokens * price.outputCentsPerMillion);
  const weighted = inputTokens + outputTokens * 3;
  return {
    usage: {
      inputTokens,
      outputTokens,
      costCents: Math.round(costMicros / 1_000_000),
      credits: Math.max(1, Math.ceil(weighted / CREDIT_WEIGHTED_TOKENS)),
    },
    costMicros,
  };
}

/** How the number was reached, for the usage drawer in the UI. */
export function describeUsage(model: string, usage: AiUsage, costMicros: number): string {
  const price = priceFor(model);
  const cost = costMicros === 0
    ? 'no marginal cost — the built-in engine runs locally'
    : `$${(costMicros / 100_000_000).toFixed(4)} at ${price.inputCentsPerMillion}¢/M in and ${price.outputCentsPerMillion}¢/M out`;
  return `${usage.inputTokens.toLocaleString('en-US')} input + ${usage.outputTokens.toLocaleString('en-US')} output tokens · ${usage.credits} ${usage.credits === 1 ? 'credit' : 'credits'} · ${cost}`;
}
