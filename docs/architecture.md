# Runtime and storage decisions

## Current state

`orch init` creates `.orch/tasks.json` and `.orch/models.json`. The first file is the task graph; the second maps logical routes such as `sol-high` to provider model IDs, effort, enabled state, and user weight. `orch models add` can register another Codex model without a source change. An added model is disabled until explicitly enabled. Claude is represented in the registry and by an unavailable provider adapter; it cannot execute yet.

`orch run` uses fake workers by default. `orch run --executor codex --check "npm test"` starts the installed Codex CLI with `codex exec --json`, the project directory, a model and reasoning effort. It uses the Codex CLI's existing login. A live task must produce a final response and pass the user-supplied validation command before Orch marks it complete. Live tasks run sequentially because they share one working tree. The check command runs through the system shell in the project directory; only use a command you trust. A passing check is the current evidence, so choose one that actually checks the task. Later versions should support per-task checks and manual review.

`orch knowledge add` stores notes with either project or global scope. Project history is `.orch/knowledge.jsonl`; global history is `$ORCH_HOME/knowledge.jsonl` or `~/.orch/knowledge.jsonl`. Attempts record task category, route, result and token usage when Codex reports it. Fake attempts are marked simulated. Global live attempt records omit task descriptions, validation output, and check commands to avoid copying project text into shared history. `orch history` reads the project attempt log. These files are an audit trail and input for future routing analysis; current routing uses task difficulty, risk, type and configured model weights. There is no automatic model retraining or price optimization yet.

## Why files now, SQLite for the product

JSON keeps editable plans and model settings easy to inspect and share. JSONL can append an event without rewriting a large history, and keeps this initial CLI dependency free. It is weak for cross-project queries, concurrent writers, indexed timeline replay, and transactional updates. SQLite is the right next storage step when the visual interface and automatic policy revisions arrive. Migrate JSONL records into versioned tables and preserve original timestamps and simulated/live labels. Keep secrets in each provider's credential store or process environment, never in Orch history.

## Provider boundary

Each provider implements the `Executor` contract. The logical router chooses a tier; the model registry maps the tier to an enabled profile; the provider executes it. A new Codex model can be registered and weighted through the CLI. A new provider requires a dedicated adapter, authentication, usage parsing, and validation tests before its models can be enabled. Claude remains disabled until those pieces exist and the user has access.

## Known limits before a portfolio demo

- The current task graph snapshot and knowledge event append are separate writes. A crash between them can leave an incomplete event trail. SQLite transactions should solve this.
- The same project should have one Orch process running at a time. File locking is not implemented.
- An interrupted live task remains `running`. Inspect changes, stop the original process, and explicitly use `orch retry TASK-ID` before another run.
- Validation is one shell command for every live task. It does not prove a semantic change is correct unless the command checks that change.
- Token counts are recorded when present; dollar cost is not calculated without a reliable price source and billing context.
- Simulated attempts must not influence real model performance recommendations.
- The current registry uses example Codex model IDs; availability depends on the signed-in account. Change the registry for your account before a live run if needed.

## References

- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) documents `codex exec`, JSONL events, sandbox options, and reuse of CLI authentication.
- [Codex authentication](https://learn.chatgpt.com/docs/auth) documents `codex login` and cached sign-in.
- [SQLite WAL mode](https://www.sqlite.org/wal.html) documents the concurrency behavior proposed for the future database.
