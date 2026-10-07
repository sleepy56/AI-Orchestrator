CREATE TABLE IF NOT EXISTS shared_global_lessons (
  id uuid PRIMARY KEY,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
  task_category text NOT NULL CHECK (task_category IN ('rename', 'refactor', 'analysis', 'test', 'other')),
  updated_at timestamptz NOT NULL
);
