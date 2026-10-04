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
```

`orch init` creates a project model registry at `.orch/models.json`. The enabled Codex model with the highest weight for a route is selected. Claude is present as a disabled placeholder; the CLI does not call Claude. A new provider will need its own executor before it can be enabled.

For a live Codex run, install and sign in to Codex CLI, then supply a meaningful validation command:

```sh
codex login
orch run --executor codex --check "npm test"
```

This can edit project files and consume Codex usage. Live tasks run one at a time. The check must pass before a task completes. Use `orch models list` and edit model IDs if your signed-in account has different available models. The CLI uses `codex exec --json` and the Codex CLI's cached login; Orch does not store credentials. `orch run` without `--executor codex` remains simulated.

If a live run stops while a task says `running`, inspect the project and confirm that the old process has stopped. Then use `orch retry TASK-001` to make that task ready again. The CLI does not silently repeat a partially edited task.

Project notes and attempt history are in `.orch/knowledge.jsonl`. Global notes and live attempt summaries are in `$ORCH_HOME/knowledge.jsonl` (or `~/.orch/knowledge.jsonl`). Fake attempts are marked simulated. Routing still follows fixed task rules plus configured model weights; automatic cost optimization is planned, not claimed. See [architecture](docs/architecture.md) and the [product and UI plan](docs/product-and-ui-plan.md).

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
