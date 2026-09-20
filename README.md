# AutonomousWork — Control Repository

Control repository for autonomous execution. Its only purpose is to describe
projects, tasks, priorities, and execution state in a machine-readable way.

Target repos are never described inline — each project maps to exactly one
target GitHub repository (see `projects/<project-id>/project.yaml`).

The dispatcher, reconciler and bounded worker contract are implemented, and the
RM-003 end-to-end lifecycle pilot has completed successfully. See
[the plan assessment](docs/autonomy-assessment.md),
[deployment and operations](docs/autonomy-operations.md), and
[the reviewer protocol](reviewer/CHATGPT_REVIEW.md). These distinguish tested
code from the remaining live pilot and account-configuration checkpoints.

## Structure

```text
AutonomousWork/
  README.md
  schema/
    project.schema.json
    task.schema.json
  templates/
    task.md
  tools/
    AutonomousWork.Core/    # shared model: RepoLoader (validate), WorkSelector (next)
    AutonomousWork.Cli/     # `autonomous-work` CLI (validate, next)
    AutonomousWork.Tests/   # deterministic xUnit tests over Core
  AutonomousWork.sln
  .github/
    workflows/
      validate.yml        # control-repo CI: bad planning never reaches the dispatcher
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
`schema/task.schema.json`. Body follows `templates/task.md`.

```markdown
---
id: RM-001
priority: 100
status: draft
depends_on: []
---

# RM-001 — Title

## Goal

## Context

## Requirements

## Architectural direction

## Acceptance criteria

## Verification

## Out of scope
```

Rules:

- Task IDs must be globally unique across all projects (e.g. `RM-*`,
  `MB-*`). File name must be `<id>.md`.
- `priority` is machine-readable: integer `0–1000`, higher number = execute
  first. Ties broken by task ID ascending.
- `depends_on` lists task IDs that must be `done` before this task is eligible.
  Dependencies must live in the same project (cross-project dependencies are
  rejected by validation).
- Only tasks with `status: ready` (and all dependencies `done`) are executable.
- Supported statuses:
  - `draft` — not yet specified, never executed.
  - `ready` — eligible for execution.
  - `in_progress` — claimed by a worker (one worker per task).
  - `review` — work finished, awaiting human/automated verification.
  - `blocked` — cannot proceed, requires intervention.
  - `done` — completed and verified.
- Every non-`draft` task must contain all template sections (`Goal`,
  `Context`, `Requirements`, `Acceptance criteria`, `Verification`,
  `Out of scope`; `Architectural direction` is recommended but optional) so
  the file alone tells OpenCode what completion means. `draft` tasks are
  exempt (missing sections are warnings) so humans can iterate.
- `Out of scope` is mandatory: autonomous coding agents expand tasks unless
  explicitly told what NOT to do. Anything listed there must become a new
  `draft` task instead of scope creep.

### Ownership & authorization

Five roles. Each role has an explicit set of allowed actions; everything else is forbidden.
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

- **ChatGPT** — reviews and guarded-merges autonomous PRs:
  - Reviews PRs against task acceptance criteria.
  - Requests changes or approves against the exact current head SHA.
  - After a trusted approval, may merge only when the reviewer protocol's
    current-head, CI, mapping, mergeability, and expected-head guards all pass.
  - Never implements code or edits target-repository code directly.
  - Never changes requirements (no edits to task files, no `priority` /
    `depends_on` / body changes) and never marks tasks `done`.

- **Reconciler** — syncs execution state:
  - Updates execution metadata/status (`in_progress` → `review` →
    `done`, or → `blocked` with reason) based on observed Dispatcher /
    OpenCode / ChatGPT outcomes.
  - Never changes task content (no edits to goal, requirements,
    acceptance criteria, `priority`, `depends_on`, or `id`).

Authorization boundary:

- `draft` → `ready` is the human authorization boundary, and only the Human
  may perform it. Human authorization requires `ready`: a task that was
  never `ready` never executes.
- Automated execution additionally requires a valid Dispatcher claim:
  the Dispatcher flips the authorized `ready` task to `in_progress` at a
  pinned control commit and the worker executes exactly that claimed task.
  By the time OpenCode runs, the status is therefore `in_progress`, not
  `ready` — that is the claim working as designed, not a bypass.
- No agent (Dispatcher, OpenCode, ChatGPT, Reconciler) may promote `draft`
  to `ready`, edit requirements to make a task "ready enough", or infer
  authorization from comments, PRs, or chat. Without the human `ready`
  first, nothing downstream may execute it. No exceptions.

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
| Merge approved autonomous PR under guarded protocol | ✅ | ❌ | ❌ | ✅ | ❌ |
| Update status `in_progress`/`review`/`blocked`/`done` | ✅ | ❌ | ❌ | ❌ | ✅ |

### Execution contract (for workers)

Roles in brackets are the only roles allowed to perform that step
(see Ownership & authorization above). Selection uses two levels — local
candidacy (control-repo state only, implemented exactly by
`autonomous-work next`, no AI involved) and dispatch eligibility (which
additionally observes remote target-repo state). The split exists so one
blocked project can never starve the others.

1. [Dispatcher] Scan `projects/*/project.yaml`; skip projects with
   `enabled: false`.
2. [Dispatcher] Scan `projects/*/tasks/*.md`; parse front matter.
3. [Dispatcher] Local candidate per project = `status == ready` AND all
   `depends_on` are `done` AND the project has fewer than
   `max_active_tasks` tasks in `in_progress`. This is exactly what
   `autonomous-work next <project-id>` returns — control-repo state only,
   no remote calls.
4. [Dispatcher] Dispatch eligibility: a project is dispatchable only if it
   has a local candidate AND has no open `autonomous` PR in its target
   repository (single-active-task rule, step 10 — enforced now by the
   worker's `guard` job and `autonomous-worker` concurrency group). Take
   one local candidate per dispatchable project, sort those candidates by
   `priority` descending, then `id` ascending, and dispatch the first.
   Example: RM-003 (priority 100) blocked by an open RepoManager PR must
   not starve a free MB-002 (priority 90) — MB-002 dispatches. If no
   project is dispatchable, stop — never invent work.
5. [Dispatcher] Claim by committing `status: in_progress` before starting
   work, always passing the pinned control commit SHA to the worker.
   [OpenCode] then implements exactly that one claimed task and
   creates/updates the PR in the target repository.
6. [Reconciler] After a successful worker and observed PR, set `status: review`,
   or `blocked` with a reason in the execution ledger. [ChatGPT] reviews the PR
   and may guarded-merge an approved exact head according to
   `reviewer/CHATGPT_REVIEW.md`. Approval alone does not complete the task:
   [Reconciler] sets `done` only after an observed merge, recording its SHA and
   timestamp. Human status overrides must reconcile the matching execution record
   in the same operator change.

### Autonomous worker pilot (RepoManager — steps 8–10)

The original steps 8-10 pilot below describes the deployed workflow at assessment
time. The replacement worker and dispatcher contract, including claimed-task
validation, are described in [operations](docs/autonomy-operations.md). Deployment
requires merging the control implementation before the target workflow change.

- Workflow: `autonomous-worker.yml` in `AlexBDevCorner/RepoManager`
  (`.github/workflows/`), `workflow_dispatch` with `task_id`, `task_path`,
  `control_repo`, `control_commit` (empty = default branch HEAD), `model`.
  Target-repo secrets required: `OPENCODE_API_KEY` plus `CONTROL_REPO_TOKEN`
  (fine-grained PAT, Contents: Read on this control repo only — the control
  repo is private and a workflow token cannot read across repositories).
- The worker checks out the target repo plus this control repo (read-only
  `control/`), deterministically validates the task identity (spec exists,
  file name and front-matter `id` match `task_id`, the spec's project maps
  to the target repository), then requires eligibility: `autonomous-work
  next <project>` at the pinned checkout must select exactly the dispatched
  task, so manual dispatch cannot bypass `ready` / dependencies / `enabled`
  / capacity rules. It records the exact control SHA, runs OpenCode Go with
  the stable wrapper prompt defined in the workflow, and must end with
  exactly one PR on `autonomous/<TASK-ID>` targeting `master`. (Step 11
  replaces the `next` re-check with claimed-task validation, since the
  Dispatcher will have moved the task to `in_progress` first.)
- Autonomous PR contract (step 9) — title `[<TASK-ID>] <description>`,
  labels `autonomous` + `autonomous:opencode` + `task:<TASK-ID>`, body
  sections `Task` / `Control specification` / `Implementation` /
  `Verification` / `Autonomous execution`, with `Control specification`
  recording the pinned `<control-repo>@<sha>: <task-path>`. This is the
  deterministic `Task ↔ PR ↔ Repository` mapping: a task's PR is the single
  PR that has ever existed carrying its `task:<ID>` label on
  `autonomous/<TASK-ID>` (retries reopen it; redispatch after merge fails).
  Title and labels are auto-repaired; missing evidence sections fail the
  run — verification results are never invented.
- Single active task (step 10): per-repository `autonomous-worker`
  concurrency group (`cancel-in-progress: false`, runs queue instead of
  overlapping) plus a `guard` job that fails fast while a *different*
  autonomous task has an open PR (detected by `autonomous` label or
  `autonomous/` branch prefix). Groups are per target repository, so
  RepoManager and MandarinBotNet still progress concurrently.
- Review-fix preview: `/oc …` comments by trusted actors
  (`OWNER`/`MEMBER`/`COLLABORATOR`) re-run OpenCode on the same PR
  (`opencode.yml` in the target repo). Round/attempt caps arrive with
  step 16.

## Tooling (`autonomous-work` CLI)

Deterministic .NET solution (`AutonomousWork.sln`): `AutonomousWork.Core`
holds the shared model — `RepoLoader` (validation) and `WorkSelector`
(selection) — used by both the CLI and the xUnit test suite. No AI involved.

```sh
dotnet run --project tools/AutonomousWork.Cli -- validate [--root <path>]
dotnet run --project tools/AutonomousWork.Cli -- next [project-id] [--root <path>]
dotnet test AutonomousWork.sln
```

`--root` defaults to the current directory (run from the repo root).

### Source of truth

`autonomous-work validate` (C#) is authoritative. `schema/*.json` are
supplemental — editor/IDE hints and human-readable documentation. Rationale:
the safety-critical rules are cross-file (unique IDs, dependency existence
and ordering, per-project capacity, section completeness) and cannot be
expressed in JSON Schema at all. On any conflict between the schemas and the
CLI, the CLI wins; keep the schemas in sync on a best-effort basis
(same statuses, same `0–1000` priority range, same `Owner/Repo` pattern).

### `validate`

Fails (exit 1) on any of: duplicate task IDs; invalid statuses; nonexistent
dependencies; invalid repositories; malformed priorities; tasks in unknown
project directories; `done` tasks depending on unfinished tasks; unknown
front-matter properties; plus ID/file-name mismatches, project ID/directory
mismatches, self-dependencies, duplicate dependencies, cross-project
dependencies, `in_progress` overflow beyond `max_active_tasks`, stray task
files outside `tasks/`, and missing template sections on non-`draft` tasks.
Warnings (e.g. incomplete `draft` tasks, shared repositories) never fail.

### `next`

Implements local candidate selection (Execution contract step 3) exactly —
control-repo state only, no remote calls. Input is the project ID:

```sh
dotnet run --project tools/AutonomousWork.Cli -- next repomanager
```

```json
{
  "taskId": "RM-001",
  "repository": "AlexBDevCorner/RepoManager",
  "taskPath": "projects/repomanager/tasks/RM-001.md"
}
```

Exit codes: `0` + JSON object on stdout when work is available; `2` with
empty stdout (reason on stderr) when there is nothing to do — disabled
project, `max_active_tasks` reached, or no eligible `ready` task; `1` on
errors. Omit the project ID to preview the global top local candidate
across all enabled projects — but the step-11 dispatcher must NOT dispatch
that result blindly: it calls `next <project>` per project without an open
`autonomous` PR and sorts the returned candidates itself (Execution
contract step 4), so a remotely blocked project never starves the rest.
`next` runs the SAME full validation as `validate` first (structure AND
required sections) and refuses selection when the control repo has any
ERROR — there is no lenient mode, so bad planning can never reach the
dispatcher even if it bypasses CI.

### Tests

`tools/AutonomousWork.Tests` (xUnit, 40+ tests) covers every validation rule
and the full selection matrix — priority ordering, ID tie-break, dependency
gating, disabled projects, capacity limits, unknown projects, invalid-repo
refusal, and the `review`-does-not-block rule — against isolated synthetic
fixture repos in temp directories (never the seed tasks). Run via
`dotnet test AutonomousWork.sln`; CI runs the same command.

## CI

`.github/workflows/validate.yml` runs `autonomous-work validate` AND
`dotnet test` on every push and pull request. A bad planning change
(duplicate ID, bad status, dangling dependency, incomplete `ready` task,
...) or a broken safety rule fails the build before the dispatcher can ever
see it.

## Adding a new project

1. Create `projects/<project-id>/project.yaml` (see `schema/project.schema.json`).
2. Create `projects/<project-id>/tasks/` with at least one `*-001.md` task.
3. Verify: unique IDs, valid `repository`, valid front matter.
4. Commit and push. Enroll the project in `automation/config.json` only after
   its worker, authentication and CI are verified. Individual tasks are authorized
   solely by the Human changing `status: draft` to `status: ready`.

## Adding a new task

1. Pick next free ID for the project prefix (`RM-*`, `MB-*`, ...).
2. Copy `templates/task.md` to `projects/<project-id>/tasks/<ID>.md`,
   set front matter `id` to match the file name, start with `status: draft`.
3. Fill in every section (goal + requirements + acceptance criteria +
   verification + out of scope required). Promote `draft` → `ready` (Human
   only) when the file alone lets OpenCode understand completion.
4. Set `priority` (higher = more urgent) and `depends_on` if ordered.
5. Run `dotnet run --project tools/AutonomousWork.Cli -- validate` before
   pushing — CI enforces the same check.
