import type { PropertyValue } from './types';

/**
 * The expression language behind calculated properties. It is deliberately
 * small and hand-parsed — there is no `eval`, no dynamic code generation and no
 * access to anything but the record's own properties and the workspace clock,
 * so an admin editing a formula can never reach the runtime.
 *
 *   concat(first_name, " ", last_name)
 *   round(amount * probability / 100)
 *   if(employee_count >= 1000, "Enterprise", if(employee_count >= 250, "Mid-market", "SMB"))
 */

type Node =
  | { k: 'lit'; v: string | number | boolean | null }
  | { k: 'prop'; name: string }
  | { k: 'unary'; op: '-' | 'not'; arg: Node }
  | { k: 'bin'; op: string; left: Node; right: Node }
  | { k: 'call'; name: string; args: Node[] };

export interface ExprScope {
  properties: Record<string, PropertyValue>;
  now: number;
}

export class ExpressionError extends Error {
  constructor(message: string) { super(message); this.name = 'ExpressionError'; }
}

/* -------------------------------- lexer ---------------------------------- */

interface Token { t: 'num' | 'str' | 'ident' | 'op' | 'end'; v: string; pos: number }

const OPERATORS = ['<=', '>=', '==', '!=', '<>', '+', '-', '*', '/', '%', '<', '>', '=', '(', ')', ','];

function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '"' || c === "'") {
      const quote = c;
      let s = '';
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) { s += src[i + 1]; i += 2; continue; }
        s += src[i++];
      }
      if (i >= src.length) throw new ExpressionError(`Unterminated string starting at position ${i}.`);
      i++;
      out.push({ t: 'str', v: s, pos: i });
      continue;
    }
    if (c === '{') {
      const end = src.indexOf('}', i);
      if (end < 0) throw new ExpressionError('Unterminated {property} reference.');
      out.push({ t: 'ident', v: src.slice(i + 1, end).trim(), pos: i });
      i = end + 1;
      continue;
    }
    if (c >= '0' && c <= '9') {
      let s = '';
      while (i < src.length && ((src[i] >= '0' && src[i] <= '9') || src[i] === '.')) s += src[i++];
      out.push({ t: 'num', v: s, pos: i });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let s = '';
      while (i < src.length && /[A-Za-z0-9_.]/.test(src[i])) s += src[i++];
      out.push({ t: 'ident', v: s, pos: i });
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExpressionError(`Unexpected character "${c}" at position ${i}.`);
    out.push({ t: 'op', v: op, pos: i });
    i += op.length;
  }
  out.push({ t: 'end', v: '', pos: i });
  return out;
}

/* -------------------------------- parser --------------------------------- */

const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false', 'null']);

function parse(src: string): Node {
  const tokens = lex(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (v: string): boolean => {
    const tk = tokens[pos];
    if ((tk.t === 'op' || tk.t === 'ident') && tk.v.toLowerCase() === v) { pos++; return true; }
    return false;
  };
  const expect = (v: string) => {
    if (!eat(v)) throw new ExpressionError(`Expected "${v}" at position ${peek().pos}.`);
  };

  const parseOr = (): Node => {
    let left = parseAnd();
    while (eat('or')) left = { k: 'bin', op: 'or', left, right: parseAnd() };
    return left;
  };
  const parseAnd = (): Node => {
    let left = parseCompare();
    while (eat('and')) left = { k: 'bin', op: 'and', left, right: parseCompare() };
    return left;
  };
  const parseCompare = (): Node => {
    let left = parseAdd();
    for (;;) {
      const tk = peek();
      if (tk.t !== 'op' || !['<', '<=', '>', '>=', '=', '==', '!=', '<>'].includes(tk.v)) break;
      pos++;
      const op = tk.v === '==' ? '=' : tk.v === '<>' ? '!=' : tk.v;
      left = { k: 'bin', op, left, right: parseAdd() };
    }
    return left;
  };
  const parseAdd = (): Node => {
    let left = parseMul();
    for (;;) {
      const tk = peek();
      if (tk.t !== 'op' || (tk.v !== '+' && tk.v !== '-')) break;
      pos++;
      left = { k: 'bin', op: tk.v, left, right: parseMul() };
    }
    return left;
  };
  const parseMul = (): Node => {
    let left = parseUnary();
    for (;;) {
      const tk = peek();
      if (tk.t !== 'op' || !['*', '/', '%'].includes(tk.v)) break;
      pos++;
      left = { k: 'bin', op: tk.v, left, right: parseUnary() };
    }
    return left;
  };
  const parseUnary = (): Node => {
    if (eat('-')) return { k: 'unary', op: '-', arg: parseUnary() };
    if (eat('not')) return { k: 'unary', op: 'not', arg: parseUnary() };
    return parsePrimary();
  };
  const parsePrimary = (): Node => {
    const tk = peek();
    if (tk.t === 'num') { pos++; return { k: 'lit', v: Number(tk.v) }; }
    if (tk.t === 'str') { pos++; return { k: 'lit', v: tk.v }; }
    if (tk.t === 'op' && tk.v === '(') { pos++; const inner = parseOr(); expect(')'); return inner; }
    if (tk.t === 'ident') {
      pos++;
      const lower = tk.v.toLowerCase();
      if (lower === 'true') return { k: 'lit', v: true };
      if (lower === 'false') return { k: 'lit', v: false };
      if (lower === 'null') return { k: 'lit', v: null };
      if (peek().t === 'op' && peek().v === '(') {
        pos++;
        const args: Node[] = [];
        if (!(peek().t === 'op' && peek().v === ')')) {
          do { args.push(parseOr()); } while (eat(','));
        }
        expect(')');
        if (!(lower in FUNCTIONS)) throw new ExpressionError(`Unknown function "${tk.v}". Available: ${Object.keys(FUNCTIONS).join(', ')}.`);
        return { k: 'call', name: lower, args };
      }
      if (KEYWORDS.has(lower)) throw new ExpressionError(`"${tk.v}" cannot be used as a property name.`);
      return { k: 'prop', name: tk.v };
    }
    throw new ExpressionError(`Unexpected end of expression at position ${tk.pos}.`);
  };

  const node = parseOr();
  if (peek().t !== 'end') throw new ExpressionError(`Unexpected "${peek().v}" at position ${peek().pos}.`);
  return node;
}

/* ------------------------------- evaluation ------------------------------ */

const DAY_MS = 86_400_000;

type Value = string | number | boolean | null;

const num = (v: Value): number => {
  if (v === null || v === false) return 0;
  if (v === true) return 1;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const str = (v: Value): string => (v === null ? '' : typeof v === 'string' ? v : String(v));
const truthy = (v: Value): boolean => !(v === null || v === false || v === 0 || v === '');

type Fn = (args: Value[], scope: ExprScope) => Value;

const FUNCTIONS: Record<string, Fn> = {
  concat: (a) => a.map(str).join(''),
  coalesce: (a) => a.find((v) => v !== null && v !== '' && v !== undefined) ?? null,
  if: (a) => (truthy(a[0] ?? null) ? a[1] ?? null : a[2] ?? null),
  round: (a) => {
    const places = a.length > 1 ? num(a[1]) : 0;
    const f = 10 ** places;
    return Math.round(num(a[0]) * f) / f;
  },
  floor: (a) => Math.floor(num(a[0])),
  ceil: (a) => Math.ceil(num(a[0])),
  abs: (a) => Math.abs(num(a[0])),
  min: (a) => (a.length ? Math.min(...a.map(num)) : 0),
  max: (a) => (a.length ? Math.max(...a.map(num)) : 0),
  lower: (a) => str(a[0]).toLowerCase(),
  upper: (a) => str(a[0]).toUpperCase(),
  trim: (a) => str(a[0]).trim(),
  len: (a) => str(a[0]).length,
  left: (a) => str(a[0]).slice(0, Math.max(0, num(a[1]))),
  contains: (a) => str(a[0]).toLowerCase().includes(str(a[1]).toLowerCase()),
  number: (a) => num(a[0]),
  now: (_a, scope) => scope.now,
  days_since: (a, scope) => (a[0] === null ? null : Math.floor((scope.now - num(a[0])) / DAY_MS)),
  days_until: (a, scope) => (a[0] === null ? null : Math.ceil((num(a[0]) - scope.now) / DAY_MS)),
  year: (a) => (a[0] === null ? null : new Date(num(a[0])).getUTCFullYear()),
  month: (a) => (a[0] === null ? null : new Date(num(a[0])).getUTCMonth() + 1),
  is_set: (a) => a[0] !== null && a[0] !== '',
};

export const EXPRESSION_FUNCTIONS = Object.keys(FUNCTIONS).sort();

function evaluate(node: Node, scope: ExprScope): Value {
  switch (node.k) {
    case 'lit': return node.v;
    case 'prop': {
      const raw = scope.properties[node.name];
      if (raw === undefined || raw === null) return null;
      if (Array.isArray(raw)) return raw.join(';');
      if (typeof raw === 'object') return JSON.stringify(raw);
      return raw;
    }
    case 'unary': {
      const arg = evaluate(node.arg, scope);
      return node.op === '-' ? -num(arg) : !truthy(arg);
    }
    case 'call': {
      const fn = FUNCTIONS[node.name];
      // `if` short-circuits so the untaken branch never divides by zero.
      if (node.name === 'if') {
        const test = evaluate(node.args[0], scope);
        const branch = truthy(test) ? node.args[1] : node.args[2];
        return branch ? evaluate(branch, scope) : null;
      }
      return fn(node.args.map((a) => evaluate(a, scope)), scope);
    }
    case 'bin': {
      if (node.op === 'and') return truthy(evaluate(node.left, scope)) ? truthy(evaluate(node.right, scope)) : false;
      if (node.op === 'or') return truthy(evaluate(node.left, scope)) ? true : truthy(evaluate(node.right, scope));
      const l = evaluate(node.left, scope);
      const r = evaluate(node.right, scope);
      switch (node.op) {
        case '+': return typeof l === 'string' || typeof r === 'string' ? str(l) + str(r) : num(l) + num(r);
        case '-': return num(l) - num(r);
        case '*': return num(l) * num(r);
        case '/': return num(r) === 0 ? null : num(l) / num(r);
        case '%': return num(r) === 0 ? null : num(l) % num(r);
        case '=': return typeof l === 'string' || typeof r === 'string' ? str(l) === str(r) : num(l) === num(r);
        case '!=': return typeof l === 'string' || typeof r === 'string' ? str(l) !== str(r) : num(l) !== num(r);
        case '<': return num(l) < num(r);
        case '<=': return num(l) <= num(r);
        case '>': return num(l) > num(r);
        case '>=': return num(l) >= num(r);
        default: throw new ExpressionError(`Unsupported operator "${node.op}".`);
      }
    }
  }
}

const cache = new Map<string, Node>();

function compile(expression: string): Node {
  let node = cache.get(expression);
  if (!node) {
    node = parse(expression);
    cache.set(expression, node);
  }
  return node;
}

/** Parse an expression and report what it reads — used to validate formulas. */
export function analyzeExpression(expression: string): { properties: string[]; functions: string[] } {
  const node = compile(expression);
  const properties = new Set<string>();
  const functions = new Set<string>();
  const walk = (n: Node): void => {
    switch (n.k) {
      case 'prop': properties.add(n.name); break;
      case 'call': functions.add(n.name); n.args.forEach(walk); break;
      case 'bin': walk(n.left); walk(n.right); break;
      case 'unary': walk(n.arg); break;
      case 'lit': break;
    }
  };
  walk(node);
  return { properties: [...properties], functions: [...functions] };
}

export function evaluateExpression(expression: string, scope: ExprScope): Value {
  return evaluate(compile(expression), scope);
}
