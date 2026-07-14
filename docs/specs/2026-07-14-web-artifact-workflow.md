# Web artifact workflow

Status: implementation-ready specification
Date: 14 July 2026
Target: local web UI
Priority: high

## Decision summary

The web app will support a review-first artifact workflow:

1. The user chooses an active project and asks the model to create or update files.
2. The normal streamed answer remains fast and may contain a complete multi-file proposal.
3. The app groups those files into one artifact card.
4. The server validates the proposal against the selected project and produces create/update/unchanged previews.
5. The user reviews the exact destination, files and diffs, then explicitly applies one selected batch.
6. The server revalidates every path and hash before writing. A conflict changes nothing.

The model never receives a direct disk-write or shell tool in V1. It proposes content; only the reviewed artifact service writes it. This is the main safety boundary.

## Why this is needed

The current implementation has useful primitives but not a complete workflow:

- `detectFileEdits` finds path-labelled fenced blocks, but renders a separate apply button for each file.
- `FileDrawer` is a single-file browser/editor, not a multi-file review surface.
- `WebFileService.writeText(path, content, null)` can create a text file and missing parent folders.
- `WebFileService.buildDiff` rejects a missing file, so the frontend cannot get the diff required to apply a new file.
- Web `ChatSession` instances receive no file tools, so asking the model to build a website does not write it.
- The active project is mutable global state. A proposal must never silently move to a newly selected project.
- The HTTP body reader is currently unbounded.

Relevant anchors:

- `src/web/static/app.jsx`: `detectFileEdits`, `ChatTurn`, `FileDrawer`, `HeroMindmap`
- `src/web/file-service.ts`: `WebFileService.buildDiff` and `writeText`
- `src/web/server.ts`: project/file routes, mutable `fileService`, `createChatSession`, `readBody`
- `src/project/store.ts`: project registry and allow-list
- `src/chat/session.ts`: tool-loop behaviour

## Product goals

- Create a complete static website such as `index.html`, `styles.css` and `app.js` from one response.
- Store files under the project and relative destination the user reviewed.
- Support both new files and safe updates to existing files.
- Show one coherent artifact review instead of many disconnected apply buttons.
- Require explicit human approval before any filesystem mutation.
- Detect stale files and project changes before writing anything.
- Preview static HTML/CSS/JavaScript without exposing the local file APIs.
- Preserve the current streaming response latency. Artifact parsing is local and occurs after the final response; opening review performs no additional model call.
- Keep ordinary chat behaviour unchanged when no artifact is present.

## V1 non-goals

- Deleting or renaming files.
- Binary assets or files larger than the existing text-file limit.
- Running shell commands, `npm install`, build scripts, tests or development servers.
- Framework preview for Vite, Next.js, React builds or server-side applications.
- Deployment or hosting.
- Model-supplied absolute paths.
- Silent or persistent write permission.
- True crash-atomic transactions across multiple files. V1 provides full preflight, per-file atomic replacement and best-effort batch rollback.

## Core user flow

### 1. Choose the destination project

The active project must be visible beside the composer as a compact chip:

`Project: My websites`

Clicking it opens the existing project selector. A build turn captures the project ID at submission time. The generated proposal remains bound to that project even if the global active project changes later.

The review screen also accepts an optional relative destination such as `portfolio-site`. The final absolute destination is shown prominently, but the model and API operate only on relative paths.

Adding a project should support an explicit `Create folder if missing` option. Creating a root must validate its deepest existing parent against the allow-list before making directories.

### 2. Generate normally

Streaming, routing and agent behaviour remain unchanged. The model uses a lightweight output convention only when it is providing complete file contents:

````markdown
```html path="index.html"
<!doctype html>
...
```

```css path="styles.css"
...
```
````

Legacy blocks whose first content line is a path comment remain supported. For example, `// src/app.js` followed by the file content.

The model instruction must state:

> When supplying complete file contents intended to be saved, use one fenced block per file with a relative `path="..."` attribute. Never use absolute paths and never claim that files were written.

No artifact is emitted from a partial stream. The server parses the completed reply and attaches candidates to the final `done` event.

### 3. Show one artifact card

A response containing files shows one card:

- `Website ready to review`
- `3 proposed files`
- captured project name
- proposed destination
- `Review and save`

The existing prose and code blocks remain visible. A response without complete file candidates renders exactly as it does today.

### 4. Review the complete set

Use a dedicated wide `ArtifactReviewDialog`; do not overload the narrow single-file `FileDrawer`.

Desktop layout:

- Header: title, project, absolute destination and source turn.
- Left pane: files grouped by New, Modified, Unchanged and Problems.
- Main pane: Changes, Content and Preview tabs.
- Sticky footer: selected count, total size, Cancel and `Apply selected (N)`.

Mobile layout is vertical: header, collapsible file list, tab content, then a sticky apply bar. There must be no horizontally inaccessible controls.

Each file row contains a native checkbox, relative path, textual status badge and byte size. Create and update files are selected by default. Unchanged and invalid files are disabled.

V1 is review-only. Editing proposal content inside the dialog is deferred because it would require revision invalidation and revalidation. The user can regenerate or apply and then use the normal editor.

### 5. Apply once

The button states the scope: `Apply 3 files to My websites / portfolio-site`.

Apply is all-or-nothing for the selected set under normal failures:

- The server checks the proposal ID, immutable revision, captured project ID and current active project.
- It preflights every selected path and hash before mutating anything.
- Any conflict returns `409` with all affected files and zero writes.
- A mid-commit error triggers rollback. The response must distinguish exact rollback from incomplete rollback; it must never report success after an incomplete commit.

After success, the card becomes `Saved 3 files`, the normal file drawer refreshes, and an `Undo` action is available for ten minutes while the server remains running.

## Data model

### Model-output candidate

```ts
interface ArtifactCandidate {
  path: string;
  content: string;
  language?: string;
}
```

Candidates are untrusted. The parser does not decide whether a file is safe or whether it creates or updates anything.

### Validated proposal

```ts
interface ArtifactProposal {
  id: string;
  revision: string;
  sessionId: string;
  sourceTurnId: string;
  projectId: string;
  projectRevision: string;
  basePath: string;
  title: string;
  createdAt: number;
  expiresAt: number;
  state: "ready" | "applying" | "applied" | "cancelled" | "expired";
  files: ArtifactProposalFile[];
}

interface ArtifactProposalFile {
  id: string;
  path: string;
  operation: "create" | "update" | "unchanged";
  content: string; // server-side only; never logged
  bytes: number;
  beforeSha256: string | null;
  afterSha256: string;
}
```

`projectRevision` is a hash of the project ID and resolved real root. `revision` is a canonical hash of immutable proposal fields and file hashes.

V1 proposals live in a bounded in-memory store for 30 minutes. The original response remains in session history, so an expired proposal can be recreated and reviewed. Persisting proposal state across server restarts is a later enhancement.

## API contract

### Security context

```http
GET /api/security/context
```

```json
{
  "csrfToken": "server-boot-token",
  "activeProjectId": "p_1234",
  "projectRevision": "sha256"
}
```

Return `Cache-Control: no-store`. Every project, file and artifact mutation requires the exact `X-CSRF-Token`, JSON content type, an allowed local Host and a non-foreign Origin/Sec-Fetch-Site.

### Create and preview a proposal

```http
POST /api/artifacts/proposals
Content-Type: application/json
X-CSRF-Token: ...
```

```json
{
  "sessionId": "default",
  "sourceTurnId": "turn_123",
  "projectId": "p_1234",
  "basePath": "portfolio-site",
  "title": "Portfolio website",
  "files": [
    { "path": "index.html", "content": "..." },
    { "path": "styles.css", "content": "..." },
    { "path": "app.js", "content": "..." }
  ]
}
```

Response:

```json
{
  "proposalId": "ap_1234",
  "revision": "sha256",
  "project": {
    "id": "p_1234",
    "name": "My websites",
    "root": "C:/.../websites"
  },
  "basePath": "portfolio-site",
  "expiresAt": 1780000000000,
  "summary": {
    "create": 3,
    "update": 0,
    "unchanged": 0,
    "bytes": 18420
  },
  "files": [
    {
      "id": "af_1",
      "path": "portfolio-site/index.html",
      "operation": "create",
      "bytes": 9120,
      "beforeSha256": null,
      "afterSha256": "sha256"
    }
  ]
}
```

The server derives operations. The client and model cannot declare a file safe or choose create/update semantics.

### Fetch a lazy diff

```http
GET /api/artifacts/proposals/:proposalId/files/:fileId/diff
```

```json
{
  "path": "portfolio-site/index.html",
  "operation": "create",
  "beforeSha256": null,
  "diff": "--- /dev/null\n+++ portfolio-site/index.html\n...",
  "truncated": false
}
```

Diffs are lazy so a large multi-file proposal does not delay opening the review screen.

### Apply selected files

```http
POST /api/artifacts/proposals/:proposalId/apply
Content-Type: application/json
X-CSRF-Token: ...
```

```json
{
  "projectId": "p_1234",
  "revision": "sha256",
  "fileIds": ["af_1", "af_2", "af_3"],
  "confirm": true
}
```

Response:

```json
{
  "transactionId": "at_1234",
  "status": "applied",
  "atomicity": "per-file-atomic; batch-best-effort-with-rollback",
  "files": [
    {
      "path": "portfolio-site/index.html",
      "operation": "create",
      "bytes": 9120,
      "sha256": "sha256"
    }
  ],
  "undoToken": "opaque-token",
  "undoUntil": 1780000000000
}
```

`confirm:true`, matching revision, matching project and at least one safe file are mandatory. Proposals are single-use after a successful apply.

### Undo

```http
POST /api/artifacts/transactions/:transactionId/rollback
Content-Type: application/json
X-CSRF-Token: ...
```

```json
{
  "projectId": "p_1234",
  "undoToken": "opaque-token",
  "confirm": true
}
```

Undo succeeds only if every written target still matches its post-apply hash. If any file was subsequently edited, return `409` and change nothing.

### Cancel an unused proposal

```http
DELETE /api/artifacts/proposals/:proposalId
X-CSRF-Token: ...
```

## Validation and limits

V1 limits:

- Maximum 40 candidate files.
- Maximum 256 KiB per file, matching `FILE_MAX_BYTES`.
- Maximum 2 MiB aggregate file content.
- Maximum 3 MiB proposal request body.
- Maximum 240 characters per normalised relative path.
- Maximum 20 live proposals and 10 MiB of proposal content in memory.
- Proposal lifetime: 30 minutes.
- Undo window: 10 minutes; retain at most five transactions.

Path validation must:

- accept only non-empty project-relative POSIX paths;
- reject absolute, UNC, drive-qualified and parent-traversal paths;
- reject NUL/control characters, backslashes, colons and empty components;
- reject duplicate normalised paths, case-insensitively on Windows;
- reject Windows device names and trailing spaces/dots;
- apply blocked-name and suffix checks case-insensitively;
- reject `.git`, `node_modules`, `dist`, `coverage`, `graphify-out`, `.env*`, private-key names, `*.pem` and `*.key`;
- reject symlink/junction targets and ancestors at preview and immediately before commit;
- accept UTF-8 text only.

Oversized requests return `413` before full buffering. Replace the current unbounded body reader with an endpoint-aware byte-capped reader that checks `Content-Length` and aborts once the streaming limit is exceeded.

## Project invariants

- Preview and apply both resolve the project by captured ID, not the mutable global `fileService` alone.
- The captured project must still exist and equal the active project.
- The resolved real root must remain within the configured allow-list.
- `projectRevision` must still match at apply time.
- Switching projects after preview returns `409 PROJECT_CONTEXT_CHANGED` and writes nothing.
- Project activation builds and validates the replacement `WebFileService` before persisting the new active ID.
- Creating a missing project root is a separate explicit operation and never occurs merely because a model suggested a destination.

## Write and rollback semantics

Portable filesystems cannot provide one atomic operation across many files. The product must not claim otherwise.

Under one project mutation lock:

1. Revalidate project identity, root and all selected file preconditions.
2. Aggregate every conflict and return `409` before writing anything.
3. Record directories that this transaction needs to create.
4. Stage each output in a unique sibling temporary file using exclusive creation.
5. Flush and close every staged file.
6. Preserve existing targets as transaction backups.
7. Replace each target using a same-directory rename, making each individual replacement atomic.
8. On any failure, restore updated files, delete newly created targets and remove transaction-created directories only when empty.
9. Remove temporary files and backups after success.

Failure responses distinguish:

- `rolled_back`: byte-identical pre-transaction state restored.
- `rollback_incomplete`: recovery did not fully complete; include affected paths and retain recovery backups.

A process crash or power loss during commit remains a documented V1 limitation. Crash recovery requires an on-disk journal and is not implied by the word transaction.

## Conflict contract

Any stale target returns one aggregate response:

```json
{
  "error": "One or more files changed after preview",
  "code": "ARTIFACT_CONFLICT",
  "conflicts": [
    {
      "path": "portfolio-site/styles.css",
      "reason": "modified",
      "expectedSha256": "sha256",
      "actualSha256": "sha256"
    }
  ]
}
```

The dialog marks every affected row as Conflict and offers `View current file` and `Refresh comparison`. Refreshing establishes a new baseline and requires another explicit review. It never overwrites with a refreshed hash automatically.

## Static website preview

Preview is available when the proposal contains an HTML entrypoint, normally `index.html`.

Requirements:

- Build preview from proposal content without writing it to the project.
- Inline supported local CSS and classic JavaScript references into `iframe.srcDoc`.
- Inject a restrictive CSP: `default-src 'none'`; allow only required inline/data/blob styles, scripts and images; `connect-src 'none'`; `form-action 'none'`; `base-uri 'none'`.
- Use `sandbox="allow-scripts"` only. Never add `allow-same-origin`, forms, popups, downloads or top navigation.
- Provide desktop, tablet and mobile viewport switches plus Reload.
- Show `External requests are blocked in preview` when CDN/API resources cannot load.
- Preview failure never blocks reviewing or applying source files.
- Build-required projects show `Source preview unavailable; build execution is not enabled`.

Generated preview code must never execute as the application origin or gain access to the project/file APIs, parent DOM, local storage or network.

## Frontend architecture

Recommended components:

- `ArtifactTurnCard`
- `ArtifactReviewDialog`
- `ArtifactHeader`
- `ProjectDestinationPicker`
- `ArtifactFileList`
- `ArtifactFileRow`
- `ArtifactDiffViewer`
- `ArtifactContentViewer`
- `ArtifactPreviewFrame`
- `ArtifactApplyBar`
- `ArtifactConflictPanel`

Use a reducer with explicit phases: `idle`, `validating`, `ready`, `applying`, `complete`, `conflict`, `error`.

`HeroMindmap` owns artifact summaries by source turn and dialog visibility. `FileDrawer` remains responsible for browsing, attaching and editing individual files. Extract and reuse its project picker rather than duplicating project API state.

Because the frontend is no-build and loaded through Babel globals, initial components may live in a self-contained `artifact-review.jsx` loaded before `app.jsx`. Pure parser, reducer and preview-rewrite logic must be separated so it can be covered by Vitest rather than left as untested JSX behaviour.

Accessibility requirements:

- `role="dialog"`, `aria-modal="true"`, labelled heading and focus restoration.
- Focus trap; Escape closes only when not applying.
- Native checkboxes/buttons and textual state labels, not colour alone.
- Correct tablist/tab/tabpanel semantics.
- `aria-live="polite"` progress and `role="alert"` blocking errors.
- Descriptive iframe title.
- Minimum 44 px mobile touch targets.
- Existing reduced-motion and focus-visible behaviour remains effective.

## Security boundary

For all file, project and artifact mutations:

- Bind the web server to loopback by default.
- Require JSON, CSRF token, local Host and non-foreign Origin/Sec-Fetch-Site.
- Never return wildcard CORS headers for security, project, file or artifact routes.
- Never log proposal content or raw tool arguments.
- Never give the default web session `write_file` or `bash_exec`.
- Never expose filesystem paths inside generated preview content.

The current immediate `write_file` tool is unsuitable for this workflow because it mutates before review. A future opt-in Builder mode may use `list_project`, bounded `read_project_file` and `stage_file` tools that write only to an isolated staging workspace. It must not use the existing real filesystem write tool.

## Error behaviour

| Condition | Status | UI behaviour |
|---|---:|---|
| Invalid proposal or path | 400 | Show linked Problems rows; no apply |
| Foreign origin/host or blocked path | 403 | Blocking security error |
| Missing proposal/project/file | 404 | Offer recreate/reselect |
| Project changed, stale hash, replay | 409 | Mark conflicts; zero writes |
| Payload/file limits exceeded | 413 | Show the exact enforced limit |
| Non-text existing target | 415 | Mark file unsupported |
| Normal commit failure, rollback complete | 500 | State clearly that nothing changed |
| Rollback incomplete | 500 | Show affected paths and recovery location |

Do not use silent `.catch(() => {})` handling in the artifact workflow.

## Delivery plan

### Phase 0: correctness and security foundation

- Make missing-file diff return a create preview with `beforeSha256: null` and `/dev/null` semantics.
- Harden blocked-name comparisons and Windows path validation.
- Add bounded request-body reading.
- Make project switching validate the new root before changing active state.
- Add explicit project-root creation under the allow-list.
- Add CSRF context and bind the server to loopback by default.

Gate: existing single-file APIs still work; a manually proposed new file can be previewed and applied safely.

### Phase 1: proposal service and batch backend

- Add `src/web/artifact-parser.ts` for structured and legacy response blocks.
- Add `src/web/artifact-service.ts` for proposal lifecycle, validation, lazy diffs, batch apply and expiry.
- Route existing single-file writes through the same validated write primitive.
- Extend chat and chat-stream final responses with artifact candidates and captured project ID.
- Add proposal, diff, apply, cancel and rollback routes.

Gate: integration test creates a three-file website; stale or invalid targets cause zero writes.

### Phase 2: review UI

- Add grouped `ArtifactTurnCard` and wide `ArtifactReviewDialog`.
- Add project/destination display, file selection, lazy diffs, content view, progress, conflict recovery and success receipt.
- Refresh the normal file browser after apply.
- Preserve ordinary chat and legacy session rendering.

Gate: one response produces one accessible card and one explicit batch apply. Desktop and mobile have no inaccessible horizontal controls.

### Phase 3: sandboxed static preview and undo

- Add secure HTML/CSS/classic-JS source preview with viewport controls.
- Add ten-minute hash-guarded undo.
- Add metadata-only application receipts.

Gate: a three-file static site previews before disk write; malicious preview tests cannot access network, parent or local APIs.

### Phase 4: optional Builder mode

- Add an explicit, slower mode for complex multi-file tasks.
- Give the model bounded project-read tools and an isolated `stage_file` tool only.
- Preserve the normal fast path when Builder mode is off.
- Stream redacted tool activity without file contents.

Gate: the model can iteratively stage a coherent site, but the real project remains unchanged until the same review/apply workflow is approved.

## Verification matrix

### Unit tests

- Structured and legacy artifact parsing, including HTML paths.
- Duplicate/case-folded paths, reserved Windows names, traversal and blocked paths.
- Proposal lifecycle, revision, expiry, replay and memory bounds.
- New/update/unchanged classification and new-file diff semantics.
- Preflight conflict aggregation.
- Transaction staging, injected failures, rollback and undo hash guards.
- Preview CSP and local-resource rewriting.
- Frontend reducer state transitions and selection rules.

### Integration tests

- Final chat event returns one grouped candidate set.
- Preview then apply a three-file nested website.
- Apply a selected subset only.
- Switch project after preview: `409`, neither project changes.
- Modify/create/delete a target after preview: aggregate `409`, no writes.
- Reject traversal, absolute/UNC/ADS/reserved paths, case-variant blocked paths and symlink/junction parents.
- Reject wrong content type, CSRF, Host, Origin and oversized body.
- Inject failure at each commit step and verify byte-identical rollback.
- Repeated apply is rejected.
- Existing `/api/files/*`, sessions and chat requests remain compatible.

### UI and manual smoke

- Generate, review, preview and apply `index.html`, `styles.css`, `app.js`.
- Verify exact files on disk under the visible active project path.
- Keyboard-only review, apply, conflict refresh and close.
- Mobile-width review has vertical controls and no clipped left/right content.
- Refresh the task and recreate an expired proposal from the saved response.
- Confirm normal prose chat has no artifact UI and no latency regression.

### Performance gates

- Candidate parsing adds no model request and completes after `done`.
- Proposal metadata opens in under 150 ms locally for 40 files/2 MiB; diffs load lazily.
- Static preview first paint is under one second at the proposal limit.
- Applying 40 files/2 MiB is under two seconds on a normal local SSD, excluding antivirus variance.
- Complete artifact contents are never duplicated into progress/tool SSE events.

Required verification at every shippable phase:

```powershell
npm run typecheck
npm test -- --poolOptions.threads.singleThread=true
npx esbuild ././src/web/static/app.jsx --loader:.jsx=jsx --format=esm --outfile=NUL
graphify update .
```

## Likely files changed

New:

- `src/web/artifact-parser.ts`
- `src/web/artifact-service.ts`
- `src/web/static/artifact-review.jsx`
- `tests/artifact-parser.test.ts`
- `tests/artifact-service.test.ts`

Modified:

- `src/web/file-service.ts`
- `src/web/server.ts`
- `src/project/store.ts`
- `src/cli.ts`
- `src/web/static/index.html`
- `src/web/static/app.jsx`
- `src/web/static/style.css`
- `tests/project-store.test.ts`
- `tests/web-server.test.ts`
- `README.md`

## Definition of done

- A user can choose an approved project, request a static website, review one multi-file artifact, preview it and explicitly save selected files to the shown destination.
- No filesystem write occurs before approval.
- Conflicts, project changes and invalid paths produce zero writes.
- Normal failures roll back to byte-identical state; limitations are reported honestly.
- Generated preview code cannot reach the app or local APIs.
- Normal chat remains fast and unchanged.
- All security, integration, frontend and regression gates pass.
- README and Graphify match the implementation.
