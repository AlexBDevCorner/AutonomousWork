# Autonomous PR review and guarded merge

An event-driven OpenCode reviewer in GitHub Actions performs the code assessment.
Model-free GitHub Actions code then posts the commit-bound review and performs any
merge, after independently re-checking current repository state. The dispatcher
handles REQUEST_CHANGES with bounded corrections. The reconciler marks work done
only after GitHub confirms the merge. Everything runs in GitHub; there is no
external queue.

## Enrollment and operation

Global switch: GitHub Actions variable `AUTONOMOUS_REVIEW_ENABLED=true`.
Project switch: `automation/config.json.projects[projectId].reviewEnabled`.
Both must be true before anything is reviewed or merged.

The ChatGPT Scheduled Task reviewers are retired (owner decision, 2026-11-02) and
must stay disabled. Each 10-minute dispatcher tick finds review-enabled executions
in `review` whose non-draft PR has green required CI and no trusted review of its
exact head, and dispatches **Autonomous OpenCode reviewer**
(`.github/workflows/autonomous-review.yml`, run name `review <TASK-ID> <SHA>`).
Each exact head gets at most three runs. A failed run (provider error, Go quota,
unparsable verdict, uncertain GitHub write) is retried on a later tick, then left
visible as failed runs and `reviewRuns: 3` in the dispatcher's `review-queue.json`
artifact. Idle ticks never call a model.

An exact head that already has a trusted APPROVED review but is still open gets a
model-free `merge-check <TASK-ID> <SHA>` run. An exact head with a trusted
CHANGES_REQUESTED review waits for the worker to correct it.

## The reviewer workflow

1. **review** job (model credential only, no GitHub write token): re-runs the
   bridge guards for the exact head before any model call (`evaluate`: control
   master config/state/task/protocol, enrollment, execution mapping, PR
   base/head/author/draft/mergeability, control-spec pin, base `AGENTS.md`,
   exact-head CI and raw reviews). It checks out the PR head as data only and
   strips PR-supplied OpenCode configuration, plugins and agent instructions. It
   confirms the configured model advertises the configured variant, then runs
   OpenCode with read/grep/glob/list tools only. Instructions and the strict
   verdict contract are in `reviewer/OPENCODE_REVIEW.md`.
2. **apply** job (no model, no PR code): re-validates the verdict and re-runs the
   guards against live state, discarding the verdict if the head, CI or reviews
   changed. It submits one `commit_id`-bound GitHub review with the dedicated
   personal reviewer token (or the worker App when the personal account authored
   the PR) and confirms it from the raw review list. For APPROVE it re-runs every
   merge guard twice and merges with the worker App token and GitHub's
   `expected_head_sha`. `WITHHOLD` posts no review, only a PR comment marked
   `<!-- autonomous-review-withheld:v1 -->` explaining what a human must decide.

The review body carries the deployment context, summary, blocking findings,
non-blocking P2 suggestions, the model and variant, and the run link. Together
with the run's `verdict` and `opencode-log` artifacts it is the audit trail.

Model settings: Actions variables `REVIEWER_MODEL` (default
`opencode-go/gemini-4-argon`) and `REVIEWER_VARIANT` (default `high`). There is no
silent downgrade: a variant the model doesn't advertise fails the run.

## Credentials and activation

1. `AUTONOMOUS_REVIEWER_TOKEN`: fine-grained token owned by `AlexBDevCorner`
   (the trusted reviewer, distinct from the worker App that authors PRs) for
   `MtgSoloSports`, `RepoManager` and `MandarinBotNet`, with **Pull requests: Read
   and write**. Renew it before it expires.
2. The worker GitHub App (`AUTONOMOUS_APP_CLIENT_ID`, `AUTONOMOUS_APP_PRIVATE_KEY`)
   must be installed on the control and target repositories with Contents and
   Pull requests write on the targets.
3. `OPENCODE_API_KEY`: a dedicated OpenCode Go API key stored as an AutonomousWork
   Actions secret (the MtgSoloSports secret is not visible here).
4. `AUTONOMOUS_REVIEW_ENABLED=true`. Never paste credential values into commits,
   documentation or chat.

The legacy Supabase queue bridge (`review-bridge.yml`) is no longer fed by any
reviewer and is removed separately once no queue rows are pending.

## Recovery and observation

- **Emergency stop:** set `AUTONOMOUS_REVIEW_ENABLED=false`, or a project's
  `reviewEnabled: false`. Stopping does not roll back a review or merge already
  made.
- **Manual review** stays the fallback: a trusted human review on the exact head
  is respected like any other. An APPROVED head is merged by the next merge-check
  run.
- **Re-running:** dispatch `Autonomous OpenCode reviewer` manually on `master`
  with the same inputs the dispatcher uses. Every run re-checks GitHub first, so a
  head that already has a trusted review is never reviewed twice.

## Finding payload

A `REQUEST_CHANGES` verdict needs at least one P0/P1 finding with a `description`
and either `path` + `line` or a `location`. P2 findings are listed in the review
body and never start a correction loop.
