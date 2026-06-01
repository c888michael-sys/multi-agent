import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

export const FILE_MAX_BYTES = 262_144; // 256 KB per file, matches composer attachment cap

/** Paths that are always blocked from the web file browser. */
const BLOCKED_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "graphify-out",
  ".env",
]);

/** Glob-style suffix patterns that are always blocked. */
const BLOCKED_SUFFIXES = [".pem", ".key"];

/** Private-key basenames that are always blocked. */
const BLOCKED_BASENAMES = new Set(["id_rsa", "id_ed25519"]);

function isBlocked(name: string): boolean {
  if (BLOCKED_NAMES.has(name)) return true;
  if (BLOCKED_BASENAMES.has(name)) return true;
  if (name.startsWith(".env")) return true;
  for (const suffix of BLOCKED_SUFFIXES) {
    if (name.endsWith(suffix)) return true;
  }
  return false;
}

/** Check for NUL bytes in the first chunk to detect binary files. */
function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export interface DirEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  size?: number;
  readable: boolean;
}

export interface ReadResult {
  path: string;
  content: string;
  size: number;
  sha256: string;
  truncated: boolean;
}

export class WebFileService {
  readonly root: string;
  readonly maxBytes: number;
  private readonly realRoot: string;

  constructor(root: string, opts?: { maxBytes?: number }) {
    if (!isAbsolute(root)) throw new Error(`projectRoot must be absolute, got: ${root}`);
    this.root = resolve(root);
    this.realRoot = realpathSync(this.root);
    this.maxBytes = opts?.maxBytes ?? FILE_MAX_BYTES;
  }

  /**
   * Resolve a relative path against the root and verify it doesn't escape.
   * Throws with a 403-semantics message if it escapes or is blocked.
   * Also resolves symlinks via realpathSync to prevent symlink-bypass attacks.
   */
  private resolveSafe(userPath: string): string {
    // Normalize away any .. segments and check lexical containment first.
    const candidate = resolve(this.root, normalize(userPath));
    const rel = relative(this.root, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw Object.assign(new Error("path escapes root"), { code: "TRAVERSAL" });
    }
    // Check every path component for blocked names.
    const parts = rel === "" ? [] : rel.split(/[\\/]/);
    for (const part of parts) {
      if (isBlocked(part)) {
        throw Object.assign(new Error(`blocked path: ${userPath}`), { code: "BLOCKED" });
      }
    }
    // Resolve symlinks and re-verify: a symlink inside root could point outside it.
    // If the path doesn't exist yet, realpathSync throws — skip the check in that
    // case; the caller (listDir / readText) will handle the missing-path error.
    try {
      const realCandidate = realpathSync(candidate);
      const realRel = relative(this.realRoot, realCandidate);
      if (realRel.startsWith("..") || isAbsolute(realRel)) {
        throw Object.assign(new Error("path escapes root"), { code: "TRAVERSAL" });
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { code?: string };
      if (e.code === "TRAVERSAL") throw err;
      // ENOENT / ENOTDIR: path doesn't exist, let the caller handle it.
    }
    return candidate;
  }

  listDir(userPath: string): { path: string; entries: DirEntry[] } {
    const abs = this.resolveSafe(userPath);
    if (!existsSync(abs)) {
      throw Object.assign(new Error(`not found: ${userPath}`), { code: "NOT_FOUND" });
    }
    const st = statSync(abs);
    if (!st.isDirectory()) {
      throw Object.assign(new Error(`not a directory: ${userPath}`), { code: "NOT_DIR" });
    }

    const rawNames = readdirSync(abs);
    // Dirs first, then files, each group alphabetical. Symlinks are skipped —
    // they could point outside the root and are not needed in the browser.
    const dirs: DirEntry[] = [];
    const files: DirEntry[] = [];
    for (const name of rawNames) {
      if (isBlocked(name)) continue;
      const childAbs = join(abs, name);
      let childSt;
      try { childSt = statSync(childAbs); } catch { continue; }
      // lstat detects symlinks without following them; skip to prevent bypass.
      let childLst;
      try { childLst = lstatSync(childAbs); } catch { continue; }
      if (childLst.isSymbolicLink()) continue;
      const rel = relative(this.root, childAbs).replace(/\\/g, "/");
      if (childSt.isDirectory()) {
        dirs.push({ name, path: rel, kind: "dir", readable: true });
      } else {
        files.push({
          name,
          path: rel,
          kind: "file",
          size: childSt.size,
          readable: childSt.size <= this.maxBytes,
        });
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    const normalizedPath = userPath === "." || userPath === "" ? "." : relative(this.root, abs).replace(/\\/g, "/");
    return { path: normalizedPath, entries: [...dirs, ...files] };
  }

  readText(userPath: string): ReadResult {
    const abs = this.resolveSafe(userPath);
    if (!existsSync(abs)) {
      throw Object.assign(new Error(`not found: ${userPath}`), { code: "NOT_FOUND" });
    }
    const st = statSync(abs);
    if (st.isDirectory()) {
      throw Object.assign(new Error(`path is a directory: ${userPath}`), { code: "IS_DIR" });
    }
    if (st.size > this.maxBytes) {
      throw Object.assign(
        new Error(`file too large (${st.size} bytes; max ${this.maxBytes})`),
        { code: "TOO_LARGE" },
      );
    }
    const buf = readFileSync(abs);
    if (isBinary(buf)) {
      throw Object.assign(new Error("binary files are not supported"), { code: "BINARY" });
    }
    let content: string;
    try {
      content = buf.toString("utf8");
    } catch {
      throw Object.assign(new Error("binary files are not supported"), { code: "BINARY" });
    }
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const rel = relative(this.root, abs).replace(/\\/g, "/");
    return { path: rel, content, size: st.size, sha256, truncated: false };
  }
}
