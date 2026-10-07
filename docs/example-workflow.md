# Example project workflow (TASK-027)

The `[TASK-027]` test in `src/orch-workflow.contract.test.ts` creates a temporary Git project with a private README and a `shared.txt` file. It uses a deterministic planning model and a stub Codex executable so the workflow is reproducible without an account or network connection. The stub edits the two task worktrees independently; it does not claim to test model quality. The UI contract renders the matching plan, check, capacity, conflict, rollback, and merge states.

Run the acceptance gate from this repository after installing dependencies:

```sh
npm install
npm --prefix ui install
node scripts/check-task.cjs TASK-027
```

The fixture checks these transitions in one run:

| Step | User or system action | Evidence checked |
| --- | --- | --- |
| Clarify | Ask which export format changes the checks; answer CSV | No workers or executable tasks appear before plan approval. |
| Review checks | Add a CLI task check with command, criterion, phase, expected exit, and timeout | The local API sees the same check revision and command. |
| Approve | Approve the plan through the local UI command API and checks through the CLI | The approved draft becomes the task graph; both gates then open at the current revisions. |
| Pause and resume | Pin `main` to its exact head; inject measured near-limit capacity, then a fresh sufficient signal | The first live run has no workers and a durable paused ID; resume finishes that same run. |
| Isolated work | Two stub Codex workers edit `shared.txt` to different values | Separate worktree paths and pinned bases, task check evidence, and unchanged `main` are recorded. |
| Route history | Feed comparable validated live attempts and a versioned fixture price file; apply and roll back a cheaper route | The policy history records the automatic choice and user rollback; the UI reads the same history. Prices are test data. |
| Integrate | Combine task commits, resolve the `shared.txt` conflict, and run a combined check | Verification refuses unresolved conflicts. Merge refuses an unapproved action and accepts the exact approved revision through the UI command API. |
| Sync privacy | Export the run to the local Postgres and Neon adapter transports | Both receive only allowlisted run metadata. Neon receives a reviewed generalized lesson; unknown fields and an unreviewed lesson are rejected. |

The main test captures SQL through adapter transports; it does not require running databases. Database-specific round trips remain available with `ORCH_TEST_POSTGRES=1` for a fresh Docker Compose Postgres schema and `ORCH_TEST_NEON=1` for a configured Neon development database. Set those flags only for the corresponding integration tests and configure the required services before running the full workflow contract suite.

For a real project, replace the fixture planner and stub workers with the CLI commands described in the [README](../README.md): `orch init`, `orch draft start`, `orch draft answer`, `orch checks add`, `orch draft approve`, `orch checks approve`, `orch worktrees base`, and `orch run --executor codex --check`. Inspect each task diff and combined integration diff before granting the exact merge action. `orch shared sync` and `orch shared neon sync --environment development` are separate, explicit operations; inspect `/api/shared/runs` and reviewed global lessons before syncing.
