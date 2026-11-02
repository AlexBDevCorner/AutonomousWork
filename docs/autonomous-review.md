# Autonomous PR review and guarded merge

This is the permanent Supabase-backed autonomous review workflow. An event-driven
OpenCode reviewer in GitHub Actions performs the code assessment; GitHub Actions performs the actual reviews and merges after
independently checking current repository state. The existing dispatcher handles
REQUEST_CHANGES and bounded corrections. The reconciler independently marks work
done after GitHub confirms that the PR has merged.

## Enrollment and operation

Global workflow switch: GitHub Actions variable `AUTONOMOUS_REVIEW_ENABLED=true`.
Project-level switch: `automation/config.json.projects[projectId].reviewEnabled`.
Both must be true before the workflow can act. MtgSoloSports is enabled first;
RepoManager and MandarinBotNet have reviewEnabled=false until deliberately
enabled. The same production code and credentials will serve them later.

The ChatGPT Scheduled Task reviewers are retired (owner decision, 2026-11-02) and
must stay disabled. Each 10-minute dispatcher tick lists review-enabled executions
in `review` whose non-draft PR has green required CI and no trusted exact-head
review, and dispatches **Autonomous OpenCode reviewer**
(`.github/workflows/autonomous-review.yml`, run name `review <TASK-ID> <SHA>`).
Each exact head gets at most three runs; a failed run (provider error, Go quota,
unparsable verdict) is retried on a later tick, then left visible as failed runs
and `reviewRuns: 3` in the dispatcher's `review-queue.json` artifact. Idle ticks
never call a model. An exact head that already has a trusted APPROVED review gets a
model-free `merge-check <TASK-ID> <SHA>` run that enqueues MERGE_CHECK. An exact
head with a trusted CHANGES_REQUESTED review waits for the worker to correct it.

The review job re-runs the bridge guards before any model call, checks out the PR
head as data only, strips PR-supplied OpenCode configuration/plugins and agent
instructions, confirms the configured model advertises the configured variant, and
runs OpenCode with read/grep/glob/list tools only. Instructions and the verdict
contract are in `reviewer/OPENCODE_REVIEW.md`. A separate job without the model
key re-validates the verdict against live state and inserts one
`source=opencode-actions` queue row through the queue-scoped Edge API. Model
settings: Actions variables `REVIEWER_MODEL` (default
`opencode-go/gemini-4-argon`) and `REVIEWER_VARIANT` (default `high`).

The INSERT-only Supabase trigger calls review-bridge-dispatch using the
existing Vault webhook secret; only the queue UUID leaves Supabase.
For real records this dispatches the `autonomous_review_inserted` GitHub
event. The trusted master-only `Autonomous PR Review Bridge` Actions job
reads the row through the queue-scoped Edge API, atomically leases it using
private SQL RPCs, and re-reads master config, state, task, protocol, target
AGENTS.md, open PRs, exact-head CI and raw reviews. It checks the task and
repository mapping, that this project has reviewEnabled=true, the PR's
base/head/author/draft/mergeability and any control spec pin.

The workflow submits one explicit commit_id-bound GitHub review using the
dedicated personal reviewer credential, then independently verifies the raw
GitHub review. For APPROVE or MERGE_CHECK, it re-runs the entire set of merge
guards and uses a separately scoped worker GitHub App token to merge with
GitHub's expected head SHA. Withheld, stale, retryable or uncertain states
never bypass a guard or guess that a GitHub mutation succeeded. Terminal
queue deliveries are idempotent and the database lease is fenced.

Test-only queue rows dispatch a separate read-only diagnostic job. It cannot
perform GitHub review or merge writes. Historical experiment migrations and
fixture tests remain as audit records, but do not participate in the
permanent live process.

## One-time credentials and activation

1. Create a fine-grained token owned by `AlexBDevCorner` named
   `autonomous-reviewer`, with selected target repositories:
   `MtgSoloSports`, `RepoManager`, and `MandarinBotNet`.
   Grant **Pull requests: Read and write**. It must belong to the trusted
   reviewer account, distinct from the GitHub worker App that authors PRs.
   Set an expiration you'll remember to renew.
2. Store it as the single permanent AutonomousWork GitHub Actions
   repository secret `AUTONOMOUS_REVIEWER_TOKEN`. The old Step 4 fixture
   secret, old MSS-specific secret, and old reviewer scheduled tasks are
   not used by the new workflow. Do not paste credential values into
   GitHub commits, SQL, documentation or chat.
3. Ensure the existing worker GitHub App installation is authorized for
   the control repository and the three target repositories, and grants
   Contents: write and Pull requests: write on the targets. Preserve
   `AUTONOMOUS_APP_CLIENT_ID` and `AUTONOMOUS_APP_PRIVATE_KEY`.
4. Deploy after merging this code: apply the
   `20260926083000_review_bridge_live_queue.sql` migration once and
   deploy both updated Edge Functions (`review-bridge-queue` and
   `review-bridge-dispatch`). Keep existing Supabase Vault and Edge secrets
   and GitHub `REVIEW_BRIDGE_QUEUE_TOKEN`; never expose the privileged
   Supabase database key outside the Edge Function.
5. Set the Actions repository variable `AUTONOMOUS_REVIEW_ENABLED=true`
   only after the secret is installed and deployment succeeds.
   Keep all ChatGPT reviewer Scheduled Tasks disabled.

### OpenCode reviewer rollout (#37)

1. Store a dedicated OpenCode Go API key as the AutonomousWork Actions secret
   `OPENCODE_API_KEY` (the MtgSoloSports secret is not visible here).
2. Apply `20261102120000_review_bridge_opencode_reviewer.sql` and redeploy both
   Edge Functions (`review-bridge-queue` adds the `enqueue` action;
   `review-bridge-dispatch` accepts the new source).
3. Merge the code. The next dispatcher tick dispatches reviews for eligible heads.
   Emergency stop is unchanged: `AUTONOMOUS_REVIEW_ENABLED=false` or per-project
   `reviewEnabled: false`. A `WITHHOLD` verdict is an escalation: the PR waits for
   manual review, which remains the fallback.

This is the actual implementation: the first processed PR can be an
ordinary MtgSoloSports task PR. No disposable fixtures or separate
pilot credentials are required.

## Recovery and observation

Manually recover an existing queued/retryable record from AutonomousWork
Actions > Autonomous PR Review Bridge > Run workflow on `master`,
`queue_id` = existing record UUID, `mode=live`. Inspect any earlier
ambiguous GitHub write first; the processor separately checks raw
reviews and existing merges before retrying.

SQL for read-only progress inspection:

```sql
select id, repository, task_id, pr_number, reviewed_sha, verdict,
       status, attempts, github_review_id, merge_sha, last_error,
       validation_result, processed_at
from public.autonomous_review_queue
where test_only = false
order by created_at desc
limit 20;
```

Emergency stop: set `AUTONOMOUS_REVIEW_ENABLED=false`. You may disable
individual projects by changing their reviewEnabled values in the control
repo. Stopping new actions does not roll back an already accepted review
or merge; the dispatcher and reconciler are separate processes.

## Finding payload and terminal recovery

A real `REQUEST_CHANGES` verdict must have at least one actual P0/P1 finding.
Use `{ "severity": "P1", "path": "...", "line": 42,
"description": "Concrete trigger and consequence" }` when a line is available.
Otherwise, use `location` to identify the affected function or code path.
The bridge also accepts `message`, `summary`, or `explanation` as a
non-empty text alias, including the `location` + `explanation` format that
surfaced in MSS-008. The guard validator and GitHub review renderer use the
same normalization to avoid dropping legitimate blocking findings.

A queue record marked `withheld` is terminal and cannot be claimed directly.
Before recovering one, confirm its exact PR head is still current, its original
review observation is fresh, and GitHub has no completed trusted review on that
head. An operator can explicitly reset **that same row** to `retryable` with an
audited, tightly scoped database update, then manually run the existing
`Autonomous PR Review Bridge` workflow on `master` with its queue UUID and
`mode=live`. Do not insert a second verdict for the same head or silently
rewrite the finding or `observed_at`; the unique live-verdict index protects
against duplicate decisions. If the observation has expired, get a fresh
independent review instead of changing its timestamp.

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

Deployment: apply `20261102130000_review_bridge_arbitration_rereview.sql` and redeploy
`review-bridge-queue`. A same-SHA re-review supersedes the overturned review in the
queue's one-verdict-per-head key.
