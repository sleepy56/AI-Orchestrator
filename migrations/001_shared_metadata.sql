CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shared_projects (
  project_id uuid PRIMARY KEY,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shared_runs (
  project_id uuid NOT NULL REFERENCES shared_projects(project_id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('live', 'simulated')),
  status text NOT NULL CHECK (status IN ('running', 'paused', 'finished')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  last_sequence integer NOT NULL CHECK (last_sequence > 0),
  policy_version integer NOT NULL CHECK (policy_version >= 0),
  PRIMARY KEY (project_id, run_id)
);

CREATE TABLE IF NOT EXISTS shared_run_tasks (
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  task_id text NOT NULL CHECK (task_id ~ '^[A-Za-z0-9_-]+$'),
  category text NOT NULL CHECK (category IN ('rename', 'refactor', 'analysis', 'test', 'other')),
  risk text NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'critical')),
  status text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  depends_on text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (project_id, run_id, task_id),
  FOREIGN KEY (project_id, run_id) REFERENCES shared_runs(project_id, run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shared_attempts (
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  task_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  route text NOT NULL CHECK (route ~ '^[a-z0-9-]+$'),
  passed boolean NOT NULL,
  model text CHECK (model IS NULL OR model ~ '^[A-Za-z0-9_.:-]+$'),
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  PRIMARY KEY (project_id, run_id, task_id, attempt),
  FOREIGN KEY (project_id, run_id, task_id) REFERENCES shared_run_tasks(project_id, run_id, task_id) ON DELETE CASCADE
);
