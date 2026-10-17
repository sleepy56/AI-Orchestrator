# Neon storage status

Neon is opt in. Select `development` or `production` for every CLI action:

```text
orch shared neon status --environment development [--env-file path] [--project directory]
orch shared neon diagnose --environment development [--env-file path] [--project directory]
orch shared neon sync --environment development [--env-file path] [--project directory]
```

`status` reads local data and receipts only. `diagnose` makes read-only `SELECT` queries for expected tables and row counts. `sync` sends the allowlisted run snapshot and approved global lessons; it does not migrate tables. The existing `migrate` command is a separate explicit action.

Set `ORCH_NEON_DEVELOPMENT_URL` or `ORCH_NEON_PRODUCTION_URL` in the process environment or an explicit `--env-file`. `DATABASE_URL` is accepted only when `NEON_BRANCH` equals the selected environment. The two named URLs must point to separate databases. Destination status contains only the host and database name, never credentials or a URL.

The local API uses `GET /api/storage` for offline status of both environments. `POST /api/storage/diagnose` and `POST /api/storage/sync` require JSON `{ "environment": "development" | "production", "envFile"?: "path" }`. Each POST returns one environment status. The response is:

```json
{
  "environment": "development",
  "configuration": { "configured": true, "destination": { "host": "ep-example.neon.tech", "database": "orch" }, "error": null },
  "local": { "digest": "sha256-hex", "sourceEventPosition": { "count": 0, "runId": null, "sequence": null }, "counts": { "runs": 0, "tasks": 0, "attempts": 0, "lessons": 0 } },
  "pendingLocalChanges": true,
  "lastSuccess": null,
  "latestFailedAttempt": null,
  "lastConnectivityCheck": null
}
```

`GET` wraps the two statuses in `{ "environments": { "development": status, "production": status } }`. `lastSuccess` contains `at`, `durationMs`, `digest`, `sourceEventPosition`, and `counts`. `latestFailedAttempt` contains `at`, `durationMs`, and a safe `error`. `lastConnectivityCheck` contains `at`, `durationMs`, `ok`, optional `error`, and on success a `tables` map with `{ "present": boolean, "count": number | null }` for each expected table. Missing configuration sets `configured: false`, `destination: null`, and a safe `error`. A failed sync retains the previous success receipt and leaves local use available.
