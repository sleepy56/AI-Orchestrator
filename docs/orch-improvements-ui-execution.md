# Improvement and UI execution plan

Prepared 14 October 2026. These are two independent live Orch task graphs, each starting at `TASK-001`. The original project history through `TASK-028` is preserved.

Both graphs use base `98cfb8c1a346a10f9728a41b441bcaa169350dd6`, which preserves the current planning fixes, improvement review, and HTML concept. Each task runs in its own Orch worker worktree. Tasks within each graph run in order; the two graphs may progress independently.

Initial live run IDs (retained history):

- Improvements: `5b89a779-197d-4993-8f29-26a05e6e0b34`.
- UI: `df7fc884-e909-4602-a538-e02c160ac64b`.

Recovery execution IDs (same task graphs, original failed runs retained):

- Improvements: `9f674297-db17-4894-abe8-5addb938def4`.
- UI: `4a80c6ec-0388-4656-91d9-1f43f62673ef`.

The first executions stopped on TASK-001. Backend fixtures exceeded Windows Git's nested-path limit; the check harness now runs the exact compiled worker tests from a shorter isolated fixture root. The UI correction passed its focused checks, then the worker commit failed because Git rejected an ignored `.orch` exclusion. The staging exclusion was corrected and verified with a real worker/evidence regression. Recovery preserves earlier edits, attempts and check history.

Starting checks: backend 73 passed, 2 opt-in database cases skipped; UI build, 13 contracts and 6 browser cases passed. The UI worktree's first concurrent backend baseline recorded one failure without retaining its earlier details; a complete logged rerun passed. That original failure remains recorded, rather than being rewritten as success.

## Completion — 17 October 2026

Both independent live Orch graphs completed TASK-001 through TASK-005. The current approved task checks were executed in their exact workers and recorded with result IDs; failed attempts and earlier runs remain in history.

| Campaign | Final live execution | Verified integration |
| --- | --- | --- |
| P0 improvements | `db491647-d6b7-434e-8ffe-78066d760193` | `0603d665-6ea3-4170-b85f-51f2d778f32f` at `c5ea2a4ead692cdbe31dd00339e8960258a41b9c` |
| HTML-based UI | `1188c903-8839-4ed6-8cc0-cf0a99c66181` | `7949ea94-28d2-4876-a01a-02f15ca3abb4` at `54dd27c378044ff08dfa7d06964f8f4678771c2a` |

The UI includes the warm shell, light/dark themes, responsive primary screens, current Overview, Runs list/graph and evidence drawer, Plan, Knowledge, Storage, and advanced controls. Storage, liveness, verification reasons, and explicit preserve/discard recovery use the backend contracts. Latest replay preserves interruption status without rewriting historical events.

The integrations were applied to the original working folder using a three-way comparison with the preserved base. Pre-existing working edits and the Git index were retained; copies of changed original files are under local `.orch/control/before-final-apply/`.

Final working-folder validation: backend **85 passed, 2 opt-in database cases skipped**; UI **14 contracts and 27 browser cases passed**; backend and UI builds passed. Desktop/mobile screenshots in both themes were inspected. The new second-repository journey uses deterministic provider and transport fixtures; the actual campaigns used live Codex workers.

Live provider quota and Windows fixture/locking failures were repaired or resumed without deleting history. Recovery worker prompts reused implemented code and avoided repeated repository inspection.

No production deployment, target-branch merge, or real Neon database operation was performed. Retention/withdrawal, further providers, and the full project registry remain later roadmap work; transactional persistence remains conditional on crash-boundary evidence.

## Run A: P0 improvements

Project: `C:\Users\Sanket\.codex\worktrees\orch-improvements\AI orchestrator`

Branch: `codex/orch-improvements-20261014`

| Task | Dependency | Deliverable | Required evidence |
| --- | --- | --- | --- |
| TASK-001 | — | Shared CLI/API preflight and context availability at the pinned commit | Second-repository regression cases: missing provider/check, untracked context, valid context, no worker created on failure |
| TASK-002 | TASK-001 | Criterion coverage and accurate verification/completion | Missing, skipped, unrun, stale and named-review cases; worker output remains distinguishable from verified integration |
| TASK-003 | TASK-002 | Explicit Neon diagnostics/configuration, per-environment sync receipts and Storage API | Fake-transport checks for redaction, configuration mismatch, read-only diagnostic, never synced/stale/failed receipts and offline local operation |
| TASK-004 | TASK-003 | Interrupted-worker liveness and explicit preserve/discard recovery | Active/dead process cases, history unchanged by reads, preserved/discarded edits restricted to their worker, old evidence retained |
| TASK-005 | TASK-004 | Complete second-repository fixture and updated usage documentation | A fixture exercises the combined P0 journey; the complete backend suite passes |

Each task has an executable check that requires at least one passing test tagged `IMP-TASK-00N`; an empty or entirely skipped selection fails. Every live worker also runs the backend regression suite. Combined changes must pass Orch integration validation.

## Run B: HTML design implementation

Project: `C:\Users\Sanket\.codex\worktrees\orch-ui-design\AI orchestrator`

Branch: `codex/orch-ui-design-20261014`

| Task | Dependency | Deliverable | Required evidence |
| --- | --- | --- | --- |
| TASK-001 | — | Warm shell, sidebar, project identity, responsive layout and themes | Route preservation, theme persistence, keyboard and mobile browser cases |
| TASK-002 | TASK-001 | Overview with current goal, next action, task summary and activity | Empty/offline/simulated cases; historical replay cannot alter current counts |
| TASK-003 | TASK-002 | Runs list/dependency view and accessible evidence drawer | Selection, tabs, Escape/focus return, dense graph, mobile and historical evidence |
| TASK-004 | TASK-003 | Plan, Knowledge and advanced controls; real Storage screen | Existing approvals/actions remain usable; accurate environment/receipt/error states and explicit diagnose/sync requests |
| TASK-005 | TASK-004 | UI integration and visual checks | All primary screens at desktop/mobile in both themes; no console errors or horizontal overflow |

Each task has a focused browser check tagged `UI-TASK-00N`, plus UI build and contract checks. Final UI integration runs the entire browser suite. Runtime data comes from the local API; fixed HTML sample data is a design reference only.

## Final combined verification

Review each run's isolated integration diff, combine backend and UI output against their shared preserved base, then run backend tests, UI tests, UI build and browser checks. Inspect screenshots against `docs/ui-concept.html`, including narrow layouts. Record actual task/check results rather than inferring completion from a general build.

The Codex connection diagnostic passed before live execution. Provider capacity remains unknown unless Orch records a measured signal. No production deployment, remote database migration/sync, or merge to the original branch is part of these runs.

The remaining roadmap includes explicit remote withdrawal/retention, a full project registry, and provider additions. Transactional local storage remains conditional on demonstrated crash-recovery failures; this milestone does not replace working persistence without that evidence.
