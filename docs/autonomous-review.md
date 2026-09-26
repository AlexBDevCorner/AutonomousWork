# Autonomous PR review and guarded merge

This is the permanent Supabase-backed autonomous review workflow. ChatGPT performs
the code assessment; GitHub Actions performs the actual reviews and merges after
independently checking current repository state. The existing dispatcher handles
REQUEST_CHANGES and bounded corrections. The reconciler independently marks work
done after GitHub confirms that the PR has merged.

## Enrollment and operation

Global workflow switch: GitHub Actions variable `AUTONOMOUS_REVIEW_ENABLED=true`.
Project-level switch: `automation/config.json.projects[projectId].reviewEnabled`.
Both must be true before the workflow can act. MtgSoloSports is enabled first;
RepoManager and MandarinBotNet have reviewEnabled=false until deliberately
enabled. The same production code and credentials will serve them later.

A single hourly scheduled ChatGPT task named **Autonomous PR Reviewer**
reads reviewer/CHATGPT_REVIEW.md from master before each run, checks project
enrollment and records a genuine review for at most one eligible PR. An exact
head that already has a trusted APPROVED review gets a MERGE_CHECK event.
An exact head with a trusted CHANGES_REQUESTED review waits for the worker
to correct it. ChatGPT writes accurate structured verdicts into Supabase,
never makes up findings, and does not call GitHub's mutation API directly.

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
   Enable **only** the new Autonomous PR Reviewer scheduled task.
   Keep earlier direct-GitHub reviewer tasks disabled to avoid conflicts.

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

## Scheduled finding payload and terminal recovery

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
