---
name: orch
description: Use the orch CLI to initialize a project, plan dependency-aware tasks, inspect their status, and run fake-worker orchestration. Apply when the user asks to use orch or invokes $orch; do not imply AI execution from a simulated run.
---

# Orch workflow

Use the `orch` terminal command in the user's project directory. If it is unavailable, explain that this package must be built and linked (`npm run build`, then `npm link` from the orchestrator repository) before the skill can use it.

- For a new project, run `orch init` once. It creates `.orch/tasks.json` in that project. Existing task state must be preserved.
- Run `orch status` before adding or executing tasks so existing IDs and dependencies are visible.
- `orch plan "description"` creates one task. For a graph, call it once per task and use `--after TASK-001,TASK-002` to name predecessors. Specify `--type`, `--difficulty`, and `--risk` when the user's context supports a classification; unspecified tasks default to `other`, `moderate`, and `medium`.
- Run `orch run` when the user wants the planned graph executed. The current executor is fake: completed means the simulated worker and validator passed. Tell the user that project code was not changed by that run.
- After planning or running, use `orch status` to report actual task IDs and states. If a dependency has failed, report the blocked tasks instead of claiming the whole graph completed.

Use `orch help` for current syntax. The CLI stores state per project; this skill does not create shared history or connect Codex or other providers yet.
