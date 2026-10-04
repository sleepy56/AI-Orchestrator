# Orch: AI orchestrator skeleton

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

Run these `orch` commands from the project you want to plan. `orch init` creates `.orch/tasks.json` there and preserves existing state. `orch plan` adds **one task**, with defaults of `other`, `moderate`, and `medium`; it does not decompose a goal automatically. Add dependencies with `--after TASK-001,TASK-002`. `orch run` uses fake workers by default and does not edit the project's code. Run `orch help` for all options, including `--project` when operating from another directory.

The Codex skill is packaged in `skills/orch/SKILL.md`. To make `$orch` available across local projects, run `orch skill install`; restart Codex if the skill does not appear. The installer copies the skill to your personal `.agents/skills` directory and refuses to overwrite a changed copy unless you pass `--force`.

## Models, knowledge, and Codex

```sh
orch models list
orch models add luna-alt --provider codex --model your-model-id --tier luna-low --effort low --weight 2
orch models enable luna-alt
orch knowledge add "Use npm test for this project"
orch knowledge add "Prefer short changes for simple renames" --scope global
orch knowledge list
orch history
orch serve --port 8765
```

`orch init` creates a project model registry at `.orch/models.json`. The enabled Codex model with the highest weight for a route is selected. Claude is present as a disabled placeholder; the CLI does not call Claude. A new provider will need its own executor before it can be enabled.

For a live Codex run, install and sign in to Codex CLI, then supply a meaningful validation command:

```sh
codex login
orch doctor codex --timeout-seconds 60
orch run --once --executor codex --check "npm test" --timeout-seconds 600
```

The doctor command sends a small read-only Codex request and reports progress or a timeout without changing task state. A live run can edit project files and consume Codex usage. `--once` executes just the first ready task and leaves the rest planned for review. The check must pass before a task completes. Use `orch models list` and edit model IDs if your signed-in account has different available models. The CLI uses `codex exec --json` and the Codex CLI's cached login; Orch does not store credentials. `orch run` without `--executor codex` remains simulated.

If a live run stops while a task says `running`, inspect the project and confirm that the old process has stopped. Then use `orch retry TASK-001` to make that task ready again. The CLI does not silently repeat a partially edited task.

Project notes and attempt history are in `.orch/knowledge.jsonl`. Global notes and live attempt summaries are in `$ORCH_HOME/knowledge.jsonl` (or `~/.orch/knowledge.jsonl`). Fake attempts are marked simulated. Routing still follows fixed task rules plus configured model weights; automatic cost optimization is planned, not claimed. See [architecture](docs/architecture.md) and the [product and UI plan](docs/product-and-ui-plan.md).

`orch run` appends ordered UI events to `.orch/runs.jsonl`. Each run has a UUID; events have a sequence number, timestamp, route decision, attempt outcome, and simulated or live label. `orch serve` binds only to `127.0.0.1` and serves a read-only JSON API: `GET /api/tasks`, `/api/models`, `/api/history`, `/api/runs`, and `/api/runs/:id/events?after=0`. The last endpoint returns at most 1,000 events per request; use `after` to continue. Model observations count only live attempts. The event log is project-local JSONL; SQLite migration remains a later storage change.

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

Open the URL printed by Vite. The development server proxies `/api` to `127.0.0.1:8765`, so keep the API on that port. The Overview refreshes every five seconds and shows task counts, the active task and route, the latest validation result, recent run events, and a simulated or live run label. Select a run and scrub its event timeline to inspect the task graph, worker state, and validation evidence at that point. The graph supports arrow keys, Home, and End; worker cards support Left and Right arrows. Models lists configured profiles, weights, availability, and matching live model-and-route evidence. Learning groups live attempts by task category and model route, with validation results, repeat attempts, recorded usage, latency, and a separate simulated-attempt list. History does not record the chosen alias, so aliases sharing a model and route share evidence. The UI is read-only; use the CLI to plan runs or change model weights. Run `npm run build:ui` from the repository root to type-check and produce a static bundle in `ui/dist/`.

Run UI unit and browser checks from `ui/` with `npm test` and `npm run test:e2e`. The browser checks start Vite, mock the read-only API with fixed run fixtures, assert replay and keyboard behavior at desktop and narrow widths, and attach screenshots for visual review. They use local Chrome by default; CI uses Playwright's installed Chromium.

## Engine demos and tests

```sh
npm run demo
npm run demo:graph
npm test
```

`npm run demo` reads `state/tasks.json`, runs the rename task, and saves its completed state there. A second run sees that it is already complete. To replay the demo, change its `status` back to `pending` and clear `attempts`.

`npm run demo:graph` creates a fresh four-task graph in memory. Its batches should be `T1`, then `T2 + T3`, then `T4`.

## Parts

- `types.ts` defines task specifications and structured execution, validation, and state records.
- `scheduler.ts` checks dependencies and cycles, derives ready or blocked status, and updates the graph.
- `router.ts` chooses `luna-low`, `sol-medium`, or `sol-high` from task difficulty, risk, and type.
- `executor.ts` contains a fake worker. Pass, failure, and invalid-output sequences can be configured by task ID.
- `validator.ts` returns structured validation errors.
- `escalation.ts` retries a failed Luna task once with Luna, then tries Sol twice. A task initially routed to Sol gets one retry.
- `orchestrator.ts` runs all ready tasks in a batch concurrently, validates them, and updates the graph before scheduling the next batch.

Tasks whose dependency failed remain `blocked` and appear in the run result. Graph state is saved after each completed batch in the single-task demo.

The CLI keeps each project's plan in `.orch/tasks.json`. Review task descriptions before committing that file in another repository.
