# Implementation review (TASK-028)

Scope: repository state at pinned base `253effaf3697ac6df1b8d948cd43616b9f607ffc`, reviewed across `src`, `ui/src`, `migrations`, colocated backend tests, UI tests, and existing docs. This is a static audit. **Confirmed** means the cited code or test establishes the behavior. **Inference** names a likely user consequence that has not been reproduced here. No remote database was contacted.

## Priority

| ID | Priority | Area | Finding |
| --- | --- | --- | --- |
| P1 | High | Planning / execution | Check approval and task completion can bypass criterion evidence. |
| P2 | High | Neon | Sync has no removal or project deletion path. |
| R1 | Medium | Recovery | Retry resumes an existing, partly edited worktree without a recorded reconciliation decision. |
| R2 | Medium | Recovery / UI | An interrupted run is displayed as actively running until a resume is attempted. |
| N2 | Medium | Neon / UI | The operator cannot see remote sync freshness or failure from the dashboard. |
| U1 | Medium | Other repositories | Registration accepts context files that a pinned worktree cannot read. |
| U3 | Medium | UI | Historical replay counts are labeled as current project status. |
| U2 | Low | UI / docs | The dashboard is bound to one served project and old planning guidance describes obsolete behavior. |

The existing guards are material: draft and check approvals are revision-bound (`src/command-service.ts:50-63`); live workers use isolated worktrees and run registered executable task checks (`src/worktrees.ts:255-290`); the shared snapshot is allowlisted (`src/shared-metadata.ts:63-126`). The findings below do not imply those controls are absent.

### P1 — An approved check set can still lack criterion evidence

- **Confirmed:** Draft parsing accepts one verification string per criterion, but `generatedChecks` creates a check only when the string starts with `command:` or `review:` (`src/command-service.ts:121-139,151-180`). `checkReport` marks uncovered criteria as `missing` and review checks without a result as `unrun` (`src/checks.ts:9-34`). `executionGate` tests only revision approvals (`src/command-service.ts:50-54`); checks approval records the revision without testing coverage or review results (`src/command-service.ts:486-523`). The live executor runs executable `task` checks only, so neither missing rows nor unrun human reviews prevent success when the worker and supplied general `--check` pass (`src/worktrees.ts:279-289`). The UI shows both counts but still offers “Approve checks revision” (`ui/src/planning-view.tsx:57-79`).
- **User-visible impact (inference):** A user can approve and complete a task whose stated criterion has no task-specific executable check or recorded human review. A broad general command can then appear to validate the task.
- **Smallest recommended fix:** Reject check-set approval while a criterion is `missing`; require a named passing result for review-only criteria before task completion. Keep the existing `--check` requirement as an additional check.
- **Acceptance check:** Draft two criteria, give one an unstructured verification string and the other a `review:` procedure. Check approval must name the uncovered criterion and fail. After adding an executable check for it, approval succeeds, but the live task cannot complete until the review is recorded as passed by a named reviewer; its executable check result is also recorded.

## Neon

### P2 — Remote records have no matching deletion lifecycle

- **Confirmed:** `NeonMetadata.sync` upserts approved global lessons (`src/neon-metadata.ts:101-109`); `PostgresMetadata.syncStatements` upserts every supplied run and replaces its task rows, but never deletes runs absent from a later snapshot (`src/postgres-metadata.ts:36-57`). The schema's cascading deletes are reachable only if a parent row is deleted (`migrations/001_shared_metadata.sql:11-47`); `shared_global_lessons` has no local removal marker or owner association (`migrations/002_neon_lessons.sql:1-6`). The CLI exposes `migrate`, `sync`, and `runs`, with no remote removal command (`src/cli.ts:796-815`). Local `knowledge remove` removes current local content (`src/cli.ts:745-748`).
- **User-visible impact (inference):** Removing a promoted lesson locally, deleting local run history, or retiring a project does not retract previously synced Neon data. Repeated sync can leave a remote portfolio or lesson table showing records the user believes were removed.
- **Smallest recommended fix:** Add an explicit, project-scoped remote removal/reconciliation operation and a lesson tombstone or equivalent deletion intent; preview the exact IDs before applying it. Do not infer deletion from a temporarily empty local snapshot.
- **Acceptance check:** Sync two runs and one promoted lesson to an isolated test database, remove one run and the lesson locally, execute the deliberate reconciliation, and assert only those IDs disappear. A subsequent ordinary sync must not recreate them; another project's records must remain.

### N2 — Sync freshness is invisible in the local workflow

- **Confirmed:** Neon runs only through explicit CLI operations; sync prints counts after success and `runs` prints remote rows (`src/cli.ts:796-815`). The database stores `shared_projects.synced_at` (`migrations/001_shared_metadata.sql:6-9`), but `PostgresMetadata.runs` returns only runs and child metadata (`src/postgres-metadata.ts:58-77`). The local API's `/api/shared/runs` is a *local projection*, while `/api/workflow` exposes local runs, worktrees, and capacity (`src/local-api.ts:207-215`). The UI navigation and workflow view have no Neon status (`ui/src/main.tsx:119-128`; `ui/src/workflow-view.tsx:41-49`).
- **User-visible impact (inference):** A local run can look complete in the dashboard while Neon is stale or the last manual sync failed. The user has to compare CLI output and remote rows to discover that distinction.
- **Smallest recommended fix:** Persist a local sync receipt per environment containing time, source snapshot identity or last sequence, counts, and success/error. Expose it as a read-only status beside the existing local projection; label it as a local receipt rather than proof of current remote availability.
- **Acceptance check:** Before any sync, show “never synced.” After a successful development sync, show its timestamp and source sequence. After new local events or a failed sync, show stale/error without claiming production was updated. No credential or repository detail appears in the response.

## Recovery

### R1 — Retrying a partial worktree leaves the earlier edits in place

- **Confirmed:** On interrupted live output, `runUnlocked` stops and tells the user to inspect, retry, repin, and resume (`src/cli.ts:483-497`). `plan.retry` resets only the task snapshot and advances the plan revision (`src/command-service.ts:393-400`). `WorktreeManager.prepare` returns the existing worker record when its base matches and validation has not passed (`src/worktrees.ts:56-64`); `WorktreeCodexExecutor.execute` then tells the next worker that prior output is present (`src/worktrees.ts:262-274`). The recovery contract test checks that `partial.txt` survives the refusal and that resume later succeeds, but does not assert what the resumed worker did with the partial edit (`src/orch-workflow.contract.test.ts:240-257`).
- **User-visible impact (inference):** “Retry” can continue on unreviewed partial edits, and the system does not record whether the user chose to preserve or discard them. A passing check may then be attributed to the new attempt although its starting worktree already contained changes.
- **Smallest recommended fix:** Before retrying an existing worktree, record an explicit preserve/discard decision and its current Git diff or commit identity. If preserving, display that starting state in run evidence; if discarding, reset only that task worktree after the decision.
- **Acceptance check:** Interrupt a worker after an uncommitted edit. A retry without a reconciliation choice must stop. Preserve retains and records the edit; discard starts at the approved base. Both paths keep the original attempt evidence.

### R2 — A dead process remains “running” until someone resumes it

- **Confirmed:** An interrupted run is converted to paused only inside `runUnlocked` when invoked with `--resume` (`src/cli.ts:437-447`). `summarizeRuns` derives status entirely from the run event stream (`src/run-events.ts:83-100`), and the API's run list uses that summary (`src/local-api.ts:256-264`). The overview renders a `running` summary as “Run in progress” and its metric calls `running` tasks “Currently executing” (`ui/src/main.tsx:150-172`). The UI has a paused-run action but no interrupted-run classification (`ui/src/workflow-view.tsx:41,58-66`).
- **User-visible impact (inference):** After a crash or killed CLI, the dashboard can imply a worker is still active. That makes the required inspection step harder to discover and can delay recovery.
- **Smallest recommended fix:** Present a locally derived “possibly interrupted” state when a run is marked running but has no live lock owner or active local job (`src/cli.ts:405-427`; `src/local-api.ts:106-108`). Link to the existing worktree inspection and retry path; do not mutate run history merely by viewing it.
- **Acceptance check:** Kill a live test worker after `task.started`; reopen the UI without invoking resume. It must not say “currently executing,” must identify the task/worktree to inspect, and must leave durable events unchanged. An active worker still shows running.

## UI

### U3 — Replay state is presented as current project status

- **Confirmed:** `App` replaces current `data.tasks` with `frame.tasks` while replaying a selected run and event (`ui/src/main.tsx:82-106`). The resulting counts sit under “Project status”; a replayed `running` task is labeled “Currently executing,” and the focus panel is “Active task” (`ui/src/main.tsx:168-177`). `replayRun` reconstructs that task state from events at the selected sequence (`ui/src/replay.ts:16-43`). The timeline does say “Historical state” when scrubbed, but that qualifier is inside the timeline panel (`ui/src/main.tsx:160-163`).
- **User-visible impact (inference):** Scrubbing to an earlier event, or selecting an older run, can make a completed task look active in the prominent status cards. An operator may mistake historical replay for the current execution state.
- **Smallest recommended fix:** Keep “Project status” counts based on current `data.tasks`; label replay-derived task and worker panels with the selected run and event time. If the counts intentionally follow replay, label them “At selected event” and show current status separately.
- **Acceptance check:** Complete a task, then replay its earlier `task.started` event and an older run. Current project counts must still show the completed task, while replay panels clearly identify their historical time and may show it running. Add a browser assertion for both labels and counts.

### U1 — Context files are accepted before worktree availability is known

- **Confirmed:** Registration validates that each nominated file exists inside the local repository (`src/command-service.ts:215-227`) and the Project form accepts repository-relative paths (`ui/src/project-registration.tsx:20-30`). A live worktree starts at the pinned Git commit, then `prepare` rejects a nominated document missing in that worktree (`src/worktrees.ts:86-107`). Registration does not check whether the file is present at the intended base commit (`src/command-service.ts:277-292`).
- **User-visible impact (inference):** A user can finish onboarding with an untracked or newly changed context document, approve a plan, and only discover at first live execution that the worker cannot read it.
- **Smallest recommended fix:** At base pinning or live preflight, validate each context path against the approved commit and report the missing paths before any worker starts. Keep initial registration usable before a base exists.
- **Acceptance check:** Register a valid but untracked context file, approve a live plan, and attempt to pin or start at an earlier commit. The error names that file before creating a worker worktree. A tracked document at the base succeeds.

### U2 — Cross-repository orientation depends on separate service instances and conflicting guidance

- **Confirmed:** `orch serve` takes one project path (`src/cli.ts:773-786`), the local API closes over that project (`src/local-api.ts:106-108`), and the Project view edits the served directory but has no project selector (`ui/src/project-registration.tsx:20-30`). The README explains `--project` for CLI use and starting a UI service for the chosen repository (`README.md:21,112-126`). `docs/product-and-ui-plan.md` still describes knowledge in JSONL, no relevance retrieval, and a future Knowledge screen/project switcher, while current storage and UI implement the first two (`src/knowledge.ts`; `ui/src/knowledge-view.tsx`).
- **User-visible impact (inference):** A user moving between repositories must restart or separately configure the service. The directory is visible on Project, but the persistent header only names “Workspace,” making it easy to lose track of the active repository elsewhere. The older plan can mislead onboarding decisions about what is already available.
- **Smallest recommended fix:** Make the active directory and a concise “serve another repository” instruction prominent in the Project/Overview header. Mark the dated product plan as historical or update its current-state paragraph when documentation is next edited; a full project switcher is optional.
- **Acceptance check:** With two registered repositories, the dashboard visibly identifies the one currently served and gives the exact way to open the other. Current onboarding docs agree on knowledge storage and existing Knowledge UI.

## Verification

Existing coverage includes revision and privacy contracts (`src/orch-workflow.contract.test.ts:835-983`), interrupted and capacity pause cases (`src/orch-workflow.contract.test.ts:184-258`), a local Postgres round trip gated by `ORCH_TEST_POSTGRES` (`src/orch-workflow.contract.test.ts:1024-1051`), a fake Neon transport and an opt-in Neon round trip gated by `ORCH_TEST_NEON` (`src/orch-workflow.contract.test.ts:1053-1112`), and UI contracts plus browser replay/keyboard checks (`ui/test/orch-workflow.contract.test.cjs`; `ui/e2e/overview.spec.ts`). These establish important positive paths.

The most meaningful missing checks are the acceptance checks for P1, P2, R1, R2, and U3 above. In particular, the Neon tests assert upsert and privacy but not withdrawal of formerly synced IDs; the recovery tests assert refusal and later success but not the provenance of reused partial edits; UI browser checks scrub replay without asserting that prominent project counts remain current, and do not cover a killed worker or stale Neon state. Add those focused scenarios before relying on the corresponding workflow claims. No tests were run for this documentation-only audit, and no runtime behavior was changed.
