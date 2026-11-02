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
`opencode-go/deepseek-v4.1-flash`, chosen for cost and its $100/month Go allowance) and `REVIEWER_VARIANT` (default `max`). There is no
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

## Independent arbitration of review disputes (#35)

When a correction worker leaves the reviewed head unchanged and records an
authenticated disagreement, the execution is blocked with
`autonomous_review_disagreement`. Arbitration settles that specific dispute
without a human, within hard limits. The manual operator resolution
(`resume_correction_task`) remains the fallback for every case.

**Gates.** Binding arbitration runs only when `automation/config.json` has
`"arbitrationEnabled": true` (absent means off) and global automation is enabled.
Keep it off until the pilot below passes. Arbiter model settings: Actions variables
`ARBITER_MODEL` (default `opencode-go/kimi-k3.1-pro`) and `ARBITER_VARIANT` (default
`max`). They are independent from the coding worker and reviewer. The run fails if
the model doesn't advertise the variant; there is no silent downgrade.

**Flow.**
1. A dispute is arbitrable only under the same exact-head guards as operator
   recovery: unchanged reviewed head, green required CI, the disputed review still
   the latest trusted verdict, and an authenticated worker disagreement for exactly
   that review and head. It is fingerprinted by repository/PR/SHA/review/disagreement.
2. The dispatcher starts `Autonomous review arbitration`
   (`arbitrate <TASK> <REVIEW-ID> <SHA>`) at most twice per dispute (one retry for a
   failed run). After that it records an `arbitration_runs_exhausted` escalation.
3. The arbiter job re-verifies the live dispute, assembles evidence (disputed
   review, disagreement, task and project specs, base `AGENTS.md`, diff,
   discussion) and runs OpenCode with read-only tools (`reviewer/ARBITER.md`). It
   has no GitHub write token.
4. A model-free job re-validates the typed, dispute-bound verdict and publishes one
   `<!-- autonomous-arbitration:v1 -->` PR comment as the worker App.
5. The dispatcher accepts only an App-authored decision whose arbitration run
   succeeded on master. It appends an immutable record to the execution's
   `arbitrations` ledger and acts:
   - `UPHOLD_REVIEWER` / `COMPROMISE_FIX` with high confidence → one bounded
     correction (`reason: arbitration_resolution`) pinned to the decision comment.
     The worker re-verifies the comment and receives it in `blocking-review.json` as
     `arbitration`. If that worker disputes again, it is not re-arbitrated; a human
     decides.
   - `UPHOLD_WORKER` with high confidence and `high_impact_risk: none` → back to
     `review`. The reviewer performs one fresh independent review of the same SHA
     (`review <TASK> <SHA> after <REVIEW-ID>`). The bridge accepts it only because the
     ledger records that exact overturn. The override is never an approval: merging
     still requires a new trusted APPROVED review, green CI and every merge guard.
   - `ESCALATE_HUMAN`, any confidence below `high`, or an overturn where security,
     data loss, save corruption or integrity is at stake → stays blocked for the
     human. The decision comment explains why.

**Pilot (advisory, owner-run).** With `arbitrationEnabled` still off, dispatch
`Autonomous review arbitration` manually on `master`. Get the exact inputs with:

```sh
TASK_ID=MSS-101 GITHUB_TOKEN_READ=$(gh auth token) node tools/autonomy/arbiter.mjs request
```

The run records the verdict (artifact `arbitration-verdict`, plus latency and the
policy outcome in the job summary) and publishes nothing. A successful advisory run
counts as that dispute's arbitration run, so the dispute stays with the human after
the pilot. Historical disputes (MSS-100) no longer pass the live guards and must be
evaluated from their recorded evidence.

**Activation.** After the pilot, set `"arbitrationEnabled": true` in a reviewed
control change. Disable it the same way.
