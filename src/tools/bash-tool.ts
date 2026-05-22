import { spawn } from "node:child_process";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { Tool } from "./types.js";

export interface BashToolOptions {
  /** Absolute path used as the command's cwd. */
  workdir: string;
  /** Max wall-clock time before SIGKILL. Default 30_000 (30s). */
  timeoutMs?: number;
  /** Max combined stdout+stderr bytes returned to the model. Default 50_000. */
  maxBytes?: number;
}

/**
 * A `bash` tool that runs a shell command and returns combined stdout+stderr
 * plus the exit code. Cross-platform: cmd.exe on Windows, /bin/sh elsewhere.
 *
 * No sandboxing — the model can run anything the user can run. This is why
 * the CLI gates it behind a separate --allow-bash flag instead of being part
 * of the default toolset.
 */
export class BashTool {
  readonly workdir: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;

  constructor(opts: BashToolOptions) {
    if (!isAbsolute(opts.workdir)) {
      throw new Error(`BashTool workdir must be absolute, got: ${opts.workdir}`);
    }
    this.workdir = resolvePath(opts.workdir);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxBytes = opts.maxBytes ?? 50_000;
  }

  asTool(): Tool {
    return {
      name: "bash",
      description: `Run a shell command in the working directory. Returns combined stdout and stderr followed by an "exit code: N" line. Times out at ${Math.floor(
        this.timeoutMs / 1000,
      )}s, output capped at ${this.maxBytes} bytes. On Windows the shell is cmd.exe; on Unix it's /bin/sh.`,
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run." },
        },
        required: ["command"],
      },
      execute: async (args) => {
        const command = String(args.command ?? "");
        if (!command) return "ERROR: missing 'command' argument";
        try {
          return await this.runOnce(command);
        } catch (err) {
          return `ERROR: ${(err as Error).message}`;
        }
      },
    };
  }

  async runOnce(command: string): Promise<string> {
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const args = isWindows ? ["/c", command] : ["-c", command];

    return new Promise<string>((resolvePromise) => {
      const child = spawn(shell, args, { cwd: this.workdir, windowsHide: true });
      const chunks: Buffer[] = [];
      let totalLen = 0;
      let truncated = false;
      let killedByTimeout = false;

      // On Windows, child.kill() only kills cmd.exe — not its descendant
      // processes. Use taskkill /T /F to kill the whole tree.
      const killTree = () => {
        try {
          if (isWindows && child.pid !== undefined) {
            spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true });
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          // ignore
        }
      };

      const onData = (buf: Buffer) => {
        if (truncated) return;
        const remaining = this.maxBytes - totalLen;
        if (remaining <= 0) {
          truncated = true;
          killTree();
          return;
        }
        if (buf.length > remaining) {
          chunks.push(buf.subarray(0, remaining));
          totalLen += remaining;
          truncated = true;
          killTree();
        } else {
          chunks.push(buf);
          totalLen += buf.length;
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      const timer = setTimeout(() => {
        killedByTimeout = true;
        killTree();
      }, this.timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        resolvePromise(`ERROR: failed to spawn shell: ${err.message}`);
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const body = Buffer.concat(chunks).toString("utf8");
        const footer = killedByTimeout
          ? `\n--- killed: timed out after ${this.timeoutMs}ms ---`
          : truncated
            ? `\n--- truncated at ${this.maxBytes} bytes ---`
            : "";
        const exit = code !== null ? `exit code: ${code}` : `signal: ${signal ?? "unknown"}`;
        resolvePromise(`${body}${footer}\n${exit}`);
      });
    });
  }
}
