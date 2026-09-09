/**
 * The seam where the platform stops being in charge.
 *
 * Everything above this file is deterministic: an event becomes a delivery,
 * a delivery becomes attempts on a published ladder, an attempt becomes a row.
 * Everything below it is somebody else's server, or somebody else's mail
 * relay, and it can be slow, wrong or gone. Keeping the boundary explicit is
 * what makes the whole spine testable — and it is why nothing in this module
 * ever calls `fetch`. The shipped implementations answer from a rule set and
 * record what they were asked to send; a real transport is a different object
 * satisfying the same two interfaces, installed at boot.
 *
 * `send` and `deliver` are allowed to be async even though the recorded ones
 * are not. A transport that really did cross the network could not be
 * anything else, and a seam that only fits the fake is not a seam.
 */

export interface OutboundRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  /** The exact bytes that were signed. */
  body: string;
  /**
   * How long the caller will wait. The transport is what enforces it — a job
   * handler is awaiting `send`, so a transport that ignores this can hold the
   * queue open on one unresponsive subscriber for as long as its socket lasts.
   */
  timeout_ms: number;
}

export interface OutboundResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
  duration_ms: number;
}

export interface HttpTransport {
  /** Named on the overview, so an operator can see what they are wired to. */
  readonly name: string;
  send(request: OutboundRequest): OutboundResponse | Promise<OutboundResponse>;
}

export interface OutboundMessage {
  channel: 'email' | 'sms';
  to: string;
  to_name: string | null;
  from: string;
  subject: string | null;
  text: string;
  html: string | null;
}

export interface MessageReceipt {
  accepted: boolean;
  /** The relay's own id for the message — what support quotes at the ISP. */
  provider_id: string;
  detail: string;
}

export interface MessageTransport {
  readonly name: string;
  deliver(message: OutboundMessage): MessageReceipt | Promise<MessageReceipt>;
}

/* ----------------------------- recorded HTTP ------------------------------ */

export interface RecordedCall {
  at: number;
  request: OutboundRequest;
  response: OutboundResponse;
}

/** What a rule answers with. Anything it omits falls back to the default 200. */
export type RuleResponse = Partial<Omit<OutboundResponse, 'duration_ms'>> & { duration_ms?: number };

export interface RecordedHttpTransport extends HttpTransport {
  readonly calls: readonly RecordedCall[];
  /**
   * Answer any URL containing `match` (or matching the expression) with this
   * response, until it is cleared. Later rules win, so a test can narrow a
   * broad rule without unwinding it.
   */
  respond(match: string | RegExp, response: RuleResponse | ((request: OutboundRequest) => RuleResponse)): void;
  /** Refuse the connection outright — no status, no body, the way a dead host does. */
  refuse(match: string | RegExp, message?: string): void;
  clearRules(): void;
  reset(): void;
  callsTo(match: string | RegExp): RecordedCall[];
}

const matches = (match: string | RegExp, url: string): boolean =>
  typeof match === 'string' ? url.includes(match) : match.test(url);

/** The one answer every unmatched request gets: accepted, nothing to say. */
const DEFAULT_RESPONSE: RuleResponse = { status: 200, body: '{"received":true}' };

class ConnectionRefused extends Error {
  constructor(message: string) { super(message); this.name = 'ConnectionRefused'; }
}

export function recordedHttpTransport(name = 'recorded'): RecordedHttpTransport {
  const calls: RecordedCall[] = [];
  const rules: { match: string | RegExp; answer: (r: OutboundRequest) => RuleResponse }[] = [];
  const refusals: { match: string | RegExp; message: string }[] = [];

  return {
    name,
    calls,
    respond(match, response) {
      rules.push({ match, answer: typeof response === 'function' ? response : () => response });
    },
    refuse(match, message = 'Connection refused.') {
      refusals.push({ match, message });
    },
    clearRules() { rules.length = 0; refusals.length = 0; },
    reset() { calls.length = 0; rules.length = 0; refusals.length = 0; },
    callsTo(match) { return calls.filter((c) => matches(match, c.request.url)); },
    send(request) {
      // Last rule wins, so a narrow rule can be laid over a broad one.
      for (let i = refusals.length - 1; i >= 0; i--) {
        if (matches(refusals[i].match, request.url)) throw new ConnectionRefused(refusals[i].message);
      }
      let answer = DEFAULT_RESPONSE;
      for (let i = rules.length - 1; i >= 0; i--) {
        if (matches(rules[i].match, request.url)) { answer = rules[i].answer(request); break; }
      }
      const response: OutboundResponse = {
        status: answer.status ?? 200,
        body: answer.body ?? '',
        headers: answer.headers ?? { 'content-type': 'application/json' },
        duration_ms: answer.duration_ms ?? 0,
      };
      calls.push({ at: Date.now(), request, response });
      return response;
    },
  };
}

/* ---------------------------- recorded messages --------------------------- */

export interface RecordedMessage {
  at: number;
  message: OutboundMessage;
  receipt: MessageReceipt;
}

export interface RecordedMessageTransport extends MessageTransport {
  readonly outbox: readonly RecordedMessage[];
  /** Bounce anything addressed to a matching recipient. */
  bounce(match: string | RegExp, detail?: string): void;
  clearRules(): void;
  reset(): void;
  to(match: string | RegExp): RecordedMessage[];
}

let messageSeq = 0;

export function recordedMessageTransport(name = 'recorded'): RecordedMessageTransport {
  const outbox: RecordedMessage[] = [];
  const bounces: { match: string | RegExp; detail: string }[] = [];

  return {
    name,
    outbox,
    bounce(match, detail = 'The address was rejected by the receiving server.') {
      bounces.push({ match, detail });
    },
    clearRules() { bounces.length = 0; },
    reset() { outbox.length = 0; bounces.length = 0; },
    to(match) { return outbox.filter((m) => matches(match, m.message.to)); },
    deliver(message) {
      const bounced = [...bounces].reverse().find((b) => matches(b.match, message.to));
      const receipt: MessageReceipt = bounced
        ? { accepted: false, provider_id: '', detail: bounced.detail }
        : {
          accepted: true,
          provider_id: `${name}-${(++messageSeq).toString(36)}`,
          detail: `Handed to the ${name} transport, which keeps it in this process rather than sending it anywhere.`,
        };
      outbox.push({ at: Date.now(), message, receipt });
      return receipt;
    },
  };
}
