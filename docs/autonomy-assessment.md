# Plan assessment and implementation

Assessment date: 2026-09-12. Status updated 2026-09-20 after the RM-003
end-to-end lifecycle pilot. Repository files, GitHub run/job logs and PRs were
checked. A local implementation is not evidence that a workflow is deployed.

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
| 6: cross-repository App authentication | App-token test workflow exists | Verified live during RM-003 after granting/approving the required App installation permissions |
| 7-10: OpenCode pilot, worker, PR metadata, concurrency | Implemented | RM-001 proved the manual worker; RM-003 proved claimed worker execution, PR metadata, CI and verification |
| 11: dispatcher | Implemented | Durable claim before dispatch; enrolled projects; `ready` is the sole task authorization status; scheduled every 30 minutes and always applies |
| 12: reconciliation | Absent | Run correlation by task plus attempt UUID; PR/run/merge observations; status-only task edits; separate execution JSON; atomic state commit |
| 13: review protocol | Implemented | reviewer/CHATGPT_REVIEW.md now defines exact-head review plus guarded merge |
| 14: normal ChatGPT scheduled reviewer | Configured | Hourly ChatGPT automation re-reads the protocol and can submit trusted reviews with GitHub write access |
| 15: review feedback | Trusted `/oc` comments existed | Replaced unrestricted comment execution with deterministic workflow dispatch tied to a trusted review ID and current head SHA |
| 16: runaway protection | Implemented | Three correction rounds, five implementation attempts, eight project starts/day, timeouts, duplicate-claim/run detection; no automatic resend of uncertain dispatches |
| 17: failure handling | Workflow failure only | Recorded run URL/conclusion, missing PR, closed PR, merge conflict, missing dispatch and timeout reasons; transient HTTP reads retry. Worker failure recovery remains an explicit operator decision |
| 18: CI gate | No target CI workflow | Added Windows restore/build/full-test PR workflow. Making build-and-test and a review required on master still requires repository protection configuration |
| 19: complete pilot | Completed for the approval path | RM-003 ran `ready → in_progress → review → approved → merged → done`; the separate CHANGES_REQUESTED/correction branch still needs a dedicated live fixture |
| 20: second project | Definition exists, enabled in project.yaml | Not enrolled in `automation/config.json`; onboard only after scheduled dispatch/review and correction flow are proven |
| 21: operator status | Absent | Markdown status, Actions summary and review queue artifact |
| 22: cost limits | Absent | Attempt timestamps, run IDs, outcomes, correction counts and daily start budget; no claim of exact token/Go quota accounting |
| 23: pause controls | Implemented | Global execution switch plus project enrollment/project enabled flag; a Human may de-authorize unclaimed work by changing `ready` back to `draft`; worker rechecks current controls after queueing |
| 24: automatic merging | Configured | ChatGPT may merge only a trusted-approved exact head after fresh CI/mapping/mergeability checks using expected_head_sha; reconciler still owns done |

## Changes to the proposed design

- A review approval is not task completion. ChatGPT may perform a guarded merge
  after approval, but only an observed merge produces `done`, merge SHA and
  completion timestamp through the reconciler.
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

## Planning conflict resolution

RM-002 was handled as control-repository planning rather than by the target
RepoManager worker, preserving the worker's read-only control checkout and human
ownership of planning. It produced RM-003 as the authorized implementation task.
RM-003 then completed the live claimed-worker approval/merge lifecycle, so no
per-task automation allowlist is retained. Future task-level authorization is
only the Human transition from `draft` to `ready`.

## Verification performed

- Control .NET suite: 42 passed.
- New orchestration suite: 33 passed, including races, negative paths, caps,
  freshness checks, claim ordering and uncertain network responses.
- RepoManager full Release test suite: 358 passed, comprising 104 Core, 142 App
  and 112 integration tests.
- actionlint 1.7.12 accepted both changed control workflows and both target workflows.
- The RM-003 dry run selected the expected task without writes; the applied run
  dispatched OpenCode, produced RepoManager PR #22, passed CI, received a trusted
  approval, merged, and reconciled to `done` with merge SHA/timestamp recorded.
- Local .NET restore reported NU1900 because the inherited StandardsDigital
  package feed could not provide vulnerability data. Builds and tests succeeded;
  this does not establish a clean vulnerability audit.
