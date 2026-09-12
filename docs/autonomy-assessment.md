# Plan assessment and implementation

Assessment date: 2026-09-12. Repository files, GitHub run/job logs and open PRs
were checked. A local implementation is not evidence that a workflow is deployed.

## Incident

[RepoManager run 2](https://github.com/AlexBDevCorner/RepoManager/actions/runs/34655000198)
was already cancelled. At 22:42:39 UTC on September 11 its worker logged
`permission: external_directory`, `action: ask`, then waited for access to
`D:\a\_temp\_github_workflow\*`. Cancellation arrived at 22:48:45 UTC.
This confirms the permission hang rather than merely inferring it from an active step.

The worker change supplies an action-scoped `OPENCODE_CONFIG_CONTENT` override:
external-directory access is allowed, questions are denied, and repeated failing
tool loops are denied. Denying the loop stops waste rather than auto-approving
it indefinitely. Other defaults are retained. A 35-minute agent timeout and
50-minute job timeout contain other stalls.

OpenCode's [configuration loader and permission defaults](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/permissions.mdx)
support these permissions. Its [GitHub action](https://github.com/anomalyco/opencode/blob/dev/github/action.yml)
invokes `opencode github run` without an auto-approval input.

## Coverage

| Plan stages | Already present at assessment | Work added / remaining checkpoint |
| --- | --- | --- |
| 1-5: control model, ownership, template, validation, selection | Implemented; 42 existing tests pass | Added validated JSON catalog for orchestration; retained .NET as planning authority |
| 6: cross-repository App authentication | App-token test workflow exists | No runs of that test were returned. App installation, secret availability and additional write/check permissions need a successful test |
| 7-10: OpenCode pilot, worker, PR metadata, concurrency | Implemented but pilot stalled; no open RepoManager PR | Fixed approval wait; added claim, pause, attempt and exact-PR gates. Target workflow must be merged after control code |
| 11: dispatcher | Absent | Manual dry-run/apply workflow; durable claim before dispatch; project allowlist; current target checks; no schedule enabled |
| 12: reconciliation | Absent | Run correlation by task plus attempt UUID; PR/run/merge observations; status-only task edits; separate execution JSON; atomic state commit |
| 13: review protocol | Absent | Finished protocol and hourly reviewer prompt in reviewer/CHATGPT_REVIEW.md |
| 14: normal ChatGPT scheduled reviewer | Not configured by this work | Requires the normal ChatGPT scheduler and a verified identity that can submit GitHub reviews. No claim that a read connector can approve PRs |
| 15: review feedback | Trusted `/oc` comments existed | Replaced unrestricted comment execution with deterministic workflow dispatch tied to a trusted review ID and current head SHA |
| 16: runaway protection | Trusted-comment author filter only | Three correction rounds, three manual pilot attempts, three project starts/day, timeouts, duplicate-claim/run detection; no automatic resend of uncertain dispatches |
| 17: failure handling | Workflow failure only | Recorded run URL/conclusion, missing PR, closed PR, merge conflict, missing dispatch and timeout reasons; transient HTTP reads retry. Worker failure recovery remains an explicit operator decision |
| 18: CI gate | No target CI workflow | Added Windows restore/build/full-test PR workflow. Making build-and-test and a review required on master still requires repository protection configuration |
| 19: complete pilot | Not completed | Local deterministic negative-path tests and real read-only API preview are possible now. Live implementation/review/correction/merge cycle still needs the preceding deployment and reviewer checkpoints |
| 20: second project | Definition exists, enabled in project.yaml | Dispatcher allowlist excludes MandarinBotNet until RepoManager's complete pilot succeeds |
| 21: operator status | Absent | Markdown status, Actions summary and review queue artifact |
| 22: cost limits | Absent | Attempt timestamps, run IDs, outcomes, correction counts and daily start budget; no claim of exact token/Go quota accounting |
| 23: pause controls | Per-project enabled flag | Added global execution switch and enrolled-task allowlist; worker rechecks current switches after waiting in the queue |
| 24: automatic merging | Absent | Deliberately deferred. Human merge remains the completion boundary |

## Changes to the proposed design

- A review approval is not task completion. Only an observed merge produces
  `done`, merge SHA and completion timestamp.
- Keep execution records in `automation/state.json`; mutate only the task's
  front-matter status. Requirements, priority, dependencies and Markdown body
  retain their bytes. All state files change in one Git tree/commit with a
  non-force branch update. A racing planning commit causes dispatch to stop.
- Persist a unique attempt before sending workflow_dispatch. If a request times
  out, correlate the eventual run rather than issuing a duplicate request.
- Dispatch corrections directly from submitted reviews, not from `/oc` comments.
  This gives the same PR fix loop an enforceable identity, SHA and round limit.
- Stop after a worker failure for the initial rollout. Repeating a quota error,
  permission failure, contradictory task or partial implementation automatically
  is not a useful recovery policy. Reads retry transient server failures;
  non-idempotent writes do not.

## Planning conflict that requires an owner decision

RM-002 requests new task documents in this control repository from a RepoManager
worker. That conflicts with the worker's read-only control checkout and the
human ownership of planning. Its specification was left unchanged. The dispatcher
allows only RM-001, so completing the pilot cannot accidentally start RM-002.
Rewrite RM-002 as a target-repository proposal document for human acceptance, or
handle backlog authoring as a separate planning activity before expanding the allowlist.

RM-001 itself explicitly tests the manual worker and excludes lifecycle changes.
The new claimed-worker path is implemented separately. Do not claim the manual
RM-001 run proves the full lifecycle; authorize a suitable end-to-end pilot task
before testing all of stage 19.

## Verification performed

- Control .NET suite: 42 passed.
- New orchestration suite: 33 passed, including races, negative paths, caps,
  freshness checks, claim ordering and uncertain network responses.
- RepoManager full Release test suite: 358 passed, comprising 104 Core, 142 App
  and 112 integration tests.
- actionlint 1.7.12 accepted both changed control workflows and both target workflows.
- Real GitHub preview returned `applied: false`, `executionEnabled: false`, no
  selected work and no pending reviews. No model run or repository write occurred.
- Local .NET restore reported NU1900 because the inherited StandardsDigital
  package feed could not provide vulnerability data. Builds and tests succeeded;
  this does not establish a clean vulnerability audit.
