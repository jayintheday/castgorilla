/**
 * logger.ts — leveled stderr logger.
 *
 * Level is read from the LOG_LEVEL env var (default 'info'). All output goes to
 * stderr so stdout stays clean for machine-readable payloads (the CLI streams
 * data on stdout). Namespaced child loggers prefix each line with their tag.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

function envLevel(): LogLevel {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  if (raw in LEVEL_ORDER) return raw as LogLevel;
  return 'info';
}

export interface Logger {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;
  child(namespace: string): Logger;
  /** The effective threshold this logger writes at. */
  readonly level: LogLevel;
}

function write(threshold: LogLevel, level: Exclude<LogLevel, 'silent'>, namespace: string, args: unknown[]): void {
  if (LEVEL_ORDER[level] > LEVEL_ORDER[threshold]) return;
  const ts = new Date().toISOString();
  const tag = namespace ? ` [${namespace}]` : '';
  const prefix = `${ts} ${level.toUpperCase().padEnd(5)}${tag}`;
  const line = args
    .map((a) => (typeof a === 'string' ? a : formatValue(a)))
    .join(' ');
  process.stderr.write(`${prefix} ${line}\n`);
}

function formatValue(v: unknown): string {
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function createLogger(namespace = ''): Logger {
  const level = envLevel();
  return {
    level,
    error: (...args) => write(level, 'error', namespace, args),
    warn: (...args) => write(level, 'warn', namespace, args),
    info: (...args) => write(level, 'info', namespace, args),
    debug: (...args) => write(level, 'debug', namespace, args),
    trace: (...args) => write(level, 'trace', namespace, args),
    child: (child) => createLogger(namespace ? `${namespace}:${child}` : child),
  };
}

/** Default process-wide logger. */
export const logger: Logger = createLogger('castgorilla');
