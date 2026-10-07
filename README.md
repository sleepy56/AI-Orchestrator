# Orch: AI orchestrator skeleton

The saved knowledge and full-product task graph, acceptance criteria, and task-specific live check commands are in [the execution checklist](docs/orch-execution-checks.md). Reading or preparing it does not start a task.

This Node.js and TypeScript project schedules dependent tasks, routes them to a worker, validates the result, and retries or escalates failures. Fake workers remain the default. Live Codex execution is available as an explicit opt-in through the installed Codex CLI.

## Try the CLI

```sh
npm install
npm run build
npm link
cd /path/to/your-project
orch init
orch plan "Rename UserGoal to Goal" --type rename --difficulty easy --risk low
orch status
orch run
orch status
```

Run these `orch` commands from the project you want to plan. `orch init` registers it with an opaque ID, discovers local Git status and package scripts, creates `.orch/tasks.json`, and preserves existing state. Use `orch init --docs README.md,docs/architecture.md` to select context files; repeating the command with a changed list increments the local context manifest version. The paths and document contents remain local. `orch plan` adds **one task**, with defaults of `other`, `moderate`, and `medium`; it does not decompose a goal automatically. Add dependencies with `--after TASK-001,TASK-002`. `orch run` uses fake workers by default and does not edit the project's code. Run `orch help` for all options, including `--project` when operating from another directory.

For an AI planning draft, use `orch draft start "Add CSV export"` after `orch init`. The planner uses a read-only, ephemeral Codex request to inspect repository context. It asks up to three questions only when their answers would change the plan; `orch draft show` displays each question and its impact. Save answers as a JSON object keyed by question ID and run `orch draft answer --file answers.json`. The resulting draft includes dependencies, acceptance criteria, risk, expected areas, proposed worker profile, required context, and verification for each task. Edit the task array with `orch draft edit --file tasks.json`, inspect the new plan revision with `orch draft show`, and record review with `orch draft approve`. The dashboard's **Planning** screen uses the same local state and review commands. Draft tasks remain separate from `.orch/tasks.json`; drafting and review start no workers. A drafted run pauses until the current plan and check revisions are approved. Converting approved drafts into executable tasks remains a later workflow step.

## Verification checks

`orch checks baseline` discovers and runs existing `test`, `build`, `lint`, and `typecheck` package scripts. Their output, duration, and exit status become local evidence; a failing baseline reports starting health and does not fail a task check. Draft plans create one check per acceptance criterion. A `command: ...` verification entry becomes an executable task check; a `review: ...` entry becomes a procedure that needs a named reviewer. A draft can include `testArtifacts: [{"name":"export.test.js","content":"..."}]` and reference one in a command as `{{test:export.test.js}}`. Orch writes each generated test under `.orch/generated-tests/plan-rN/TASK-ID/` so the code and its revision can be reviewed. Edit the draft to revise generated checks and tests. Earlier results remain in local history but do not satisfy the new plan revision.

```sh
orch checks list TASK-001
orch checks add TASK-001 --command "node --test test/export.test.js" --phase task --timeout-seconds 60 --expected "exit 0" --criterion "Export includes headers"
orch checks run task TASK-001
orch checks skip CHECK_ID --reason "Fixture unavailable"
orch checks review CHECK_ID --reviewer "A. Reviewer"
```

Use `--cwd` to select a directory within the project. `--expected` accepts `exit N` and `output includes: text`; an omitted exit condition means exit 0. `orch checks run CHECK_ID` runs one check. `orch checks list` reports pass, fail, skipped, missing, and unrun separately. Check edits create revisions; results stay tied to the revision that ran. The Planning screen offers the same baseline, check entry, execution, skip, and human review controls. Commands run through the local shell, so add commands you trust. Task-specific checks should assert the named behavior; a broad build alone is not evidence for an unrelated criterion.

## Approval gates

Review the current draft and checks, then run `orch draft approve` and `orch checks approve`, or use the corresponding buttons in Planning. Each approval is stored against its exact revision. Editing either record makes its earlier approval stale. `orch run` records a paused run ID without starting workers when a gate is pending. After approval, use `orch run --resume RUN_ID` with the original executor mode and, for live runs, the required `--check` command. A revision change during a run stops subsequent task starts and pauses that run.

Live runs also read optional local scheduling inputs. A trusted local provider probe can write `.orch/capacity.json` with `{"provider":"codex","observedAt":"2026-10-07T12:00:00Z","remainingTokens":500000,"limitTokens":1000000,"maxConcurrent":2,"resetAt":"2026-10-07T13:00:00Z"}`. Include only fields actually measured; `retryAfter` may carry a provider retry timestamp. A token measurement expires after five minutes, and `orch capacity` labels missing or expired availability as `unknown`. Orch never derives remaining quota from task usage. `.orch/scheduler.json` can set `{"maxWorkers":4,"maxProjectedCostUsd":5}`; the dollar cap requires a reviewed USD `.orch/prices.json` snapshot. Worker count is also bounded by machine parallelism, measured provider concurrency, projected token headroom and cost, task risk, and overlapping draft areas. A capacity pause retains its run ID for `orch run --resume RUN_ID`. If an interrupted live task has worktree output, inspect it and ensure its worker stopped, then use `orch retry TASK_ID`, repin the worktree base with `orch worktrees base`, and resume the run.

`orch actions request merge TARGET_BRANCH INTEGRATED_COMMIT --base-revision TARGET_HEAD` creates a merge approval request; `orch actions request deployment DESTINATION ARTIFACT_DIGEST` creates a separate deployment request. Use `orch actions show ACTION_ID`, `orch actions approve ACTION_ID`, and `orch actions ready ACTION_ID` to inspect, grant, and verify the gate. The Planning screen exposes the same requests and approval records. Reusing an action ID creates a new request revision, which needs new approval. For a merge, Orch also checks that the target branch still points to the requested head when approval is granted and when readiness is checked. `orch worktrees integrate` creates a request for its validated combined commit, and `orch worktrees merge ACTION_ID` executes only that approved integration. A manually requested merge action cannot bypass integration validation. Deployment remains a separate gate.

The Codex skill is packaged in `skills/orch/SKILL.md`. To make `$orch` available across local projects, run `orch skill install`; restart Codex if the skill does not appear. The installer copies the skill to your personal `.agents/skills` directory and refuses to overwrite a changed copy unless you pass `--force`.

## Models, knowledge, and Codex

```sh
orch models list
orch models add luna-alt --provider codex --model your-model-id --tier luna-low --effort low --weight 2
orch models enable luna-alt
orch knowledge add "Use npm test for this project"
orch knowledge list
orch knowledge add "For renames, check public references" --type rename
orch knowledge review NOTE_ID --status approved
orch knowledge promote NOTE_ID
orch knowledge edit NOTE_ID "For renames, verify public references"
orch knowledge remove NOTE_ID --scope project
orch knowledge export --scope global --output global-knowledge.json
orch history
orch serve --port 8765
```

`orch init` creates a project model registry at `.orch/models.json`. The enabled Codex model with the highest weight for a route is selected. Claude is present as a disabled placeholder; the CLI does not call Claude. A new provider will need its own executor before it can be enabled.

`orch models recommend TASK-001 --prices prices.json` prints a route proposal for a planned task without changing model settings. Supply a locally reviewed price snapshot such as `{"version":"2026-10-reviewed","currency":"USD","models":{"codex:gpt-6-sol":{"inputPerMillion":1,"outputPerMillion":2},"codex:gpt-6-luna":{"inputPerMillion":0.5,"outputPerMillion":1}}}`; the numbers illustrate the file shape, not actual prices. `--manual-alias alias` records a manual choice in the response without changing the registry. The command never applies a proposal. It needs at least eight distinct comparable live tasks per route with validation, complete token and latency measurements, known prices, and no observed candidate task left without a pass on that route. It counts repeat attempts in cost and latency, shows sample sizes and Wilson 95% intervals, and keeps the established route as fallback. If evidence is insufficient, it reports no recommendation. The price snapshot reprices observed usage; it does not claim historical billed cost or that an untried route would pass this task.

For a live Codex run, install and sign in to Codex CLI, approve the exact branch head for the current plan and checks, then supply a meaningful validation command:

```sh
codex login
orch doctor codex --timeout-seconds 60
orch worktrees base main $(git rev-parse main)
orch run --once --executor codex --check "npm test" --timeout-seconds 600
```

The doctor command sends a small read-only Codex request and reports progress or a timeout without changing task state. Each live worker edits a separate branch and Git worktree under `.orch/worktrees/`, starting at the approved commit or an integrated dependency base. Ready siblings can run together. Orch runs the supplied check and approved executable task checks inside each worker worktree, records the Codex context ID and selected lesson IDs, and commits passing work on its task branch. `orch worktrees show` displays local worker and integration records. `--once` starts one ready task. Use `orch models list` and edit model IDs if your signed-in account has different available models. The CLI uses `codex exec --json` and the Codex CLI's cached login; Orch does not store credentials. `orch run` without `--executor codex` remains simulated.

After the workers pass, run `orch worktrees integrate TASK-001,TASK-002 --check "npm test"`. Orch combines those commits in a temporary integration worktree and prints the combined diff, conflicts, check result, commit, and merge target. A clean passing integration yields an action ID. Inspect the output, run `orch actions approve ACTION_ID`, then `orch worktrees merge ACTION_ID`. The merge requires the target branch to remain at the reviewed base and be checked out with no tracked edits. The target branch stays unchanged until this command succeeds.

If a live run stops while a task says `running`, inspect the project and confirm that the old process has stopped. Then use `orch retry TASK-001` to make that task ready again. The CLI does not silently repeat a partially edited task.

Project knowledge is stored in `.orch/knowledge.v1.json`; global knowledge is in `$ORCH_HOME/knowledge.v1.json` (or `~/.orch/knowledge.v1.json`). The first knowledge read or write imports any legacy `knowledge.jsonl` records and leaves the JSONL file intact. Later JSONL appends are also imported once. `knowledge list` shows note IDs and review status. Successful live validated attempts with run IDs create pending project lesson candidates; matching observations add attempt and run evidence to the existing candidate. Simulated attempts and failed validation do not create candidates. Review a candidate with `knowledge review <id> --status approved` to create one approved project lesson, or reject it; `knowledge edit` can revise its proposed text before approval. Add notes locally, review them with `--status approved|rejected|pending`, and promote only generalized approved notes. Promotion rejects obvious paths, code, commands, checks, and failure details; a reviewer must also remove identifying language the guard cannot detect. Editing a local note resets it to pending. Removal deletes its current text while retaining digest-based audit events; `knowledge export` includes current entries and audit metadata and refuses to overwrite a file. Global exports include only reviewed notes with source provenance. Exporting project scope includes private detail, so keep that file local. The original legacy JSONL logs remain untouched, including records later removed from the snapshot. Live and simulated attempts stay project-local, and only approved notes are supplied to live workers. The CLI and API use only local storage; no remote writes occur. See [architecture](docs/architecture.md) and the [product and UI plan](docs/product-and-ui-plan.md).

`orch run` appends ordered UI events to `.orch/runs.jsonl`. Each run has a UUID; events have a sequence number, timestamp, route decision, attempt outcome, and simulated or live label. `orch serve` binds only to `127.0.0.1`. The existing `GET /api/tasks`, `/api/models`, `/api/history`, `/api/runs`, and `/api/runs/:id/events?after=0` endpoints remain read-only. The last endpoint returns at most 1,000 events per request; use `after` to continue. The local service also accepts versioned `POST /api/commands` requests and exposes private detail at `GET /api/commands` and an allowlisted metadata view at `GET /api/commands/shared`. The equivalent CLI entry point is `orch command --json '{...}'`; see [the product contract](docs/orch-product-contract.md#local-command-service-task-016). Model observations count only live attempts. The event log is project-local JSONL; SQLite migration remains a later storage change.

`GET /api/knowledge` adds approved project and global lessons, pending project candidates, current per-task retrieval matches with reasons, and separate `usedInRuns` records from actual selection events. The latter carry run IDs, task IDs, lesson IDs, reasons, and run mode. Current matches are observational and can differ from what an earlier run used. `GET /api/model-proposals` returns read-only proposals for planned tasks. To make cost comparisons available in the dashboard, place a reviewed price snapshot in the same JSON format as `models recommend --prices` at `.orch/prices.json`. Without it, proposals explain that comparable priced evidence is insufficient. Simulated attempts are excluded from live model evidence and proposals.

## Local shared metadata database

Start the local Docker Postgres service with `docker compose up -d --wait`, then run `orch shared migrate` and `orch shared sync --project /path/to/your-project`. `orch shared runs --project /path/to/your-project` reads the stored metadata. The CLI uses the Postgres client inside the container, so the database has no host port and no connection string is passed to the dashboard or workers. The Compose password can be set with `ORCH_POSTGRES_PASSWORD` before the first start; Docker keeps the database in the `orch_postgres` volume.

Sync is explicit. It projects local run events to opaque IDs, task category, risk, dependency IDs, status, route, validation verdict, token totals, and latency. The adapter rejects unknown fields at every level and stores these as typed columns; it has no column for prompts, task descriptions, paths, source, diffs, architecture or product documents, check commands, or raw output. Local detail remains available at `GET /api/commands`, `/api/tasks`, and the other loopback API endpoints. `GET /api/shared/runs` shows the exact local projection before sync. Set `ORCH_TEST_POSTGRES=1` and run `node --test --test-name-pattern='\[TASK-023\]' dist/orch-workflow.contract.test.js` to exercise migration and round-trip against a fresh isolated Docker Compose project after building.

To reuse a lesson across projects, add and approve a generalized note in the source project, then promote its ID. The destination project reads the approved global lesson through the same `$ORCH_HOME`; its local notes, attempts, candidates, checks, and legacy log do not move. Retrieval combines approved destination notes and approved global lessons for a task, selects at most five, and records reasons. `knowledge export --scope global` contains reviewed lesson text and provenance, while a project export can contain private detail. Review the wording before promotion because the automatic guard catches only obvious identifying text. `models recommend` is read-only: `--manual-alias` changes the printed choice for that request and retains the configured route as fallback. Runtime model selection still uses enabled profiles and their weights; a proposal does not change a run's route.

## Local dashboard

The React and TypeScript Overview in `ui/` reads the local API. Start the API for the project you want to inspect, then start the Vite development server in another terminal:

```sh
npm install
npm run build
node dist/cli.js serve --project /path/to/your-project --port 8765
```

```sh
cd ui
npm install
npm run dev
```

Open the URL printed by Vite. The development server proxies `/api` to `127.0.0.1:8765`, so keep the API on that port. The Project view can register the served directory and edit its explicit context document list through the same local service as `orch init`. Planning handles draft and check review and approval requests. The Overview refreshes every five seconds and shows task counts, the active task and route, the latest validation result, recent run events, and a simulated or live run label. Select a run and scrub its event timeline to inspect the task graph, worker state, and validation evidence at that point. The graph supports arrow keys, Home, and End; worker cards support Left and Right arrows. Models lists configured profiles, weights, availability, and matching live model-and-route evidence. Learning groups live attempts by task category and model route, with validation results, repeat attempts, recorded usage, latency, and a separate simulated-attempt list. History does not record the chosen alias, so aliases sharing a model and route share evidence. Use the CLI to start or resume runs and change model weights. Run `npm run build:ui` from the repository root to type-check and produce a static bundle in `ui/dist/`.

Run UI unit and browser checks from `ui/` with `npm test` and `npm run test:e2e`. The browser checks start Vite, mock the read-only API with fixed run fixtures, assert replay and keyboard behavior at desktop and narrow widths, and attach screenshots for visual review. They use local Chrome by default; CI uses Playwright's installed Chromium.

## Engine demos and tests

```sh
npm run demo
npm run demo:graph
npm test
node scripts/check-task.cjs TASK-015
```

The TASK-015 check compiles the backend and UI, runs backend and UI regressions, then runs the tagged integration tests and the existing knowledge contracts. The integration fixtures exercise legacy import, privacy across two projects, retrieval, candidate deduplication, simulated filtering, weighted model choice, manual override, fallback, and CLI/API agreement. The UI contract checks that recorded run use is displayed separately from current observational matches.

`npm run demo` reads `state/tasks.json`, runs the rename task, and saves its completed state there. A second run sees that it is already complete. To replay the demo, change its `status` back to `pending` and clear `attempts`.

`npm run demo:graph` creates a fresh four-task graph in memory. Its batches should be `T1`, then `T2 + T3`, then `T4`.

## Parts

- `types.ts` defines task specifications and structured execution, validation, and state records.
- `scheduler.ts` checks dependencies and cycles, derives ready or blocked status, and updates the graph.
- `router.ts` chooses Luna low, medium, or high for low-risk tasks by difficulty; refactors, analysis, and higher-risk work use Sol tiers.
- `executor.ts` contains a fake worker. Pass, failure, and invalid-output sequences can be configured by task ID.
- `validator.ts` returns structured validation errors.
- `escalation.ts` retries a failed Luna task once with Luna, then tries Sol twice. A task initially routed to Sol gets one retry.
- `orchestrator.ts` runs all ready tasks in a batch concurrently, validates them, and updates the graph before scheduling the next batch.

Tasks whose dependency failed remain `blocked` and appear in the run result. Graph state is saved after each completed batch in the single-task demo.

The CLI keeps each project's plan in `.orch/tasks.json`. Review task descriptions before committing that file in another repository.
