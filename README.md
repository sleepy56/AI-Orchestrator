# Orch: AI orchestrator skeleton

This Node.js and TypeScript project schedules dependent tasks, routes them to a simulated worker, validates the result, and retries or escalates failures. It makes **no AI API calls**.

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

Run these `orch` commands from the project you want to plan. `orch init` creates `.orch/tasks.json` there and preserves existing state. `orch plan` adds **one task**, with defaults of `other`, `moderate`, and `medium`; it does not decompose a goal automatically. Add dependencies with `--after TASK-001,TASK-002`. `orch run` currently uses fake workers and does not edit the project's code. Run `orch help` for all options, including `--project` when operating from another directory.

The Codex skill is packaged in `skills/orch/SKILL.md`. To make `$orch` available across local projects, run `orch skill install`; restart Codex if the skill does not appear. The installer copies the skill to your personal `.agents/skills` directory and refuses to overwrite a changed copy unless you pass `--force`.

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

The CLI keeps each project's plan in `.orch/tasks.json`. Review task descriptions before committing that file in another repository. Provider connections, shared history, and adaptive routing are future milestones.
