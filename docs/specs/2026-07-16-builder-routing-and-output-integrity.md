# Builder routing and output integrity

## Outcome

Website/app creation requests reliably enter the staged-file Builder workflow,
without persisting hidden directives or inheriting unrelated prior topics.
People see only a finished response, never formatter/orchestration prose.

## Behaviour

- Builder preference is `auto` (default), `always`, or `off`.
- Auto activates only for a create/implement verb plus a file-producing
  artefact. Explanations, plans, and an explicitly pinned non-code role stay
  normal chat.
- An active Builder turn forces `action-code`, has turn-only context unless it
  explicitly refers to earlier work, and requires a successful `stage_file`
  call before a creation request succeeds.
- Builder instructions are transient outbound context; raw user text remains
  the saved transcript.
- The streaming API sends a route receipt, and the UI shows Builder activity
  before the first tool call. Markdown copy uses the original response text.
- Formatter output is buffered and checked for internal workflow leakage.
  Rejected candidates fall through the normal role chain; if all fail, the
  completed action output is returned rather than the leaked formatter text.

## Verification

- Unit tests cover intent classification and output-leak detection.
- Typecheck and the full test suite must pass before transfer to the Desktop
  repository.
