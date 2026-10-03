# AI orchestrator skeleton

This Node.js and TypeScript project schedules dependent tasks, routes them to a simulated worker, validates the result, and retries or escalates failures. It makes **no AI API calls**.

## Run

```sh
npm install
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
