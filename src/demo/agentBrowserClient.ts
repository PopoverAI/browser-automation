import { spawn } from "node:child_process";

/**
 * Result of one agent-browser CLI invocation. Mirrors the spawn-result shape
 * so callers (and tests) can decide what to do from stdout/stderr/status.
 */
export interface AgentBrowserExecResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

export interface AgentBrowserExecOptions {
  /** Data written to the child's stdin (used by `batch` in JSON mode). */
  stdin?: string;
  /** Kill the child and reject after this many ms. */
  timeoutMs?: number;
}

/**
 * Test seam for invoking the agent-browser CLI. The default spawns
 * `<command...> <args...>` with no shell, so user-supplied arguments (URLs,
 * selectors, text to type) are never interpreted as shell metacharacters.
 */
export type AgentBrowserExec = (
  args: ReadonlyArray<string>,
  opts?: AgentBrowserExecOptions,
) => Promise<AgentBrowserExecResult>;

export interface AgentBrowserClientOptions {
  /**
   * Command used to invoke agent-browser, as argv. Default
   * `["npx", "agent-browser"]` so no global install is required. Pass e.g.
   * `["agent-browser"]` for a globally installed binary.
   */
  command?: string[];
  /** agent-browser `--session <name>` to scope every command to. */
  session?: string;
  /** Default timeout for a single invocation (ms). Default 30000. */
  timeoutMs?: number;
  /** Test seam: override the process runner. */
  exec?: AgentBrowserExec;
}

/** One entry of `agent-browser batch --json` output. */
export interface BatchCommandResult {
  command: string[];
  success: boolean;
  result: unknown;
  error: string | null;
}

export interface BatchOptions {
  /** Stop at the first failing command (`--bail`). Default true. */
  bail?: boolean;
  /** Override the client's default timeout for this batch. */
  timeoutMs?: number;
}

/** Shape of `agent-browser stream status --json`'s `data` field. */
export interface StreamStatus {
  enabled: boolean;
  port?: number;
  connected?: boolean;
  screencasting?: boolean;
}

export const DEFAULT_AGENT_BROWSER_COMMAND = ["npx", "agent-browser"];

/**
 * Error thrown when agent-browser exits non-zero or returns an error payload.
 * `result` carries the raw stdout/stderr so callers can surface the CLI's own
 * message rather than a generic wrapper.
 */
export class AgentBrowserError extends Error {
  constructor(
    message: string,
    public readonly args: ReadonlyArray<string>,
    public readonly result: AgentBrowserExecResult,
  ) {
    super(message);
    this.name = "AgentBrowserError";
  }
}

/**
 * Thin wrapper over the agent-browser CLI. Everything the demo recorder needs
 * is a handful of commands (`batch`, `stream status`, `stream enable`), so
 * this deliberately does not model the full CLI surface — callers can reach
 * anything else via `run()`.
 */
export class AgentBrowserClient {
  private readonly command: string[];
  private readonly session?: string;
  private readonly timeoutMs: number;
  private readonly exec: AgentBrowserExec;

  constructor(options: AgentBrowserClientOptions = {}) {
    this.command = options.command ?? DEFAULT_AGENT_BROWSER_COMMAND;
    this.session = options.session;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.exec = options.exec ?? spawnExec(this.command);
  }

  /** Global flags prepended to every invocation. */
  private globalArgs(): string[] {
    return this.session ? ["--session", this.session] : [];
  }

  /** Run an arbitrary agent-browser command. Does not throw on non-zero exit. */
  async run(
    args: ReadonlyArray<string>,
    opts: AgentBrowserExecOptions = {},
  ): Promise<AgentBrowserExecResult> {
    return this.exec([...this.globalArgs(), ...args], {
      timeoutMs: this.timeoutMs,
      ...opts,
    });
  }

  /**
   * Run a command with `--json` and parse its stdout. agent-browser prints
   * the JSON payload as the last line of stdout; anything before it (npm
   * engine warnings, progress lines) is ignored.
   */
  async runJson<T = unknown>(
    args: ReadonlyArray<string>,
    opts: AgentBrowserExecOptions = {},
  ): Promise<T> {
    const fullArgs = [...args, "--json"];
    const r = await this.run(fullArgs, opts);
    const parsed = parseJsonOutput(r.stdout);
    if (parsed === undefined) {
      throw new AgentBrowserError(
        `agent-browser ${args.join(" ")}: no JSON in output (exit ${r.status}). stderr: ${r.stderr.slice(0, 500)}`,
        fullArgs,
        r,
      );
    }
    return parsed as T;
  }

  /**
   * Run commands sequentially via `agent-browser batch` (stdin JSON mode).
   * Returns one result per command that ran. With `bail` (default) a failing
   * command stops the batch, so the array can be shorter than `commands`.
   */
  async batch(
    commands: ReadonlyArray<ReadonlyArray<string>>,
    opts: BatchOptions = {},
  ): Promise<BatchCommandResult[]> {
    const { bail = true, timeoutMs } = opts;
    const args = ["batch", ...(bail ? ["--bail"] : [])];
    const payload = await this.runJson<unknown>(args, {
      stdin: JSON.stringify(commands),
      timeoutMs,
    });
    if (!Array.isArray(payload)) {
      // A top-level object here is the CLI reporting an error of its own
      // (no browser, bad session, ...), not a per-command result.
      const err = (payload as { error?: unknown })?.error;
      throw new Error(
        `agent-browser batch failed: ${typeof err === "string" ? err : JSON.stringify(payload)}`,
      );
    }
    return payload as BatchCommandResult[];
  }

  /** `stream status --json` → its `data` field. */
  async streamStatus(): Promise<StreamStatus> {
    const payload = await this.runJson<{
      success: boolean;
      data?: StreamStatus;
      error?: string | null;
    }>(["stream", "status"]);
    if (!payload.success || !payload.data) {
      throw new Error(
        `agent-browser stream status failed: ${payload.error ?? "no data"}`,
      );
    }
    return payload.data;
  }

  /**
   * Make sure the daemon's viewport stream is up and return its WebSocket
   * URL. Returns `enabledByUs` so the caller can tear the stream down again
   * on stop without disabling a stream someone else was already using.
   */
  async ensureStream(): Promise<{ url: string; enabledByUs: boolean }> {
    let status = await this.streamStatus();
    let enabledByUs = false;
    if (!status.enabled) {
      const r = await this.run(["stream", "enable"]);
      if (r.status !== 0) {
        throw new AgentBrowserError(
          `agent-browser stream enable failed (exit ${r.status}): ${r.stderr || r.stdout}`,
          ["stream", "enable"],
          r,
        );
      }
      enabledByUs = true;
      status = await this.streamStatus();
    }
    if (!status.port) {
      throw new Error(
        `agent-browser stream is enabled but reported no port: ${JSON.stringify(status)}`,
      );
    }
    return { url: `ws://127.0.0.1:${status.port}/`, enabledByUs };
  }

  /** Best-effort `stream disable`. */
  async disableStream(): Promise<void> {
    try {
      await this.run(["stream", "disable"]);
    } catch {
      // Daemon may already be gone — nothing to clean up.
    }
  }
}

/**
 * Pull the JSON payload out of CLI stdout. Tries the whole output first,
 * then the last non-empty line (agent-browser's `--json` payload is always
 * the last line; npm may print warnings above it).
 */
export function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      return JSON.parse(line);
    } catch {
      // keep scanning upward
    }
  }
  return undefined;
}

/** Default exec: spawn `<command...> <args...>` with no shell. */
export function spawnExec(command: ReadonlyArray<string>): AgentBrowserExec {
  if (command.length === 0) {
    throw new Error("AgentBrowserClient: command must not be empty");
  }
  const [bin, ...prefix] = command;
  return (args, opts = {}) =>
    new Promise((resolvePromise, reject) => {
      const child = spawn(bin, [...prefix, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => (stdout += d));
      child.stderr.on("data", (d: string) => (stderr += d));

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn();
      };

      child.on("error", (err) => finish(() => reject(err)));
      child.on("close", (status) =>
        finish(() => resolvePromise({ stdout, stderr, status })),
      );

      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(() =>
            reject(
              new Error(
                `agent-browser ${args.join(" ")} timed out after ${opts.timeoutMs}ms`,
              ),
            ),
          );
        }, opts.timeoutMs);
      }

      if (opts.stdin !== undefined) {
        child.stdin.end(opts.stdin);
      } else {
        child.stdin.end();
      }
    });
}
