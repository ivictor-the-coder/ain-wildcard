import type { SchemaNode, Validator } from '../../shared/validate';

/**
 * The model gateway every AI surface in the platform speaks to. A provider may
 * be a hosted frontier model or the built-in deterministic engine; callers never
 * care which, so agents, copilot and scoring all behave identically offline.
 */
export type AiRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AiToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AiMessage {
  role: AiRole;
  content: string;
  name?: string;
  tool_calls?: AiToolCall[];
  tool_call_id?: string;
}

export interface AiToolDef<C = any> {
  name: string;
  description: string;
  /** Input schema — a kernel validator so it doubles as runtime validation. */
  input: Validator<any>;
  /** Read-only tools may run without confirmation; write tools can require approval. */
  readOnly: boolean;
  requiresApproval?: boolean;
  tags?: string[];
  run(args: any, ctx: C, meta: AiToolRunMeta): unknown | Promise<unknown>;
}

export interface AiToolRunMeta {
  orgId: string;
  actorId?: string;
  runId?: string;
  threadId?: string;
}

export interface AiCompletionRequest {
  messages: AiMessage[];
  tools?: AiToolDef[];
  /** Free-form task hint used by the deterministic engine to pick a strategy. */
  intent?: string;
  temperature?: number;
  maxTokens?: number;
  /** Ask for a JSON object matching this schema. */
  responseSchema?: SchemaNode;
  model?: string;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  /** Credits consumed against the org's AI allowance. */
  credits: number;
}

export interface AiCompletion {
  content: string;
  toolCalls: AiToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  usage: AiUsage;
  model: string;
  /** Human-readable trace of why the engine answered this way. */
  reasoning?: string[];
  /** Grounding citations — record ids the answer was derived from. */
  citations?: { id: string; label: string; type: string }[];
}

export interface AiProvider {
  id: string;
  label: string;
  available(): boolean;
  complete(req: AiCompletionRequest, ctx: any): Promise<AiCompletion>;
}

export interface AiRuntime {
  providers: AiProvider[];
  active(): AiProvider;
  complete(req: AiCompletionRequest, ctx: any): Promise<AiCompletion>;
  registerTool(tool: AiToolDef): void;
  tools(filter?: { tags?: string[]; readOnly?: boolean }): AiToolDef[];
  tool(name: string): AiToolDef | undefined;
}
