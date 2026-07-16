import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import { FILE_MAX_BYTES, WebFileService } from "./file-service.js";
import type { ArtifactCandidate } from "./artifact-parser.js";

export const ARTIFACT_MAX_FILES = 40;
export const ARTIFACT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const ARTIFACT_MAX_LIVE_PROPOSALS = 20;
export const ARTIFACT_MAX_MEMORY_BYTES = 10 * 1024 * 1024;
export const ARTIFACT_PROPOSAL_TTL_MS = 30 * 60 * 1000;
export const ARTIFACT_TRANSACTION_TTL_MS = 10 * 60 * 1000;
export const ARTIFACT_MAX_TRANSACTIONS = 5;

export type ArtifactOperation = "create" | "update" | "unchanged";
export type ArtifactProposalState = "pending" | "applied" | "cancelled" | "expired";

export interface ArtifactProjectContext {
  project: { id: string; name: string; root: string };
  revision: string;
  files: WebFileService;
}

export interface ArtifactProposalFile {
  id: string;
  path: string;
  language?: string;
  bytes: number;
  operation: ArtifactOperation;
  beforeSha256: string | null;
  afterSha256: string;
}

export interface ArtifactProposal {
  id: string;
  projectId: string;
  projectRevision: string;
  sessionId: string;
  sourceTurnId: string;
  title: string;
  state: ArtifactProposalState;
  createdAt: number;
  expiresAt: number;
  files: ArtifactProposalFile[];
}

interface StoredFile extends ArtifactProposalFile {
  content: string;
}

interface StoredProposal extends Omit<ArtifactProposal, "files"> {
  files: StoredFile[];
}

interface TransactionFile {
  path: string;
  beforeContent: string | null;
  expectedAfterSha256: string;
}

interface ArtifactTransaction {
  id: string;
  projectId: string;
  projectRevision: string;
  undoToken: string;
  expiresAt: number;
  files: TransactionFile[];
}

export class ArtifactService {
  private readonly proposals = new Map<string, StoredProposal>();
  private readonly transactions = new Map<string, ArtifactTransaction>();

  constructor(private readonly projectContext: (projectId: string) => ArtifactProjectContext) {}

  create(input: {
    projectId: string;
    sessionId: string;
    sourceTurnId: string;
    title?: string;
    basePath?: string;
    files: ArtifactCandidate[];
  }): ArtifactProposal {
    this.sweep();
    if (!input.projectId || !input.sessionId || !input.sourceTurnId) {
      throw artifactError("INVALID_ARTIFACT", "projectId, sessionId, and sourceTurnId are required");
    }
    if (!Array.isArray(input.files) || input.files.length === 0) {
      throw artifactError("INVALID_ARTIFACT", "at least one file is required");
    }
    if (input.files.length > ARTIFACT_MAX_FILES) {
      throw artifactError("TOO_MANY_FILES", `a proposal may contain at most ${ARTIFACT_MAX_FILES} files`);
    }
    if (this.proposals.size >= ARTIFACT_MAX_LIVE_PROPOSALS) {
      throw artifactError("PROPOSAL_CAPACITY", "too many live artifact proposals; cancel or apply one first");
    }

    const context = this.projectContext(input.projectId);
    const basePath = normalizeBasePath(input.basePath ?? "");
    let totalBytes = 0;
    const seenPaths = new Set<string>();
    const files: StoredFile[] = input.files.map((candidate, index) => {
      if (!candidate || typeof candidate.path !== "string" || typeof candidate.content !== "string") {
        throw artifactError("INVALID_ARTIFACT", "each candidate requires string path and content");
      }
      const path = normalizeCandidatePath(basePath, candidate.path);
      const dedupe = path.toLocaleLowerCase("en-US");
      if (seenPaths.has(dedupe)) throw artifactError("DUPLICATE_PATH", `duplicate proposal path: ${path}`);
      seenPaths.add(dedupe);
      const bytes = Buffer.byteLength(candidate.content, "utf8");
      if (bytes > FILE_MAX_BYTES) throw artifactError("TOO_LARGE", `${path} exceeds the ${FILE_MAX_BYTES} byte file limit`);
      totalBytes += bytes;
      if (totalBytes > ARTIFACT_MAX_TOTAL_BYTES) throw artifactError("TOO_LARGE", "proposal content exceeds the 2 MB total limit");
      const diff = context.files.buildDiff(path, candidate.content);
      return {
        id: `af_${index + 1}_${randomBytes(5).toString("hex")}`,
        path,
        language: typeof candidate.language === "string" ? candidate.language.slice(0, 40) : undefined,
        bytes,
        operation: diff.beforeSha256 === null ? "create" : diff.diff ? "update" : "unchanged",
        beforeSha256: diff.beforeSha256,
        afterSha256: sha256(candidate.content),
        content: candidate.content,
      };
    });

    const memory = [...this.proposals.values()].reduce((sum, proposal) => sum + proposal.files.reduce((n, file) => n + file.bytes, 0), 0);
    if (memory + totalBytes > ARTIFACT_MAX_MEMORY_BYTES) {
      throw artifactError("PROPOSAL_CAPACITY", "proposal memory limit reached; cancel or apply a proposal first");
    }
    const now = Date.now();
    const proposal: StoredProposal = {
      id: `ap_${randomBytes(12).toString("hex")}`,
      projectId: input.projectId,
      projectRevision: context.revision,
      sessionId: input.sessionId,
      sourceTurnId: input.sourceTurnId,
      title: safeTitle(input.title),
      state: "pending",
      createdAt: now,
      expiresAt: now + ARTIFACT_PROPOSAL_TTL_MS,
      files,
    };
    this.proposals.set(proposal.id, proposal);
    return publicProposal(proposal);
  }

  getDiff(proposalId: string, fileId: string): { proposal: ArtifactProposal; file: ArtifactProposalFile; diff: string } {
    const proposal = this.requirePending(proposalId);
    const context = this.requireCurrentProject(proposal);
    const file = proposal.files.find((item) => item.id === fileId);
    if (!file) throw artifactError("FILE_NOT_FOUND", "proposal file not found");
    const diff = context.files.buildDiff(file.path, file.content);
    return { proposal: publicProposal(proposal), file: publicFile(file), diff: diff.diff };
  }

  apply(input: { proposalId: string; projectId: string; projectRevision: string; fileIds?: string[]; confirm: boolean }): {
    proposal: ArtifactProposal;
    transactionId: string;
    undoToken: string;
    undoExpiresAt: number;
    appliedFileIds: string[];
  } {
    if (!input.confirm) throw artifactError("CONFIRMATION_REQUIRED", "explicit confirmation is required to apply files");
    const proposal = this.requirePending(input.proposalId);
    if (proposal.projectId !== input.projectId || proposal.projectRevision !== input.projectRevision) {
      throw artifactError("PROJECT_CONTEXT_CHANGED", "the active project changed; refresh the proposal before applying");
    }
    const context = this.requireCurrentProject(proposal);
    const selected = this.selectFiles(proposal, input.fileIds).filter((file) => file.operation !== "unchanged");
    if (selected.length === 0) throw artifactError("NO_CHANGES", "select at least one changed file to apply");

    // Verify every selected file before changing any of them.
    for (const file of selected) {
      const current = context.files.buildDiff(file.path, file.content);
      if (current.beforeSha256 !== file.beforeSha256) {
        throw artifactError("ARTIFACT_CONFLICT", `file changed since review: ${file.path}`);
      }
    }

    const backups = selected.map((file) => ({
      file,
      beforeContent: file.beforeSha256 === null ? null : context.files.readText(file.path).content,
    }));
    const applied: StoredFile[] = [];
    try {
      for (const item of backups) {
        context.files.writeText(item.file.path, item.file.content, item.file.beforeSha256);
        applied.push(item.file);
      }
    } catch (cause) {
      const rollbackFailures: string[] = [];
      for (const item of backups.slice(0, applied.length).reverse()) {
        try {
          if (item.beforeContent === null) context.files.deleteText(item.file.path, item.file.afterSha256);
          else context.files.writeText(item.file.path, item.beforeContent, item.file.afterSha256);
        } catch {
          rollbackFailures.push(item.file.path);
        }
      }
      const error = artifactError("ARTIFACT_APPLY_FAILED", "the batch could not be applied");
      (error as Error & { cause?: unknown; rollbackFailures?: string[] }).cause = cause;
      (error as Error & { rollbackFailures?: string[] }).rollbackFailures = rollbackFailures;
      throw error;
    }

    proposal.state = "applied";
    const transaction = this.storeTransaction(proposal, backups);
    return {
      proposal: publicProposal(proposal),
      transactionId: transaction.id,
      undoToken: transaction.undoToken,
      undoExpiresAt: transaction.expiresAt,
      appliedFileIds: selected.map((file) => file.id),
    };
  }

  rollback(input: { transactionId: string; projectId: string; projectRevision: string; undoToken: string; confirm: boolean }): { rolledBack: true } {
    this.sweep();
    if (!input.confirm) throw artifactError("CONFIRMATION_REQUIRED", "explicit confirmation is required to undo files");
    const transaction = this.transactions.get(input.transactionId);
    if (!transaction) throw artifactError("TRANSACTION_NOT_FOUND", "artifact transaction not found or expired");
    if (transaction.projectId !== input.projectId || transaction.projectRevision !== input.projectRevision || transaction.undoToken !== input.undoToken) {
      throw artifactError("PROJECT_CONTEXT_CHANGED", "the transaction does not belong to the current project");
    }
    const context = this.projectContext(input.projectId);
    if (context.revision !== transaction.projectRevision) throw artifactError("PROJECT_CONTEXT_CHANGED", "the active project changed");
    for (const file of transaction.files) {
      const current = context.files.buildDiff(file.path, file.beforeContent ?? "");
      if (current.beforeSha256 !== file.expectedAfterSha256) {
        throw artifactError("ARTIFACT_CONFLICT", `file changed after apply: ${file.path}`);
      }
    }
    for (const file of [...transaction.files].reverse()) {
      if (file.beforeContent === null) context.files.deleteText(file.path, file.expectedAfterSha256);
      else context.files.writeText(file.path, file.beforeContent, file.expectedAfterSha256);
    }
    this.transactions.delete(transaction.id);
    return { rolledBack: true };
  }

  cancel(proposalId: string): { cancelled: true } {
    const proposal = this.requirePending(proposalId);
    proposal.state = "cancelled";
    this.proposals.delete(proposalId);
    return { cancelled: true };
  }

  private requirePending(id: string): StoredProposal {
    this.sweep();
    const proposal = this.proposals.get(id);
    if (!proposal) throw artifactError("PROPOSAL_NOT_FOUND", "artifact proposal not found or expired");
    if (proposal.state !== "pending") throw artifactError("PROPOSAL_NOT_PENDING", "artifact proposal is no longer pending");
    return proposal;
  }

  private requireCurrentProject(proposal: StoredProposal): ArtifactProjectContext {
    const context = this.projectContext(proposal.projectId);
    if (context.revision !== proposal.projectRevision) {
      throw artifactError("PROJECT_CONTEXT_CHANGED", "the active project changed; refresh the proposal");
    }
    return context;
  }

  private selectFiles(proposal: StoredProposal, ids?: string[]): StoredFile[] {
    if (ids === undefined) return proposal.files;
    if (!Array.isArray(ids) || ids.length === 0) throw artifactError("INVALID_ARTIFACT", "fileIds must be a non-empty array when provided");
    const byId = new Map(proposal.files.map((file) => [file.id, file]));
    return ids.map((id) => {
      const file = byId.get(id);
      if (!file) throw artifactError("FILE_NOT_FOUND", "selected proposal file not found");
      return file;
    });
  }

  private storeTransaction(proposal: StoredProposal, backups: { file: StoredFile; beforeContent: string | null }[]): ArtifactTransaction {
    this.sweep();
    while (this.transactions.size >= ARTIFACT_MAX_TRANSACTIONS) {
      const oldest = this.transactions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.transactions.delete(oldest);
    }
    const transaction: ArtifactTransaction = {
      id: `at_${randomBytes(12).toString("hex")}`,
      projectId: proposal.projectId,
      projectRevision: proposal.projectRevision,
      undoToken: randomBytes(24).toString("hex"),
      expiresAt: Date.now() + ARTIFACT_TRANSACTION_TTL_MS,
      files: backups.map(({ file, beforeContent }) => ({
        path: file.path,
        beforeContent,
        expectedAfterSha256: file.afterSha256,
      })),
    };
    this.transactions.set(transaction.id, transaction);
    return transaction;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, proposal] of this.proposals) {
      if (proposal.expiresAt <= now) this.proposals.delete(id);
    }
    for (const [id, transaction] of this.transactions) {
      if (transaction.expiresAt <= now) this.transactions.delete(id);
    }
  }
}

export function artifactError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function publicFile(file: StoredFile): ArtifactProposalFile {
  const { content: _content, ...publicFile } = file;
  return publicFile;
}

function publicProposal(proposal: StoredProposal): ArtifactProposal {
  return { ...proposal, files: proposal.files.map(publicFile) };
}

function normalizeBasePath(basePath: string): string {
  if (!basePath || basePath === ".") return "";
  return normalizeRelativePath(basePath);
}

function normalizeCandidatePath(basePath: string, candidatePath: string): string {
  const relative = normalizeRelativePath(candidatePath);
  const fullPath = basePath ? `${basePath}/${relative}` : relative;
  if (fullPath.length > 240) throw artifactError("INVALID_PATH", "path exceeds 240 characters");
  return fullPath;
}

function normalizeRelativePath(value: string): string {
  if (!value || value !== value.trim() || value.length > 240 || /[\\:\0-\x1f]/.test(value)) {
    throw artifactError("INVALID_PATH", "path must be a non-empty, clean project-relative POSIX path");
  }
  if (value.startsWith("/") || value.startsWith("//") || /^[a-zA-Z]:/.test(value)) {
    throw artifactError("INVALID_PATH", "absolute paths are not allowed");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw artifactError("INVALID_PATH", "path may not contain empty, . or .. components");
  }
  if (posix.normalize(value) !== value) throw artifactError("INVALID_PATH", "path is not normalised");
  return value;
}

function safeTitle(value: string | undefined): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : "Proposed files";
}

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}
