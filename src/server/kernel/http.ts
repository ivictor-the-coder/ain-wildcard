import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, badRequest, isApiError, notFound } from '../../shared/errors';
import type { SchemaNode, Validator } from '../../shared/validate';
import { randomId } from '../../shared/ids';

export type Role = 'owner' | 'admin' | 'member' | 'analyst' | 'readonly' | 'system';

/**
 * The one ladder every authority check in the platform reads. It lives here,
 * beside `Role`, so a module can enforce a role on a *field* of a request —
 * `allow_writes` on the copilot, say — without importing `app.ts` and closing
 * an import cycle through the generated module registry.
 */
const ROLE_RANK: Record<Role, number> = { system: 100, owner: 90, admin: 80, member: 60, analyst: 40, readonly: 20 };

export const roleAtLeast = (role: Role, min: Role): boolean => ROLE_RANK[role] >= ROLE_RANK[min];

export interface Auth {
  kind: 'session' | 'api_key' | 'system' | 'anonymous';
  orgId: string;
  userId?: string;
  keyId?: string;
  role: Role;
  scopes: string[];
  livemode: boolean;
}

export const SYSTEM_AUTH = (orgId: string): Auth => ({
  kind: 'system', orgId, role: 'system', scopes: ['*'], livemode: true,
});

export interface Req<B = any> {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  queryAll: Record<string, string[]>;
  body: B;
  headers: Record<string, string>;
  requestId: string;
  auth: Auth;
  ip: string;
  /** Raw request, present only for real HTTP (absent for in-process calls). */
  raw?: IncomingMessage;
}

export interface RawResponse {
  __raw: true;
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export const ok = <T>(body: T): T => body;
export const created = <T>(body: T): RawResponse => ({ __raw: true, status: 201, body });
export const noContent = (): RawResponse => ({ __raw: true, status: 204, body: null });
export const status = (code: number, body: unknown, headers?: Record<string, string>): RawResponse =>
  ({ __raw: true, status: code, body, headers });
export const redirect = (location: string, code = 302): RawResponse =>
  ({ __raw: true, status: code, headers: { location }, body: null });
export const isRaw = (v: unknown): v is RawResponse =>
  typeof v === 'object' && v !== null && (v as RawResponse).__raw === true;

export interface ListEnvelope<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
  total_count?: number;
  url?: string;
}

export const list = <T>(data: T[], opts: { hasMore?: boolean; nextCursor?: string | null; totalCount?: number; url?: string } = {}): ListEnvelope<T> => ({
  object: 'list',
  data,
  has_more: opts.hasMore ?? false,
  next_cursor: opts.nextCursor ?? null,
  ...(opts.totalCount !== undefined ? { total_count: opts.totalCount } : {}),
  ...(opts.url ? { url: opts.url } : {}),
});

export interface RouteMeta {
  summary?: string;
  description?: string;
  tags?: string[];
  /** 'required' (default), 'public', or a list of scopes that satisfy it. */
  auth?: 'required' | 'public';
  scopes?: string[];
  roles?: Role[];
  body?: Validator<any>;
  query?: Validator<any>;
  /** Example response used by the generated API reference. */
  example?: unknown;
  /** Mark POST routes that must not be replayed without an idempotency key. */
  idempotent?: boolean;
  deprecated?: boolean;
}

export interface Route<C = any> {
  method: string;
  path: string;
  segments: string[];
  handler: (req: Req, ctx: C) => unknown | Promise<unknown>;
  meta: RouteMeta;
  module: string;
}

export class Router<C = any> {
  readonly routes: Route<C>[] = [];
  private currentModule = 'core';

  scope(moduleName: string): Router<C> {
    this.currentModule = moduleName;
    return this;
  }

  add(method: string, path: string, handler: Route<C>['handler'], meta: RouteMeta = {}): this {
    if (!path.startsWith('/')) throw new Error(`Route path must start with "/": ${path}`);
    const existing = this.routes.find((r) => r.method === method && r.path === path);
    if (existing) throw new Error(`Duplicate route ${method} ${path} (from ${existing.module} and ${this.currentModule})`);
    this.routes.push({ method, path, segments: path.split('/').filter(Boolean), handler, meta, module: this.currentModule });
    return this;
  }

  get(path: string, handler: Route<C>['handler'], meta?: RouteMeta) { return this.add('GET', path, handler, meta); }
  post(path: string, handler: Route<C>['handler'], meta?: RouteMeta) { return this.add('POST', path, handler, meta); }
  put(path: string, handler: Route<C>['handler'], meta?: RouteMeta) { return this.add('PUT', path, handler, meta); }
  patch(path: string, handler: Route<C>['handler'], meta?: RouteMeta) { return this.add('PATCH', path, handler, meta); }
  del(path: string, handler: Route<C>['handler'], meta?: RouteMeta) { return this.add('DELETE', path, handler, meta); }

  match(method: string, path: string): { route: Route<C>; params: Record<string, string> } | null {
    const parts = path.split('/').filter(Boolean);
    let methodMismatch = false;
    for (const route of this.routes) {
      if (route.segments.length !== parts.length && !route.segments.some((s) => s === '*')) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i];
        if (seg === '*') { params['*'] = parts.slice(i).join('/'); break; }
        const part = parts[i];
        if (part === undefined) { matched = false; break; }
        if (seg.startsWith(':')) { params[seg.slice(1)] = decodeURIComponent(part); continue; }
        if (seg !== part) { matched = false; break; }
      }
      if (!matched) continue;
      if (route.method !== method) { methodMismatch = true; continue; }
      return { route, params };
    }
    if (methodMismatch) throw new ApiError('invalid_request_error', 'method_not_allowed', `${method} is not supported on ${path}.`);
    return null;
  }
}

/* --------------------------- request/response plumbing -------------------- */

export function parseQuery(search: string): { flat: Record<string, string>; all: Record<string, string[]> } {
  const params = new URLSearchParams(search);
  const all: Record<string, string[]> = {};
  const flat: Record<string, string> = {};
  for (const [k, v] of params.entries()) {
    const key = k.endsWith('[]') ? k.slice(0, -2) : k;
    (all[key] ||= []).push(v);
    flat[key] = v;
  }
  return { flat, all };
}

export async function readBody(req: IncomingMessage, limitBytes = 2 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw badRequest('request_too_large', `Request body exceeds ${Math.round(limitBytes / 1024)}KB.`);
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text).entries());
  }
  if (!text.trim()) return undefined;
  try { return JSON.parse(text); }
  catch { throw badRequest('invalid_json', 'Request body is not valid JSON.'); }
}

export function newRequestId(): string { return randomId('req', 20); }

export function sendJson(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = body === null || body === undefined ? '' : JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload).toString(),
    ...headers,
  });
  res.end(payload);
}

export function errorToResponse(e: unknown, requestId: string): { status: number; body: unknown } {
  if (isApiError(e)) return { status: e.status, body: e.toBody(requestId) };
  const message = e instanceof Error ? e.message : String(e);
  const err = new ApiError('api_error', 'internal_error', message);
  return { status: 500, body: err.toBody(requestId) };
}

export { notFound };

/* ------------------------------ OpenAPI --------------------------------- */

export function schemaToOpenApi(node: SchemaNode | undefined): any {
  if (!node) return { type: 'object' };
  const base: any = {};
  if (node.description) base.description = node.description;
  switch (node.type) {
    case 'object': {
      if (node.format === 'metadata') return { ...base, type: 'object', additionalProperties: { type: 'string' } };
      if (node.fields) {
        const properties: Record<string, unknown> = {};
        const required: string[] = [];
        for (const [k, child] of Object.entries(node.fields)) {
          properties[k] = schemaToOpenApi(child);
          if (!child.optional) required.push(k);
        }
        return { ...base, type: 'object', properties, ...(required.length ? { required } : {}) };
      }
      return { ...base, type: 'object', additionalProperties: node.of ? schemaToOpenApi(node.of) : true };
    }
    case 'array': return { ...base, type: 'array', items: schemaToOpenApi(node.of), ...(node.min ? { minItems: node.min } : {}) };
    case 'integer': return { ...base, type: 'integer', ...(node.min !== undefined ? { minimum: node.min } : {}), ...(node.max !== undefined ? { maximum: node.max } : {}) };
    case 'number': return { ...base, type: 'number', ...(node.min !== undefined ? { minimum: node.min } : {}), ...(node.max !== undefined ? { maximum: node.max } : {}) };
    case 'boolean': return { ...base, type: 'boolean' };
    case 'union': case 'variant': return { ...base, oneOf: Object.values(node.fields || {}).map(schemaToOpenApi) };
    case 'any': case 'json': return base;
    default:
      return {
        ...base, type: 'string',
        ...(node.enum ? { enum: [...node.enum] } : {}),
        ...(node.pattern ? { pattern: node.pattern } : {}),
        ...(node.format ? { format: node.format } : {}),
        ...(node.min !== undefined ? { minLength: node.min } : {}),
        ...(node.max !== undefined ? { maxLength: node.max } : {}),
      };
  }
}

export function buildOpenApi(router: Router<any>, info: { title: string; version: string; description?: string }): any {
  const paths: Record<string, any> = {};
  for (const route of router.routes) {
    if (route.path.includes('*')) continue;
    const oaPath = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const pathParams = [...route.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({
      name: m[1], in: 'path', required: true, schema: { type: 'string' },
    }));
    const queryNode = route.meta.query?.describe();
    const queryParams = queryNode?.fields
      ? Object.entries(queryNode.fields).map(([name, node]) => ({
          name, in: 'query', required: !node.optional, schema: schemaToOpenApi(node), description: node.description,
        }))
      : [];
    const op: any = {
      operationId: `${route.method.toLowerCase()}${oaPath.replace(/[^A-Za-z0-9]+/g, '_')}`,
      summary: route.meta.summary || `${route.method} ${route.path}`,
      description: route.meta.description,
      tags: route.meta.tags?.length ? route.meta.tags : [route.module],
      parameters: [...pathParams, ...queryParams],
      security: route.meta.auth === 'public' ? [] : [{ bearerAuth: [] }],
      ...(route.meta.deprecated ? { deprecated: true } : {}),
      responses: {
        '200': {
          description: 'Success',
          content: { 'application/json': { schema: { type: 'object' }, ...(route.meta.example ? { example: route.meta.example } : {}) } },
        },
        '400': { description: 'Invalid request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    };
    if (route.meta.body) {
      op.requestBody = { required: true, content: { 'application/json': { schema: schemaToOpenApi(route.meta.body.describe()) } } };
    }
    (paths[oaPath] ||= {})[route.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info,
    servers: [{ url: '/api' }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Use a secret API key: `Authorization: Bearer sk_test_...`' } },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                type: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' },
                param: { type: 'string' }, doc_url: { type: 'string' }, request_id: { type: 'string' },
              },
              required: ['type', 'code', 'message'],
            },
          },
        },
      },
    },
  };
}
