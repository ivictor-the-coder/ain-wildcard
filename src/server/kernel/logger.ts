export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const COLOR: Record<Level, string> = { debug: '\x1b[2m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(opts: { level?: Level; pretty?: boolean; bindings?: Record<string, unknown> } = {}): Logger {
  const level = opts.level || (process.env.AIN_LOG_LEVEL as Level) || 'info';
  const pretty = opts.pretty ?? process.env.AIN_LOG_FORMAT !== 'json';
  const bindings = opts.bindings || {};
  const write = (lvl: Level, msg: string, meta?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const record = { level: lvl, msg, ...bindings, ...meta };
    if (!pretty) { process.stdout.write(JSON.stringify({ time: Date.now(), ...record }) + '\n'); return; }
    const extra = { ...bindings, ...meta };
    const tail = Object.keys(extra).length
      ? ' \x1b[2m' + Object.entries(extra).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ') + '\x1b[0m'
      : '';
    process.stdout.write(`${COLOR[lvl]}${lvl.padEnd(5)}\x1b[0m ${msg}${tail}\n`);
  };
  return {
    debug: (m, x) => write('debug', m, x),
    info: (m, x) => write('info', m, x),
    warn: (m, x) => write('warn', m, x),
    error: (m, x) => write('error', m, x),
    child: (b) => createLogger({ level, pretty, bindings: { ...bindings, ...b } }),
  };
}
