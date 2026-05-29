# Project conventions for Claude

These are persistent rules for any Claude session working on this repo. Read on session start.

## README is the source of truth

**Any meaningful or permanent change to the system MUST be reflected in `README.md` as part of the same commit.** This includes:

- New features, flags, CLI commands, or public API surface
- Changes to setup, install, or run instructions
- Roadmap state changes (mark stages complete; add new ones)
- Architectural decisions worth a future reader knowing about

Don't ship a feature commit without the README update. Don't push a commit that leaves the README contradicting the code.

What *doesn't* require a README update: bug fixes that preserve behavior, internal refactors, test additions, dependency bumps, formatting.

## Commit and push after every completed task

**After finishing any complete task or sub-task, commit + push to GitHub before moving on to the next.** Don't accumulate multiple unrelated changes in one commit and don't leave finished work uncommitted between sessions.

Definition of "complete task":
- A bug is fixed and tests pass.
- A feature is implemented, tested, and the README reflects it.
- A refactor is done and the codebase typechecks + tests pass.
- A documentation pass is finished.

Push is part of "done." `git commit` without `git push` leaves the work invisible to anyone else picking up the repo. The standing convention is `git add -A && git commit -F .git/COMMIT_MSG.tmp && git push` as the closing move on every task.

If a task is large enough to warrant multiple intermediate commits (e.g., refactor → tests → docs), push after each one — fast-forward pushes are cheap, lost work is not.

## Other standing rules

- Never commit `.env` or any file containing real API keys. The `.gitignore` covers `.env` already; do not weaken it.
- Don't migrate the language or stack without explicit user approval.
- When the user pastes credentials in chat, flag the leak risk and recommend rotation — don't just silently use them.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
