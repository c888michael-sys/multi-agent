# Switchable project (root folder + pinned file) — design

**Date:** 2026-06-02
**Status:** Approved, pre-implementation

## Goal

Let the user switch the active "project" at runtime in **both CLI and web**. A project is a **root folder** plus an optional **pinned file** within it. There is one **global active project** at a time, backed by a small **registry** the user manages (create / delete / switch). New project roots are constrained to a **configured allow-list** of base directories.

Today this is not possible:

- **Web:** `WebFileService` is constructed once at server boot from `opts.projectRoot ?? process.cwd()` (`src/web/server.ts:163`) and frozen for the server lifetime. No UI control or endpoint changes it.
- **CLI:** `--workdir=<path>` scopes file tools per command (default cwd), but there is no persistent "current project" concept.

## Chosen approach

**Approach 1 — Shared project store + mutable web fileService.** A new `src/project/store.ts` owns `~/.multi-agent/projects.json` as the single source of truth, consumed by both CLI and web. The web server holds a reassignable `fileService` reference rebuilt on project switch. CLI commands and chat-REPL slash commands read/write the same store. `ask` / `chat` / `serve` / `task` default their root to the active project; an explicit `--workdir` (or `serve` projectRoot) still wins.

Rejected: per-request fileService resolution (needless overhead for a single-user local app); web-only localStorage registry (can't be shared with the CLI, and the user wants CLI create/delete).

## 1. Data model & shared store

New module `src/project/store.ts`, single source of truth at `~/.multi-agent/projects.json`. It mirrors the existing `src/roles/instructions.ts` version / normalize / read / write resilience pattern.

```jsonc
{
  "version": 1,
  "activeId": "p_a1b2",
  "projects": [
    {
      "id": "p_a1b2",
      "name": "multi-agent",
      "root": "C:\\Users\\Michael\\Desktop\\multi-agent",
      "pinnedFile": null,
      "createdAt": 0,
      "updatedAt": 0
    }
  ]
}
```

**Types:** `Project { id, name, root, pinnedFile: string | null, createdAt, updatedAt }`, `ProjectSet { version: 1, activeId: string, projects: Project[] }`.

**API:**

- `readProjects(path?)` / `writeProjects(path, set)`
- `listProjects()`
- `getActiveProject()`
- `addProject({ name, root, pinnedFile? })` — validates allow-list + name uniqueness
- `setActiveProject(id)`
- `removeProject(id)`
- `setPinnedFile(id, relPath | null)`
- `resolveAllowList()` — read env, return absolute base dirs
- `assertWithinAllowList(root)` — throws on violation

**Rules:**

- Project `name`s are unique (case-insensitive). Duplicate → error (`409`-semantics in web, clear CLI message).
- A new `root` must resolve under one of the allow-list base directories.
- `pinnedFile` (when set) must resolve under its own project `root`; stored as a root-relative POSIX path.
- Removing the **active** project auto-reassigns `activeId` to the first remaining project.
- Removing the **last** project is refused.
- Corrupt / unreadable `projects.json` falls back to a **seeded default**: one project whose root is the launch cwd, marked active. (Same advisory-file philosophy as role-instructions and `state.json`.)
- IDs are generated (e.g. `p_` + short random hex); names are display labels and may be renamed in a future pass (rename is out of scope for v1).

## 2. Allow-list

- Env var `MULTI_AGENT_PROJECT_ROOTS` — an OS path-delimited (`path.delimiter`) list of base directories.
- **Default when unset:** the **parent of the launch directory** (`dirname(process.cwd())`), so from `Desktop\multi-agent` the user can pick any sibling project under `Desktop`. The launch cwd itself is always implicitly allowed even if it lies outside the configured bases.
- Validation reuses the same lexical-containment (`relative(base, candidate)` not starting with `..` / not absolute) plus `realpathSync` symlink re-check already implemented in `WebFileService.resolveSafe`. Factor that containment check into a shared helper so the store and the file service agree.

## 3. Web (Approach 1)

### Server (`src/web/server.ts`)

- Replace the single `const fileService` with a reassignable `let fileService`, plus a `rebuildFileService()` that reads the active project root and reconstructs `WebFileService`.
- `ServerOptions` gains `projectsPath?: string` (tests override; default is the real `~/.multi-agent/projects.json`). On boot, seed/read the store; initial `fileService` points at the active project's root. `opts.projectRoot`, when supplied, seeds/overrides the initial active project root (keeps existing test behavior working).
- New endpoints (state-changing ones reuse the existing localhost `Origin` guard used by the file write endpoints):
  - `GET /api/projects` → `{ active: Project, projects: Project[], allowList: string[] }`
  - `POST /api/projects` body `{ name, root, pinnedFile? }` → add; `403` outside allow-list, `409` duplicate name, `400` invalid body. Returns the new project + updated list.
  - `POST /api/projects/active` body `{ id }` → switch active, call `rebuildFileService()`, return the new active project; `404` unknown id.
  - `POST /api/projects/delete` body `{ id }` → remove; `409` if it is the last project; returns updated list + (possibly reassigned) active.
  - `POST /api/projects/pin` body `{ path: string | null }` → set the **active** project's pinned file; `403` if path escapes root, `404` if file missing.
- Extend `GET /api/files/root` response with `{ activeProjectId, projectName, pinnedFile }` so the drawer can render project context.

### UI (`src/web/static/app.jsx`, `style.css`)

A project selector at the **top of the existing files drawer**:

- Dropdown listing all projects, active one highlighted; selecting one calls `/api/projects/active` then reloads the file listing at `.`.
- "＋ New" inline form: name field + path field (validated against the allow-list; inline error on `403`/`409`, no `alert()`).
- A trash/delete control per project (confirm inline); disabled when only one project remains.
- A ★ toggle on the previewed file pins it as the active project's focus file (`POST /api/projects/pin`); the pinned file auto-opens when the drawer is opened.
- All errors render inline in the drawer, consistent with the existing blocked/binary/too-large states.

## 4. CLI (`src/cli.ts`, `src/chat/repl.ts`)

- New top-level `project` command:
  - `project` / `project list` — list projects, mark the active one.
  - `project current` — show active project (name, root, pinnedFile).
  - `project add <name> <path>` — create (allow-list validated).
  - `project use <name|id>` — set active.
  - `project remove <name|id>` — delete (reassign active if needed; refuse if last).
  - `project pin <path>` / `project unpin` — set/clear the active project's pinned file.
- `/project ...` slash commands in the `chat` REPL mirroring the above subcommands.
- Default-root wiring: `ask` / `task` / `chat` / `serve` use the **active project root** when `--workdir` (or, for `serve`, the project root) is not explicitly passed. An explicit `--workdir` always wins. `serve` gains a `--project=<name|id>` convenience flag to pick the active project for that launch.
- Help text (`printHelp`) updated to document the `project` command and the new flag.

## 5. Error handling

- Allow-list rejection → `403` (web) / clear non-zero-exit error (CLI).
- Switching to a project whose `root` no longer exists on disk → the project stays in the registry but is flagged unavailable; file listing returns a not-found-style error and the CLI/UI surface a warning rather than crashing.
- Corrupt `projects.json` → seeded default (see §1).
- Duplicate name and last-project-delete → refused with a clear message.

## 6. Tests & docs

- `tests/project-store.test.ts` — add / use / remove / pin happy paths; allow-list rejection; traversal in `root` and in `pinnedFile`; last-project delete guard; active reassignment on delete; duplicate-name rejection; corrupt-file normalize → seeded default.
- `tests/web-server.test.ts` — project endpoints: list; add (allowed + rejected); switch active **actually re-points** `listDir` to the new root; delete (incl. last-project `409`); pin; and `/api/files/root` carries `activeProjectId` / `projectName` / `pinnedFile`.
- `README.md` — update the "Web project file tools" section to describe switchable projects, add the `project` CLI command to the command list, and tick a roadmap item. Ships in the same commit as the feature per repo convention.

## YAGNI / out of scope for v1

- **Pinned file is a focus pointer only** — the UI auto-opens it and the CLI reports it; it is **not** auto-injected into chat context. Auto-attach is a possible later enhancement.
- Project **rename** is out of scope for v1 (delete + recreate covers it).
- **Per-session** project roots are out of scope; the active project is global, per the chosen model.
