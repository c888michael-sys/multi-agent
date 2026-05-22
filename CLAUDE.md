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

## Other standing rules

- Never commit `.env` or any file containing real API keys. The `.gitignore` covers `.env` already; do not weaken it.
- Don't migrate the language or stack without explicit user approval.
- When the user pastes credentials in chat, flag the leak risk and recommend rotation — don't just silently use them.
