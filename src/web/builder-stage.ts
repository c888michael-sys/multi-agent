import { Buffer } from "node:buffer";
import type { Tool } from "../tools/types.js";
import type { ArtifactCandidate } from "./artifact-parser.js";
import { ARTIFACT_MAX_FILES, ARTIFACT_MAX_TOTAL_BYTES } from "./artifact-service.js";
import { WebFileService } from "./file-service.js";
import {
  evaluateCreativeWebQuality,
  parseInferredBuildBrief,
  type BuilderQualityProfile,
  type BuilderQualitySnapshot,
  type InferredBuildBrief,
} from "./builder-quality.js";

export interface BuilderStageOptions {
  maxReads?: number;
  qualityProfile?: BuilderQualityProfile;
}

/**
 * Per-request, memory-only workspace for Builder mode. Its tools deliberately
 * expose no filesystem mutation: staged files become normal artifact
 * candidates and still require the review/apply transaction to touch disk.
 */
export class BuilderStage {
  private readonly staged = new Map<string, ArtifactCandidate>();
  private readonly readPaths = new Set<string>();
  private readonly maxReads: number;
  private readonly qualityProfile?: BuilderQualityProfile;
  private brief?: InferredBuildBrief;
  private stageRevision = 0;
  private reviewedRevision = -1;
  private lastReview?: BuilderQualitySnapshot;

  constructor(private readonly files: WebFileService, options: BuilderStageOptions = {}) {
    this.maxReads = options.maxReads ?? 24;
    this.qualityProfile = options.qualityProfile;
  }

  toolset(): Tool[] {
    const tools: Tool[] = [
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
    ];
    if (this.qualityProfile === "creative-web") {
      tools.push({
        name: "define_build_brief",
        description: "Define the inferred creative brief before building an underspecified website. Make confident, coherent choices instead of producing a generic template. Explicit user requirements always win.",
        parameters: {
          type: "object",
          properties: {
            concept: { type: "string", description: "Specific site concept and purpose." },
            audience: { type: "string", description: "Who the experience is designed for." },
            visualDirection: { type: "string", description: "Typography, colour, layout, motion, and overall art direction." },
            sections: { type: "string", description: "At least four meaningful content areas, separated by semicolons." },
            interactions: { type: "string", description: "At least one purposeful interaction; separate multiple items with semicolons." },
            successCriteria: { type: "string", description: "At least three concrete outcomes, separated by semicolons." },
          },
          required: ["concept", "audience", "visualDirection", "sections", "interactions", "successCriteria"],
        },
        execute: async (args) => this.defineBrief(args),
      });
    }
    tools.push({
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
    });
    if (this.qualityProfile === "creative-web") {
      tools.push({
        name: "review_build_quality",
        description: "Run the mandatory completion review after staging every file. It rejects skeletal, placeholder, non-responsive, inaccessible, or non-interactive results. If it fails, revise the files and call this tool again before finishing.",
        parameters: { type: "object", properties: {} },
        execute: async () => this.reviewQuality(),
      });
    }
    return tools;
  }

  candidates(): ArtifactCandidate[] {
    return [...this.staged.values()];
  }

  qualitySnapshot(): BuilderQualitySnapshot | null {
    if (!this.qualityProfile) return null;
    return this.lastReview ?? evaluateCreativeWebQuality(this.brief, this.candidates());
  }

  completionStatus(): { ok: boolean; feedback: string } {
    if (!this.qualityProfile) {
      return this.staged.size > 0
        ? { ok: true, feedback: "At least one file is staged." }
        : { ok: false, feedback: "Stage at least one complete file before finishing." };
    }
    const review = this.qualitySnapshot()!;
    if (review.passed && this.reviewedRevision === this.stageRevision) {
      return { ok: true, feedback: "The inferred brief and staged files passed the quality review." };
    }
    const failures = review.checks.filter((check) => !check.passed).map((check) => `${check.label}: ${check.evidence}`);
    const stale = review.passed && this.reviewedRevision !== this.stageRevision
      ? ["Files changed after the last passing review; call review_build_quality again."]
      : [];
    return {
      ok: false,
      feedback: [...stale, ...failures, "Revise as needed, then call review_build_quality before finishing."].join("\n"),
    };
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
      if (this.readPaths.size > this.maxReads) {
        this.readPaths.delete(result.path);
        return `ERROR: Builder mode may read at most ${this.maxReads} files per request`;
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
      this.stageRevision++;
      this.reviewedRevision = -1;
      this.lastReview = undefined;
      return JSON.stringify({ staged: true, path: candidate.path, bytes: Buffer.byteLength(candidate.content, "utf8"), files: this.staged.size });
    } catch (error) {
      return `ERROR: ${(error as Error).message}`;
    }
  }

  private defineBrief(args: Record<string, unknown>): string {
    const parsed = parseInferredBuildBrief(args);
    if (!parsed.brief) return `ERROR: Invalid inferred brief:\n- ${parsed.errors.join("\n- ")}`;
    this.brief = parsed.brief;
    this.reviewedRevision = -1;
    this.lastReview = undefined;
    return JSON.stringify({ defined: true, brief: this.brief });
  }

  private reviewQuality(): string {
    if (this.qualityProfile !== "creative-web") return "ERROR: no quality profile is active";
    const review = evaluateCreativeWebQuality(this.brief, this.candidates());
    this.lastReview = review;
    if (!review.passed) {
      const failures = review.checks.filter((check) => !check.passed);
      return `ERROR: REVISION_REQUIRED\n${failures.map((check) => `- ${check.id}: ${check.evidence}`).join("\n")}\nRevise the staged files and call review_build_quality again.`;
    }
    this.reviewedRevision = this.stageRevision;
    return JSON.stringify({ ok: true, revision: this.reviewedRevision, checks: review.checks });
  }
}
