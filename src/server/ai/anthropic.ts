/**
 * The hosted provider.
 *
 * When `ANTHROPIC_API_KEY` is present this takes over transparently: same
 * request shape, same tool runtime, same trace spans, same usage accounting.
 * Without a key `available()` is false and the built-in engine answers instead,
 * so the platform behaves identically offline. The key is read once, sent only
 * in the request header, and never written to a log, a span or an error.
 */
import type { AiCompletion, AiCompletionRequest, AiMessage, AiProvider, AiToolCall, AiToolDef } from '../kernel/ai';
import type { Config } from '../kernel/context';
import { schemaToOpenApi } from '../kernel/http';
import { ApiError } from '../../shared/errors';
import { accountUsage } from './usage';
import type { AiCallContext } from './runtime';

export const ANTHROPIC_MODEL = 'claude-sonnet-4-5';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 2048;
const REQUEST_TIMEOUT_MS = 60_000;

interface AnthropicTextBlock { type: 'text'; text: string }
interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicResponse {
  id: string;
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null;
  usage: { input_tokens: number; output_tokens: number };
}

/** The subset of the streaming event envelope we act on. */
interface StreamEvent {
  type: string;
  index?: number;
  message?: { id?: string; model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  content_block?: { type?: string; text?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: AnthropicResponse['stop_reason'] };
  usage?: { output_tokens?: number };
}

interface WireMessage {
  role: 'user' | 'assistant';
  content: string | unknown[];
}

/** Fold our message list into the Anthropic wire shape, hoisting the system prompt. */
export function toWire(messages: AiMessage[]): { system: string; messages: WireMessage[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const out: WireMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: message.tool_call_id ?? 'unknown', content: message.content }],
      });
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const blocks: unknown[] = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content });
  }
  // The API requires the conversation to start with a user turn.
  while (out.length && out[0].role === 'assistant') out.shift();
  return { system, messages: out.length ? out : [{ role: 'user', content: '(no message)' }] };
}

export const toWireTools = (tools: AiToolDef[] | undefined) =>
  (tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: schemaToOpenApi(tool.input.describe()),
  }));

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

interface CallOptions {
  apiKey: string;
  body: Record<string, unknown>;
  onDelta?: (text: string) => void;
  baseUrl: string;
}

/**
 * One HTTP round trip. Streaming is used whenever the caller wants deltas, and
 * the streamed events are folded back into the same response shape so the
 * tool-use loop does not care which transport was used.
 */
async function callApi({ apiKey, body, onDelta, baseUrl }: CallOptions): Promise<AnthropicResponse> {
  const stream = !!onDelta;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let attempt = 0;
  try {
    for (;;) {
      attempt++;
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            accept: stream ? 'text/event-stream' : 'application/json',
          },
          body: JSON.stringify({ ...body, ...(stream ? { stream: true } : {}) }),
          signal: controller.signal,
        });
      } catch (e) {
        if (attempt <= 2) { await sleep(250 * attempt); continue; }
        throw new ApiError('api_error', 'ai_provider_unreachable', `Could not reach the model provider: ${(e as Error).message}`);
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt <= 2) { await sleep(400 * attempt); continue; }
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        // Only the provider's message is surfaced, and the key is scrubbed from
        // it in case the response echoed the request back at us.
        const message = (() => {
          const raw = (() => {
            try { return (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text.slice(0, 200); }
            catch { return text.slice(0, 200); }
          })();
          return raw.split(apiKey).join('[redacted]');
        })();
        throw new ApiError(
          response.status === 401 ? 'authentication_error' : response.status === 429 ? 'rate_limit_error' : 'api_error',
          'ai_provider_error',
          `Model provider returned ${response.status}: ${message}`,
        );
      }
      return stream ? await readStream(response, onDelta!) : (await response.json()) as AnthropicResponse;
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Fold `text_delta` and `input_json_delta` events back into content blocks. */
async function readStream(response: Response, onDelta: (text: string) => void): Promise<AnthropicResponse> {
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError('api_error', 'ai_stream_failed', 'The provider returned no response body to stream.');
  const decoder = new TextDecoder();
  const blocks: AnthropicContentBlock[] = [];
  const partialJson = new Map<number, string>();
  let assembled: AnthropicResponse = {
    id: '', model: '', content: blocks, stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 },
  };
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let event: StreamEvent;
      try { event = JSON.parse(payload) as StreamEvent; } catch { continue; }
      switch (event.type) {
        case 'message_start':
          assembled = {
            id: event.message?.id ?? '',
            model: event.message?.model ?? '',
            content: blocks,
            stop_reason: null,
            usage: { input_tokens: event.message?.usage?.input_tokens ?? 0, output_tokens: 0 },
          };
          break;
        case 'content_block_start': {
          const index = event.index ?? 0;
          if (event.content_block?.type === 'text') blocks[index] = { type: 'text', text: event.content_block.text ?? '' };
          else if (event.content_block?.type === 'tool_use') {
            blocks[index] = { type: 'tool_use', id: event.content_block.id ?? '', name: event.content_block.name ?? '', input: {} };
            partialJson.set(index, '');
          }
          break;
        }
        case 'content_block_delta': {
          const index = event.index ?? 0;
          const block = blocks[index];
          if (event.delta?.type === 'text_delta' && block?.type === 'text') {
            block.text += event.delta.text ?? '';
            onDelta(event.delta.text ?? '');
          } else if (event.delta?.type === 'input_json_delta') {
            partialJson.set(index, (partialJson.get(index) ?? '') + (event.delta.partial_json ?? ''));
          }
          break;
        }
        case 'content_block_stop': {
          const index = event.index ?? 0;
          const block = blocks[index];
          if (block?.type === 'tool_use') {
            const raw = partialJson.get(index) ?? '';
            try { block.input = raw ? JSON.parse(raw) : {}; } catch { block.input = {}; }
          }
          break;
        }
        case 'message_delta':
          assembled.stop_reason = event.delta?.stop_reason ?? assembled.stop_reason;
          assembled.usage.output_tokens = event.usage?.output_tokens ?? assembled.usage.output_tokens;
          break;
        default:
          break;
      }
    }
  }
  assembled.content = blocks.filter(Boolean);
  return assembled;
}

const SYSTEM_PREAMBLE =
  'You are Ain, the operating copilot for this business. You answer from the workspace\'s own records by calling the tools provided. ' +
  'Never invent a number, a name or a date: if a tool did not return it, say so. Format money in the workspace currency and dates in its timezone. ' +
  'Be specific and brief — an operator reading your answer should be able to act on it without opening another screen.';

export function anthropicProvider(config: Config): AiProvider {
  // The endpoint is read per call, like the key, so pointing the platform at a
  // gateway takes effect on the next request instead of on the next restart —
  // and the endpoint can never disagree with the key it is sent with.
  const baseUrl = (): string => process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  return {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    available: () => !!process.env.ANTHROPIC_API_KEY,

    async complete(req: AiCompletionRequest, input: unknown): Promise<AiCompletion> {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new ApiError('api_error', 'ai_provider_unavailable', 'No ANTHROPIC_API_KEY is configured.');
      const call = input as AiCallContext;
      const runtime = call?.runtime;
      const budget = runtime?.budget(call) ?? { steps: 8, timeMs: 60_000, callsPerMinute: 600 };
      const model = req.model || ANTHROPIC_MODEL;
      const tools = req.tools ?? [];
      const toolIndex = new Map(tools.map((tool) => [tool.name, tool]));

      const schemaNote = req.responseSchema
        ? `\n\nReply with a single JSON object matching this schema and nothing else: ${JSON.stringify(schemaToOpenApi(req.responseSchema))}`
        : '';
      const wire = toWire([
        { role: 'system', content: `${SYSTEM_PREAMBLE}${schemaNote}` },
        ...req.messages,
      ]);

      const reasoning: string[] = [`Engine: Claude ${model} (hosted), answering free text over ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}.`];
      runtime?.note(call, 'provider', 'anthropic', `Free text over ${tools.length} tools with ${model}`);
      const toolCalls: AiToolCall[] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let text = '';
      let finishReason: AiCompletion['finishReason'] = 'stop';

      for (let step = 0; step < budget.steps; step++) {
        const response = await callApi({
          apiKey,
          baseUrl: baseUrl(),
          onDelta: call?.onDelta,
          body: {
            model,
            max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
            temperature: req.temperature ?? 0.2,
            system: wire.system,
            messages: wire.messages,
            ...(tools.length ? { tools: toWireTools(tools) } : {}),
          },
        });

        inputTokens += response.usage?.input_tokens ?? 0;
        outputTokens += response.usage?.output_tokens ?? 0;
        text = response.content.filter((b): b is AnthropicTextBlock => b.type === 'text').map((b) => b.text).join('').trim();
        const requested = response.content.filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use');

        if (!requested.length || response.stop_reason !== 'tool_use') {
          finishReason = response.stop_reason === 'max_tokens' ? 'length' : 'stop';
          break;
        }

        wire.messages.push({ role: 'assistant', content: response.content as unknown[] });
        const results: unknown[] = [];
        for (const use of requested) {
          toolCalls.push({ id: use.id, name: use.name, arguments: use.input });
          const execution = runtime
            ? await runtime.execute(use.name, use.input, call, toolIndex.get(use.name))
            : { ok: false, error: { code: 'tool_failed' as const, message: 'No tool runtime is attached to this call.' }, result: undefined };
          reasoning.push(execution.ok
            ? `Called ${use.name} → ok`
            : `Called ${use.name} → ${execution.error?.code}: ${execution.error?.message}`);
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            is_error: !execution.ok,
            content: JSON.stringify(execution.ok ? execution.result ?? null : { error: execution.error }),
          });
        }
        wire.messages.push({ role: 'user', content: results });
        finishReason = 'tool_calls';
      }

      const { usage } = accountUsage(model, inputTokens, outputTokens);
      reasoning.push(`${toolCalls.length} tool ${toolCalls.length === 1 ? 'call' : 'calls'}, ${usage.inputTokens} input + ${usage.outputTokens} output tokens, ${usage.credits} credits.`);

      return {
        content: text,
        toolCalls,
        finishReason: finishReason === 'tool_calls' ? 'stop' : finishReason,
        usage,
        model,
        reasoning,
        citations: [],
      };
    },
  };
}

export const anthropicConfigured = (): boolean => !!process.env.ANTHROPIC_API_KEY;
export type { AiCallContext };
export const providerConfig = (config: Config) => ({ provider: config.aiProvider, model: ANTHROPIC_MODEL });
