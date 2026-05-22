import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Tool } from "./types.js";

/**
 * Path-confined file tools. Every operation resolves the user-supplied path
 * against `workdir` and rejects anything that escapes (via "..", symlinks,
 * absolute paths outside the root).
 *
 * `workdir` should be an absolute path. Use `process.cwd()` for "current
 * project root."
 */
export class FileTools {
  readonly workdir: string;
  readonly maxBytes: number;

  constructor(workdir: string, opts?: { maxBytes?: number }) {
    if (!isAbsolute(workdir)) {
      throw new Error(`FileTools workdir must be absolute, got: ${workdir}`);
    }
    this.workdir = resolve(workdir);
    this.maxBytes = opts?.maxBytes ?? 200_000; // ~200 KB per read, keeps prompts sane
  }

  /** Resolve a user path against workdir; throw if it escapes. */
  resolveSafe(userPath: string): string {
    const candidate = resolve(this.workdir, userPath);
    const rel = relative(this.workdir, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`path escapes workdir: ${userPath}`);
    }
    return candidate;
  }

  toolset(): Tool[] {
    return [this.readFileTool(), this.writeFileTool(), this.listDirTool()];
  }

  readFileTool(): Tool {
    return {
      name: "read_file",
      description:
        "Read the contents of a text file inside the working directory. Paths are relative to the working directory and cannot escape it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file, relative to working directory." },
        },
        required: ["path"],
      },
      execute: async (args) => {
        const path = String(args.path ?? "");
        if (!path) return "ERROR: missing 'path' argument";
        try {
          const abs = this.resolveSafe(path);
          if (!existsSync(abs)) return `ERROR: file not found: ${path}`;
          const st = statSync(abs);
          if (st.isDirectory()) return `ERROR: path is a directory: ${path}`;
          if (st.size > this.maxBytes) {
            return `ERROR: file too large (${st.size} bytes; max ${this.maxBytes}). Read a smaller file or chunk it.`;
          }
          return readFileSync(abs, "utf8");
        } catch (err) {
          return `ERROR: ${(err as Error).message}`;
        }
      },
    };
  }

  writeFileTool(): Tool {
    return {
      name: "write_file",
      description:
        "Write or overwrite a text file inside the working directory. Creates intermediate directories as needed. Use for creating new files or replacing existing ones entirely.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to write, relative to working directory." },
          content: { type: "string", description: "Full file content to write." },
        },
        required: ["path", "content"],
      },
      execute: async (args) => {
        const path = String(args.path ?? "");
        const content = String(args.content ?? "");
        if (!path) return "ERROR: missing 'path' argument";
        try {
          const abs = this.resolveSafe(path);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, content, "utf8");
          return `OK: wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`;
        } catch (err) {
          return `ERROR: ${(err as Error).message}`;
        }
      },
    };
  }

  listDirTool(): Tool {
    return {
      name: "list_dir",
      description:
        "List the contents of a directory inside the working directory. Returns one entry per line, prefixed with [file] or [dir]. Use '.' for the working directory root.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path relative to working directory. Use '.' for the root.",
          },
        },
        required: ["path"],
      },
      execute: async (args) => {
        const path = String(args.path ?? ".");
        try {
          const abs = this.resolveSafe(path);
          if (!existsSync(abs)) return `ERROR: directory not found: ${path}`;
          const st = statSync(abs);
          if (!st.isDirectory()) return `ERROR: path is not a directory: ${path}`;
          const entries = readdirSync(abs)
            .sort()
            .map((name) => {
              const child = join(abs, name);
              try {
                const cs = statSync(child);
                return cs.isDirectory() ? `[dir]  ${name}` : `[file] ${name}`;
              } catch {
                return `[?]    ${name}`;
              }
            });
          return entries.length === 0 ? "(empty)" : entries.join("\n");
        } catch (err) {
          return `ERROR: ${(err as Error).message}`;
        }
      },
    };
  }
}
