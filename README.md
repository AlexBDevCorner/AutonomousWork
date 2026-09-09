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

### Ownership & authorization

Five roles. Each role has an allow-list; everything else is forbidden.
Agents must never "helpfully" act outside their role, even if blocked.

- **Human** — owns intent and authorization:
  - Creates tasks.
  - Edits requirements (task body, acceptance criteria, `depends_on`).
  - Changes `draft` → `ready`.
  - Changes `priority`.
  - Can pause projects (`enabled: false`).
  - This is the only role that may do any of the above.

- **Dispatcher** — selects ready work:
  - Selects the next eligible `ready` task per Execution contract below.
  - Starts execution (claims `ready` → `in_progress`).
  - Never invents work: never creates tasks, never edits requirements,
    never changes `draft` → `ready`, never changes `priority`.

- **OpenCode** — implements exactly one selected task:
  - Implements the single task claimed by the Dispatcher.
  - Creates/updates the PR in the target repository.
  - Never selects future tasks; never starts unclaimed work; never edits
    task requirements, `priority`, or other tasks.

- **ChatGPT** — reviews PRs:
  - Reviews PRs against task acceptance criteria.
  - Requests changes or approves.
  - Never implements code; never commits to target repos.
  - Never changes requirements (no edits to task files, no `priority` /
    `depends_on` / body changes).

- **Reconciler** — syncs execution state:
  - Updates execution metadata/status (`in_progress` → `review` →
    `done`, or → `blocked` with reason) based on observed Dispatcher /
    OpenCode / ChatGPT outcomes.
  - Never changes task content (no edits to goal, requirements,
    acceptance criteria, `priority`, `depends_on`, or `id`).

Authorization boundary:

- `draft` → `ready` is the human authorization boundary. It is the only
  transition that makes work executable, and only the Human may perform it.
- No agent (Dispatcher, OpenCode, ChatGPT, Reconciler) may promote `draft`
  to `ready`, edit requirements to make a task "ready enough", or infer
  authorization from comments, PRs, or chat. If it is not `ready` in the
  committed front matter, it does not execute. No exceptions.

| Action | Human | Dispatcher | OpenCode | ChatGPT | Reconciler |
| --- | :---: | :---: | :---: | :---: | :---: |
| Create task | ✅ | ❌ | ❌ | ❌ | ❌ |
| Edit requirements / body | ✅ | ❌ | ❌ | ❌ | ❌ |
| `draft` → `ready` | ✅ | ❌ | ❌ | ❌ | ❌ |
| Change `priority` / `depends_on` | ✅ | ❌ | ❌ | ❌ | ❌ |
| Pause project (`enabled`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Select next `ready` task | ❌ | ✅ | ❌ | ❌ | ❌ |
| Claim `ready` → `in_progress` | ❌ | ✅ | ❌ | ❌ | ❌ |
| Implement task / open PR | ❌ | ❌ | ✅ (one claimed task) | ❌ | ❌ |
| Review PR (approve / request changes) | ✅ | ❌ | ❌ | ✅ | ❌ |
| Update status `in_progress`/`review`/`blocked`/`done` | ✅ | ❌ | ❌ | ❌ | ✅ |

### Execution contract (for workers)

Roles in brackets are the only roles allowed to perform that step
(see Ownership & authorization above).

1. [Dispatcher] Scan `projects/*/project.yaml`; skip projects with
   `enabled: false`.
2. [Dispatcher] Scan `projects/*/tasks/*.md`; parse front matter.
3. [Dispatcher] Eligible = `status == ready` AND all `depends_on` are `done`
   AND project has fewer than `max_active_tasks` tasks in `in_progress`.
4. [Dispatcher] Sort eligible by `priority` descending, then `id` ascending;
   pick first. If none eligible, stop — never invent work.
5. [Dispatcher] Claim by committing `status: in_progress` before starting
   work. [OpenCode] then implements exactly that one claimed task and
   creates/updates the PR in the target repository.
6. [Reconciler] On completion, set `status: review` (or `blocked` with reason
   in body). [ChatGPT] reviews the PR (requests changes or approves).
   [Reconciler] promotes `review` → `done` only after approval. Human may
   override any status at any time.

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
