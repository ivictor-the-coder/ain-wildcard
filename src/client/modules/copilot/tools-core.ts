/**
 * The tool catalogue, as pure functions.
 *
 * `GET /v1/ai/tools` is the list the copilot and the agents read and write the
 * workspace through; the runs page draws it and this is the one rule it
 * applies to it, kept apart from React so it can be held to a fixture.
 */

/** One row of `GET /v1/ai/tools`, as much of it as the catalogue reads. */
export interface ToolRow { name: string; description: string; read_only: boolean; tags: string[] }

const humanToolName = (tool: string): string => {
  const words = tool.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The tools whose name, description or tags mention every word typed. */
export function filterTools<T extends ToolRow>(rows: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...rows];
  return rows.filter((tool) => {
    const hay = `${tool.name} ${humanToolName(tool.name)} ${tool.description} ${tool.tags.join(' ')}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

/** A tool's tag as a person reads it: the initialisms the catalogue uses stay upper-case. */
const TAG_INITIALISMS = new Set(['ai', 'crm', 'api', 'mrr', 'arr', 'sla']);
export const tagLabel = (tag: string): string => {
  const lower = tag.toLowerCase();
  if (TAG_INITIALISMS.has(lower)) return lower.toUpperCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1).replace(/_/g, ' ');
};

/** The verbs a sentence written *to the model* opens with — an instruction, not a description. */
const INSTRUCTION = /^(use|pass|call|start|prefer|always|never|send|give|ask|set|hand|read this|this is the tool)\b/i;

/** How the tool's tags read as places in the product. */
const DOMAIN_WORDS: Record<string, string> = {
  crm: 'the CRM', billing: 'billing', revenue: 'revenue', metering: 'metering', credits: 'prepaid credit',
  support: 'support', entitlements: 'entitlements', workflows: 'workflows', marketing: 'marketing',
  agents: 'the agents', conversations: 'conversations',
};

export interface ToolSummary {
  /** One sentence for a person: what the tool reads or writes. */
  summary: string;
  /** The rest of what the engine is told — how to call it, which argument answers which question. Empty when there is none. */
  guidance: string;
}

/**
 * A tool's description split into what a person needs and what the model needs.
 *
 * `GET /v1/ai/tools` publishes the text the engine is prompted with, and the
 * catalogue printed all of it: "Pass a company id, or a contact id to get the
 * company behind it", "Use status=open_like to answer …". The first sentence
 * of almost every description is the honest summary; the instructions that
 * follow are for the model and go behind a disclosure. A description that
 * opens with an instruction gets a summary built from what the catalogue
 * already knows — whether it reads or writes, and where.
 */
export function toolSummary(tool: ToolRow): ToolSummary {
  const text = tool.description.replace(/\s+/g, ' ').trim();
  // A sentence ends where a full stop is followed by a capital: a question mark
  // inside quoted example wording — `answer "what is overdue?"` — is not an end.
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z“"])/).map((part) => part.trim()).filter(Boolean);
  const first = sentences[0] ?? '';
  const descriptive = first && !INSTRUCTION.test(first) && !/[a-z_]+=[a-z_]/i.test(first);
  const places = tool.tags.map((tag) => DOMAIN_WORDS[tag.toLowerCase()]).filter((word): word is string => !!word);
  const where = places.length ? ` ${places.join(', ')}` : ' the workspace';
  const generic = tool.read_only
    ? `Reads${where}; changes nothing.`
    : `Writes to${where}; stops for a person’s approval before it runs.`;
  if (!descriptive) return { summary: generic, guidance: text };
  const summary = /[.!?]$/.test(first) ? first : `${first}.`;
  return { summary, guidance: sentences.slice(1).join(' ').trim() };
}
