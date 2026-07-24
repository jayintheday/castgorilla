/**
 * ffmpeg/process.ts — FfmpegProcess: a supervised ffmpeg child.
 *
 * Wraps `spawn` with:
 *  - typed events: 'progress' | 'exit' | 'error'
 *  - progress parsed from `-progress pipe:1` key=value output (out_time_us → sec)
 *  - a stderr ring buffer (last N lines) surfaced on failure
 *  - graceful kill: SIGTERM, then SIGKILL after graceMs
 *  - no zombies: we always attach exit/close listeners so Node reaps the child;
 *    nothing is unref'd.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { TypedEmitter } from '../util/emitter.js';
import { createLogger, type Logger } from '../util/logger.js';

/** A parsed `-progress` snapshot. */
export interface FfmpegProgress {
  /** out_time_us converted to seconds (absolute media time under -copyts). */
  outTimeSec: number;
  frame?: number;
  fps?: number;
  speed?: string;
  /** True on the terminal `progress=end` block. */
  done: boolean;
}

export interface FfmpegExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type FfmpegEvents = {
  progress: (p: FfmpegProgress) => void;
  exit: (e: FfmpegExit) => void;
  error: (err: Error) => void;
};

export interface FfmpegProcessOpts {
  /** Resolved ffmpeg binary path (from resolveFfmpeg()). */
  ffmpeg: string;
  args: string[];
  /** Working directory — ffmpeg writes init/segments/playlist here (relative names). */
  cwd: string;
  logger?: Logger;
  /** How many stderr lines to retain (default 50). */
  ringSize?: number;
}

export class FfmpegProcess extends TypedEmitter<FfmpegEvents> {
  private readonly ffmpeg: string;
  private readonly args: string[];
  private readonly cwd: string;
  private readonly log: Logger;
  private readonly ringSize: number;

  private child: ChildProcess | undefined;
  private readonly stderrRing: string[] = [];
  private stdoutBuf = '';
  private stderrBuf = '';
  private progressAcc: Record<string, string> = {};

  private settled = false;
  private killed = false;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private lastError: Error | undefined;

  /** Resolves when the process exits (any code) or fails to spawn. Never rejects. */
  readonly exited: Promise<FfmpegExit>;
  private resolveExited!: (e: FfmpegExit) => void;

  constructor(opts: FfmpegProcessOpts) {
    super();
    this.ffmpeg = opts.ffmpeg;
    this.args = opts.args;
    this.cwd = opts.cwd;
    this.log = opts.logger ?? createLogger('ffmpeg');
    this.ringSize = opts.ringSize ?? 50;
    this.exited = new Promise<FfmpegExit>((resolve) => {
      this.resolveExited = resolve;
    });
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** True while the child is spawned and has not yet exited. */
  get running(): boolean {
    return this.child !== undefined && !this.settled;
  }

  /** Last 50 (or ringSize) stderr lines. */
  stderrTail(): string[] {
    return [...this.stderrRing];
  }

  start(): void {
    if (this.child) throw new Error('FfmpegProcess.start() called twice');
    this.log.debug('spawn', this.ffmpeg, this.args.join(' '));

    const child = spawn(this.ffmpeg, this.args, {
      cwd: this.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    // stdio is ['ignore','pipe','pipe'] so stdout/stderr are always present.
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.onStderr(chunk));

    child.on('error', (err: Error) => {
      // Spawn-level failure (e.g. ENOENT). No exit event will follow.
      this.lastError = err;
      if (this.listenerCount('error') > 0) this.emit('error', err);
      this.finish({ code: null, signal: null });
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      // 'close' (not 'exit') so stdio is fully drained before we finish.
      this.flushLines();
      // A clean exit is code 0 with no signal. Anything else that we did NOT
      // initiate is a failure. (ffmpeg traps SIGTERM and exits 255, so a kill we
      // asked for must never be treated as a crash — hence the `killed` guard.)
      const failed = !this.killed && !(code === 0 && signal === null);
      if (failed) {
        const tail = this.stderrRing.slice(-10).join('\n');
        this.lastError = new Error(
          `ffmpeg exited with code ${code}${signal ? ` (signal ${signal})` : ''}${tail ? `:\n${tail}` : ''}`,
        );
        // Guard: emitting 'error' with no listener throws (EventEmitter rule).
        if (this.listenerCount('error') > 0) this.emit('error', this.lastError);
      }
      this.finish({ code, signal });
    });
  }

  /**
   * Terminate the child: SIGTERM, then SIGKILL after graceMs if still alive.
   * Resolves once the child has fully exited (or immediately if never/already
   * running).
   */
  async kill(graceMs = 2000): Promise<void> {
    if (!this.child || this.settled) return;
    this.killed = true; // subsequent exit is intentional, not a crash
    try {
      this.child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    this.killTimer = setTimeout(() => {
      if (!this.settled && this.child) {
        this.log.warn('ffmpeg did not exit on SIGTERM; sending SIGKILL');
        try {
          this.child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, graceMs);
    // Don't keep the event loop alive purely for the grace timer.
    this.killTimer.unref?.();
    await this.exited;
  }

  private finish(e: FfmpegExit): void {
    if (this.settled) return;
    this.settled = true;
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = undefined;
    }
    this.emit('exit', e);
    this.resolveExited(e);
  }

  // --- stdout: -progress key=value blocks ---------------------------------
  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      this.consumeProgressLine(line);
    }
  }

  private consumeProgressLine(line: string): void {
    if (line.length === 0) return;
    const eq = line.indexOf('=');
    if (eq < 0) return;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === 'progress') {
      // Terminal line of a progress block — emit the accumulated snapshot.
      this.emitProgress(value === 'end');
      this.progressAcc = {};
      return;
    }
    this.progressAcc[key] = value;
  }

  private emitProgress(done: boolean): void {
    const acc = this.progressAcc;
    const usRaw = acc['out_time_us'];
    const us = usRaw !== undefined && usRaw !== 'N/A' ? Number(usRaw) : NaN;
    const outTimeSec = Number.isFinite(us) ? us / 1_000_000 : 0;
    const frame = acc['frame'] !== undefined ? Number(acc['frame']) : undefined;
    const fps = acc['fps'] !== undefined ? Number(acc['fps']) : undefined;
    const speed = acc['speed'];
    const p: FfmpegProgress = { outTimeSec, done };
    if (frame !== undefined && Number.isFinite(frame)) p.frame = frame;
    if (fps !== undefined && Number.isFinite(fps)) p.fps = fps;
    if (speed !== undefined) p.speed = speed.trim();
    this.emit('progress', p);
  }

  // --- stderr: ring buffer ------------------------------------------------
  private onStderr(chunk: string): void {
    this.stderrBuf += chunk;
    let nl: number;
    while ((nl = this.stderrBuf.indexOf('\n')) >= 0) {
      const line = this.stderrBuf.slice(0, nl);
      this.stderrBuf = this.stderrBuf.slice(nl + 1);
      this.pushRing(line);
    }
  }

  private flushLines(): void {
    if (this.stderrBuf.length > 0) {
      this.pushRing(this.stderrBuf);
      this.stderrBuf = '';
    }
    if (this.stdoutBuf.length > 0) {
      this.consumeProgressLine(this.stdoutBuf.trim());
      this.stdoutBuf = '';
    }
  }

  private pushRing(line: string): void {
    this.stderrRing.push(line);
    while (this.stderrRing.length > this.ringSize) this.stderrRing.shift();
  }
}
