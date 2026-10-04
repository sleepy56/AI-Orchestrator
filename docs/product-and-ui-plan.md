# Orch product and interface plan

## Product promise

Orch turns a task plan into an observable run. It shows which task is ready, which worker was selected, why it was selected, what evidence validated the result, and what changed after feedback. “Learning” means updating routing preferences from recorded outcomes and user choices; it does not retrain Codex, Claude, or any underlying model.

The first audience is one developer running `orch` in a local repository. The command line remains useful on its own. A desktop or local web interface reads the same project state and event history.

## Screens

| Screen | Main question | Core content |
| --- | --- | --- |
| Overview | What is happening now? | Active run, current task, orchestrator node, worker nodes, blocked count, latest validation result |
| Run detail | What happened in this run? | Task graph, timeline of attempts, route choices, worker output, validation evidence |
| Task detail | Why did this task move or fail? | Full TaskSpec, dependencies, status history, attempts, check results, file changes |
| Models | What can Orch use? | Provider availability, model aliases, tier, effort, weight, recent reliability and usage |
| Learning | What has Orch learned? | Routing observations, proposed preference changes, confidence, before/after comparisons, revert action |
| Knowledge | What instructions and facts are remembered? | Project and global notes with scope, source, edit and removal controls |
| Settings | How does this project run? | Project location, validation command, budget limits, concurrency and provider setup |

Start with Overview, Run detail, Models and Learning. Task detail can be a side panel in the first release. Knowledge and Settings can be simple forms.

## Main visualizations

### Orchestrator and worker map

Place the orchestrator at the center. Connect it to workers with curved lines. Each worker card shows provider, actual model ID, current task, status, attempt number, and last result. A line animates only while a task is assigned or returning. Keep the full information in a click panel; hover shows a compact preview. Keyboard focus opens the same preview.

Use status as the primary color meaning: ready = blue, running = cyan, validating = amber, completed = green, failed = red, unavailable = gray. Give every status a word and icon as well. Mark newly registered models as “untested” until real attempts exist. A disabled Claude entry appears in the Models screen, not as an active worker.

### Task dependency graph

Render each TaskSpec as a node with its ID, summary, and status. Directed edges show `dependsOn`. Sibling tasks share a level. A failed predecessor highlights blocked descendants. Selecting a node opens Task detail. A timeline scrubber reconstructs the graph after each event so the user can inspect the last three or four prompts and see exactly when a task or route changed.

### Learning and routing evidence

Use a table and small trend charts rather than a vague “learning score.” For each task category and candidate model, show sample size, validated pass rate, retries, token use, observed latency, and user preference weight. Show the reason for a recommendation: for example, “12 validated refactors: Sol medium passed 11; Luna low passed 7 and needed 5 escalations.” Label simulated runs separately and exclude them from real performance recommendations.

Keep proposed policy changes reversible. The user can favor a new model by changing its weight. Orch should show the measured tradeoff and suggest reverting if later evidence weakens the choice. Keep a policy version and an event explaining every change.

## Interaction sketch

```text
Overview
┌───────────────────────────────────────────────────────────────────┐
│ Project / run                 active task             run controls │
├───────────────────────────────────────────────────────────────────┤
│                   [Orchestrator: routing]                         │
│                    ╱          │          ╲                        │
│        [Codex Luna]     [Codex Sol]     [Claude: unavailable]     │
│         TASK-003         idle                                   │
├───────────────────────────────┬───────────────────────────────────┤
│ Task dependency graph         │ Selected task / worker detail     │
│ T1 → T2, T3 → T4              │ Why routed; output; check result │
├───────────────────────────────┴───────────────────────────────────┤
│ Event timeline: plan → route → execute → validate → update       │
└───────────────────────────────────────────────────────────────────┘
```

The reference image is useful for its hierarchy and dark visual language. The Orch interface should use real task and model data, make the graph readable at larger sizes, and keep validation and routing reasons visible rather than relying on decorative metrics.

## Data the interface needs

- Stable run ID and event sequence number so the timeline can replay in order.
- TaskSpec revisions with author, timestamp, reason, and prior value.
- Route decision with candidates, scores, chosen model, preference weight, and policy version.
- Worker state transitions and streamed output references.
- Validation result and exact command or human review that established it.
- Provider availability and model lifecycle: added, disabled, tested, promoted, reverted.
- Token usage, latency, and price snapshot when reliable pricing data is available. Display “cost unknown” otherwise.

The current `.orch/tasks.json`, `.orch/models.json`, and JSONL knowledge logs are a CLI prototype. Before building timeline replay or multi-process UI access, move operational events and model observations into SQLite with migrations, WAL mode, and indexed tables. Keep small user-editable project settings in JSON. Use one project database at `.orch/orch.db` and a global database under the user's Orch home. Do not store credentials in either database.

## Build order

1. Finish backend event records and independent validation. Add task/run IDs and policy versions.
2. Move history to SQLite and expose a read-only local API or event stream.
3. Build Overview and Run detail with a graph library such as React Flow. Keep the CLI as the control surface initially.
4. Add Models and Learning controls with clear evidence, sample sizes, and one-click rollback.
5. Add Knowledge editing and project settings. Test keyboard access and dense graph layouts.

TypeScript fits the CLI, local service, and React interface in one language. Rust may be useful later for a constrained native service or unusually heavy graph computation; the current bottlenecks are model latency, validation quality, and state design rather than TypeScript execution speed.

[React Flow's TypeScript guide](https://reactflow.dev/learn/advanced-use/typescript) and [layout guide](https://reactflow.dev/learn/layouting/layouting) are starting points for an interactive graph. Layout choice should be tested with realistic task graphs before committing to one.

See [open source UI references](ui-references.md) for products to study before making the first mockup.
