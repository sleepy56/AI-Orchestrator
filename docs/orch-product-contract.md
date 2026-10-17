# Orch product contract

## Goal

Orch accepts a development goal for a registered repository, asks only clarifying questions that affect the plan, drafts a dependency graph and task-specific checks, and waits for the user to approve that plan. It then assigns ready tasks to isolated workers, validates each result, presents changes for merge approval, and records the evidence behind later routing decisions. The CLI and UI operate on the same project and run state.

## User decisions

- The user approves the plan, the proposed checks, each merge into the target branch, and every deployment. An approval names the exact revision it covers. Editing an approved plan or check invalidates that approval.
- Orch chooses bounded worker concurrency. It considers dependencies, available isolated workspaces, rate limits, remaining budget, expected token use, and model cost. A cheap model may justify more parallel work; expensive or complex work can run alone. Cost alone never determines concurrency.
- When a trustworthy provider limit or budget signal is near exhaustion, Orch starts no new worker, checkpoints the current run, and enters `paused_for_capacity` with a reason and reset estimate when known. Unknown availability is labeled unknown; Orch does not invent remaining tokens. An in-flight worker finishes or is stopped according to an explicit timeout and recovery policy.
- Orch may revise routing policy automatically within user constraints. Every revision has a version, previous and new rules, evidence, reason, timestamp, and rollback action. User limits on a model, provider, or spend take precedence over learned preferences.
- A local Docker Postgres database is the first shared metadata store. Neon can replace or synchronize that database later through the same storage boundary. No browser or worker receives a database connection string.

## End-to-end workflow

1. **Register project.** `orch init` or the UI records an opaque project ID, local directory, Git status, supported scripts, and an explicit list of context files. Project paths, source, architecture, product documents, and secrets remain in the repository or local runtime.
2. **Clarify and draft.** The planning agent reads the repository context, asks a short set of consequential questions, and produces a versioned plan. Each task has dependencies, acceptance criteria, expected files or areas, risk, proposed worker profile, required context, and a verification plan. The user can edit the draft in the CLI or UI.
3. **Prepare checks.** Orch runs the baseline checks and drafts task checks. A check specifies its command or review procedure, phase, working directory, timeout, and expected outcome. The user can add a command through the CLI or UI. Generated tests are reviewable artifacts; a worker changing an approved test must show the change and reason in its diff.
4. **Approve plan.** Orch records approval against the plan and check-set revisions. `orch run` refuses to execute an unapproved revision. The approved plan can contain tasks that run in parallel when their dependencies and file ownership permit it.
5. **Execute in isolation.** Each worker gets its own Git worktree and branch based on the approved base commit or an integrated dependency. Its context is an explicit manifest: pinned project documents, relevant code, task instructions, and a small set of reviewed project and global lessons. Orch records the lesson IDs actually supplied.
6. **Validate and review.** The worker runs its task checks. Orch records the exact checks, outputs, duration, retries, model profile, token usage, and applicable cost snapshot. A passing check is evidence for the stated criterion, not a blanket claim of semantic correctness. Failed checks return to the worker within retry limits or request user help.
7. **Integrate.** Orch can build a temporary integration worktree and run cross-task checks. It shows the combined diff, conflicts, test evidence, and merge target. The target branch changes only after user approval for that exact integrated revision. Deployment likewise requires a separate approval.
8. **Learn.** Orch records whether a task passed validation, passed review, merged, was reverted, or required human repair. Live results can create deduplicated lesson candidates. Project-specific details stay local. Only reviewed, generalized lessons can enter global knowledge.

## Verification layers

| Layer | Purpose | Example |
| --- | --- | --- |
| Baseline | Establish starting health | Existing project test and build commands |
| Task contract | Check a task's promised behavior | API, unit, migration, browser, or accessibility tests |
| Integration | Check combined branches and dependencies | Full suite, build, end-to-end flow |
| Review | Judge behavior tests cannot establish | Product fit, visual result, security, merge approval |

The plan lists a check for each acceptance criterion and labels criteria that need human review. Orch reports missing, skipped, and unrun checks separately from passes. A user-added CLI check has the same revision and result history as a generated check. Check commands run only in trusted local workspaces, with explicit timeouts and no automatic deployment side effects.

## Scheduling and capacity

- The scheduler starts only dependency-ready tasks whose required base commit and worktree are available. It limits parallelism by a configured maximum, observed provider limits, budget headroom, machine resources, and likely merge overlap.
- Estimated task tokens come from comparable prior live tasks and include uncertainty. Observed usage is recorded separately. Subscription usage limits and API dollar costs are distinct; unknown price or quota remains unknown.
- For ChatGPT-authenticated Codex, use an authenticated rate-limit source when available. For API-backed providers, use documented response headers and `Retry-After` where applicable. Rate-limit or quota failures pause scheduling rather than marking the task as a code failure. Resume rechecks capacity and the state of interrupted workers before another attempt.
- A cheaper route can be explored on suitable low-risk tasks within policy constraints. Route decisions retain the default fallback. Attempts from simulated runs never count as performance evidence.

## Data boundary

The repository and local runtime hold task descriptions, prompts, source code, diffs, test bodies, architecture and product documents, raw worker output, secrets, and filesystem paths. The shared Postgres store holds opaque project and run IDs, task category and risk, dependency IDs, status transitions, model profile, route-policy version, validation verdicts and check identifiers, retry count, token totals, latency, known cost snapshots, approval state, and reviewed generalized lessons. It may hold a pointer to local detail, never the detail itself.

The UI obtains portfolio and learning summaries from the shared store and asks the local project service for repository-specific detail when that machine is available. The CLI uses the same service contract. The sync adapter sends an allowlisted schema; unknown fields are rejected. Global lesson text requires review for identifying terms, project paths, product architecture, and unique product claims before upload. A user can inspect and remove synced records.

### Local command service (TASK-016)

The CLI `orch command --json` and the UI's local `POST /api/commands` accept the same `{ version: 1, kind, expectedRevision, payload }` envelope. The service rejects stale revisions and returns `{ revision, auditId, subjectId }`. `GET /api/commands` returns local detail, including task descriptions, check commands, policy rules, and the project directory. `GET /api/commands/shared` returns an explicit metadata projection: opaque project ID, record revision numbers, and audit IDs, timestamps, kinds, and revisions. Command payloads, directory paths, task descriptions, check bodies, policy rules, and local audit subjects never enter that projection. The projection is a boundary for a future shared adapter; these endpoints do not sync data. The service stores its local versioned records in `.orch/commands.v1.json`, and retains the existing task and model files for CLI compatibility. Legacy `init`, `plan`, `retry`, `models` mutations, and `run` record commands through the same service. Check and approval commands are versioned records here; execution gates and check runners are delivered in TASK-019 and TASK-020.

## Evidence and policy history

Every route decision records the candidate profiles, selected profile, policy version, applicable user constraint, relevant live evidence, and fallback. A policy revision records the author (`user` or `orch`), cause, old and new values, evidence IDs, and rollback link. The UI distinguishes:

- **Used:** lessons and context IDs actually sent to a worker in a run.
- **Observed:** live task outcomes that may inform later choices.
- **Candidate:** an unreviewed proposed lesson or route change.
- **Simulated:** fake-worker evidence excluded from model performance.

The system never states that an untried model would have passed a particular task. When comparable evidence or reliable price data is missing, it reports that limit and retains the established route.

## Initial delivery order

1. Shared CLI/UI domain API, project registration, and an explicit privacy allowlist.
2. Plan drafts, clarifying questions, task contracts, editable checks, and approval revisions.
3. Isolated worker worktrees, task validation, temporary integration, merge and deployment gates.
4. Capacity-aware scheduler with pause, checkpoint, and resume.
5. Docker Postgres metadata store and local-detail API; Neon adapter after the local schema and privacy tests pass.
6. UI workflows for onboarding, planning, approvals, active runs, evidence, policy history, and learning.

Every delivery step needs behavioral tests and a CLI path before the corresponding UI control is considered complete.
