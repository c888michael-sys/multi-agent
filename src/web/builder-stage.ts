import { Buffer } from "node:buffer";
import type { Tool } from "../tools/types.js";
import type { ArtifactCandidate } from "./artifact-parser.js";
import { ARTIFACT_MAX_FILES, ARTIFACT_MAX_TOTAL_BYTES } from "./artifact-service.js";
import { WebFileService } from "./file-service.js";

/**
 * Per-request, memory-only workspace for Builder mode. Its tools deliberately
 * expose no filesystem mutation: staged files become normal artifact
 * candidates and still require the review/apply transaction to touch disk.
 */
export class BuilderStage {
  private readonly staged = new Map<string, ArtifactCandidate>();
  private readonly readPaths = new Set<string>();

  constructor(private readonly files: WebFileService, private readonly limits = { maxReads: 24 }) {}

  toolset(): Tool[] {
    return [
      {
        name: "list_project",
        description: "List a directory in the selected project. Paths are relative; blocked and linked paths are excluded.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Relative directory path, or . for the project root." } },
          required: ["path"],
        },
        execute: async (args) => this.list(args),
      },
      {
        name: "read_project_file",
        description: "Read one bounded UTF-8 text file from the selected project. Paths are relative and cannot escape the project.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Relative text-file path." } },
          required: ["path"],
        },
        execute: async (args) => this.read(args),
      },
      {
        name: "stage_file",
        description: "Stage a complete text file in an isolated review workspace. This does not write to the project; every staged file must later be reviewed and explicitly applied by the user.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative destination path." },
            content: { type: "string", description: "Complete UTF-8 file content." },
            language: { type: "string", description: "Optional language label." },
          },
          required: ["path", "content"],
        },
        execute: async (args) => this.stage(args),
      },
    ];
  }

  candidates(): ArtifactCandidate[] {
    return [...this.staged.values()];
  }

  private list(args: Record<string, unknown>): string {
    const path = typeof args.path === "string" && args.path.trim() ? args.path : ".";
    try {
      const result = this.files.listDir(path);
      return JSON.stringify({
        path: result.path,
        entries: result.entries.map(({ name, path: entryPath, kind, size, readable }) => ({ name, path: entryPath, kind, size, readable })),
      });
    } catch (error) {
      return `ERROR: ${(error as Error).message}`;
    }
  }

  private read(args: Record<string, unknown>): string {
    if (typeof args.path !== "string" || !args.path.trim()) return "ERROR: path is required";
    try {
      const result = this.files.readText(args.path);
      this.readPaths.add(result.path);
      if (this.readPaths.size > this.limits.maxReads) {
        this.readPaths.delete(result.path);
        return `ERROR: Builder mode may read at most ${this.limits.maxReads} files per request`;
      }
      return JSON.stringify({ path: result.path, content: result.content, bytes: result.size, sha256: result.sha256 });
    } catch (error) {
      return `ERROR: ${(error as Error).message}`;
    }
  }

  private stage(args: Record<string, unknown>): string {
    if (typeof args.path !== "string" || !args.path.trim() || typeof args.content !== "string") {
      return "ERROR: path and content are required";
    }
    try {
      // buildDiff validates the destination against the same project boundary,
      // blocked-name, symlink and UTF-8 size rules as the actual apply path.
      const checked = this.files.buildDiff(args.path, args.content);
      const candidate: ArtifactCandidate = {
        path: checked.path,
        content: args.content,
        ...(typeof args.language === "string" && args.language.trim() ? { language: args.language.trim().slice(0, 40) } : {}),
      };
      const key = candidate.path.toLocaleLowerCase("en-US");
      const existing = this.staged.get(key);
      if (!existing && this.staged.size >= ARTIFACT_MAX_FILES) {
        return `ERROR: Builder mode may stage at most ${ARTIFACT_MAX_FILES} files`;
      }
      const totalBytes = [...this.staged.entries()].reduce((total, [entryKey, file]) => (
        total + (entryKey === key ? 0 : Buffer.byteLength(file.content, "utf8"))
      ), Buffer.byteLength(candidate.content, "utf8"));
      if (totalBytes > ARTIFACT_MAX_TOTAL_BYTES) {
        return `ERROR: staged content exceeds the ${ARTIFACT_MAX_TOTAL_BYTES} byte total limit`;
      }
      this.staged.set(key, candidate);
      return JSON.stringify({ staged: true, path: candidate.path, bytes: Buffer.byteLength(candidate.content, "utf8"), files: this.staged.size });
    } catch (error) {
      return `ERROR: ${(error as Error).message}`;
    }
  }
}
