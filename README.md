# AutonomousWork — Control Repository

Control repository for autonomous execution. Its only purpose is to describe
projects, tasks, priorities, and execution state in a machine-readable way.

Target repos are never described inline — each project maps to exactly one
target GitHub repository (see `projects/<project-id>/project.yaml`).

## Structure

```text
AutonomousWork/
  README.md
  schema/
    project.schema.json
    task.schema.json
  projects/
    repomanager/
      project.yaml
      tasks/
        RM-001.md
        RM-002.md
    mandarinbotnet/
      project.yaml
      tasks/
        MB-001.md
```

## Concepts

### Project (`projects/<project-id>/project.yaml`)

Validated against `schema/project.schema.json`.

```yaml
id: repomanager
name: RepoManager
repository: AlexBDevCorner/RepoManager
enabled: true
max_active_tasks: 1
```

Rules:

- `id` must match its directory name (`projects/<id>/project.yaml`).
- `repository` is `Owner/Repo` of exactly one target GitHub repository.
- `enabled: false` pauses all execution for that project.
- `max_active_tasks >= 1` limits concurrent `in_progress` tasks per project.
- Multiple projects can be defined side by side; each is independent.

### Task (`projects/<project-id>/tasks/<TASK-ID>.md`)

Markdown file with YAML front matter. Front matter is validated against
`schema/task.schema.json`.

```markdown
---
id: RM-001
priority: 100
status: ready
depends_on: []
---

# Title

Body, context, acceptance criteria, notes.
```

Rules:

- Task IDs must be globally unique across all projects (e.g. `RM-*`,
  `MB-*`). File name must be `<id>.md`.
- `priority` is machine-readable: integer, higher number = execute first.
  Suggested range `0–1000`. Ties broken by task ID ascending.
- `depends_on` lists task IDs that must be `done` before this task is eligible.
- Only tasks with `status: ready` (and all dependencies `done`) are executable.
- Supported statuses:
  - `draft` — not yet specified, never executed.
  - `ready` — eligible for execution.
  - `in_progress` — claimed by a worker (one worker per task).
  - `review` — work finished, awaiting human/automated verification.
  - `blocked` — cannot proceed, requires intervention.
  - `done` — completed and verified.

### Execution contract (for workers)

1. Scan `projects/*/project.yaml`; skip projects with `enabled: false`.
2. Scan `projects/*/tasks/*.md`; parse front matter.
3. Eligible = `status == ready` AND all `depends_on` are `done` AND project
   has fewer than `max_active_tasks` tasks in `in_progress`.
4. Sort eligible by `priority` descending, then `id` ascending; pick first.
5. Claim by committing `status: in_progress` before starting work.
6. On completion, set `status: review` (or `blocked` with reason in body).
   Only a reviewer promotes `review` → `done`.

## Adding a new project

1. Create `projects/<project-id>/project.yaml` (see `schema/project.schema.json`).
2. Create `projects/<project-id>/tasks/` with at least one `*-001.md` task.
3. Verify: unique IDs, valid `repository`, valid front matter.
4. Commit and push. Workers pick it up automatically.

## Adding a new task

1. Pick next free ID for the project prefix (`RM-*`, `MB-*`, ...).
2. Copy front matter template above, start with `status: draft`, promote to
   `ready` when fully specified (goal + acceptance criteria required).
3. Set `priority` (higher = more urgent) and `depends_on` if ordered.
