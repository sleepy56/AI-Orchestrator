---
name: orch
description: Use the orch CLI to plan and run dependency-aware tasks, inspect status, models, and knowledge. Apply when the user asks to use orch or invokes $orch; distinguish simulated runs from live Codex runs.
---

# Orch workflow

Use the `orch` terminal command in the user's project directory. If it is unavailable, explain that this package must be built and linked (`npm run build`, then `npm link` from the orchestrator repository) before the skill can use it.

- For a new project, run `orch init` once. It creates `.orch/tasks.json` and `.orch/models.json` in that project. Existing task state must be preserved.
- Run `orch status` before adding or executing tasks so existing IDs and dependencies are visible.
- `orch plan "description"` creates one task. For a graph, call it once per task and use `--after TASK-001,TASK-002` to name predecessors. Specify `--type`, `--difficulty`, and `--risk` when the user's context supports a classification; unspecified tasks default to `other`, `moderate`, and `medium`.
- Run `orch run` for a simulation. Completed then means the fake worker and validator passed; tell the user that project code was not changed.
- For requested live code changes, use `orch run --executor codex --check "<meaningful project check>"`. This uses the installed, signed-in Codex CLI, can edit code, and consumes Codex usage. Choose a check that verifies the task. Live tasks are serialized. Never imply that a passing generic check proves every semantic requirement.
- Use `orch models list` to inspect configured Codex models and weights. Claude entries are disabled until a provider connection is implemented. `orch knowledge list` and `orch history` reveal notes and attempt evidence; fake attempts are labeled simulated.
- If a task remains `running` after an interrupted process, inspect the changes and confirm the original process has stopped before using `orch retry TASK-ID`. Do not silently repeat it.
- After planning or running, use `orch status` to report actual task IDs and states. If a dependency has failed, report the blocked tasks instead of claiming the whole graph completed.

Use `orch help` for current syntax. The CLI stores task state and model settings per project and notes at project or global scope. Do not describe those records as model retraining or automatic cost optimization.
