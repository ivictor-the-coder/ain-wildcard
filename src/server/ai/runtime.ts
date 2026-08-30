import type { AiCompletion, AiCompletionRequest, AiProvider, AiRuntime, AiToolDef } from '../kernel/ai';
import type { Config } from '../kernel/context';
import { randomId } from '../../shared/ids';

/**
 * Model gateway. Providers are tried in priority order; the built-in
 * deterministic engine is always available so the platform is fully functional
 * with no network and no keys, and every AI surface stays demoable and testable.
 */
export function createAiRuntime(config: Config): AiRuntime {
  const tools = new Map<string, AiToolDef>();
  const providers: AiProvider[] = [];

  const runtime: AiRuntime = {
    providers,
    active() {
      const preferred = config.aiProvider && config.aiProvider !== 'auto'
        ? providers.find((p) => p.id === config.aiProvider && p.available())
        : undefined;
      return preferred || providers.find((p) => p.available()) || fallbackProvider;
    },
    async complete(req, ctx) { return runtime.active().complete(req, ctx); },
    registerTool(tool) {
      if (tools.has(tool.name)) throw new Error(`Duplicate AI tool: ${tool.name}`);
      tools.set(tool.name, tool);
    },
    tools(filter) {
      let out = [...tools.values()];
      if (filter?.tags?.length) out = out.filter((t) => t.tags?.some((tag) => filter.tags!.includes(tag)));
      if (filter?.readOnly !== undefined) out = out.filter((t) => t.readOnly === filter.readOnly);
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    tool(name) { return tools.get(name); },
  };
  return runtime;
}

/** Last-resort provider so `complete()` never throws for lack of a model. */
const fallbackProvider: AiProvider = {
  id: 'fallback',
  label: 'Built-in',
  available: () => true,
  async complete(req: AiCompletionRequest): Promise<AiCompletion> {
    const last = [...req.messages].reverse().find((m) => m.role === 'user');
    return {
      content: last ? `I can help with that. (${last.content.slice(0, 120)})` : 'How can I help?',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0, costCents: 0, credits: 0 },
      model: 'ain-fallback',
      reasoning: ['No reasoning engine registered; returned a passthrough response.'],
    };
  },
};

export const newToolCallId = () => randomId('call', 12);
