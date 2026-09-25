# Step 3: deterministic reviewer guard / queue-scoped API

**Rollout status:** staged, **mandatory dry run**. The previously successful
Step 2 handler stays active until the operator explicitly sets
REVIEW_BRIDGE_STEP3_ENABLED=true. This step never posts reviews, merges PRs,
starts workers, edits planning state, or uses untrusted PR-head code.

## Architecture and security boundary

1. The existing INSERT-only trigger and authenticated
   review-bridge-dispatch Edge Function continue to send **only a UUID** in
   a repository_dispatch event. Step 2 remains a working rollback path.
2. The Step 3 GitHub Action checks out **AutonomousWork master only** and
   obtains an **App installation token with read-only contents, PR and
   checks permissions** for the four known repositories.
3. GitHub calls review-bridge-queue through a separate, random
   REVIEW_BRIDGE_QUEUE_TOKEN. That token is **queue-scoped at the HTTP
   API**, not a Supabase API key, and does not grant arbitrary database
   access. Only the Edge Function holds REVIEW_BRIDGE_DB_KEY, a privileged
   named sb_secret_ key. It has exact-ID test-only GET, claim and finish
   operations; it never returns non-test records or writes GitHub.
4. Postgres functions atomically claim queued/retryable/expired
   **test_only=true** rows. Each claim generates a fresh UUID lease token,
   15-minute expiry and increments an attempt counter (max 4). Finishing
   requires a matching *unexpired* claim token and a processing record.
   Expired jobs cannot acknowledge another worker's claim. No public or
   authenticated grants/policies are introduced. Security-definer
   operations live in the non-exposed review_bridge schema; exposed public
   wrappers are security-invoker and granted only to service_role.
5. The processor re-reads current master config, state, project.yaml,
   task specification and reviewer protocol, all pinned to **one control
   commit**. It independently reads the exact target PR, open autonomous
   PR list, required GitHub Actions check-runs, raw REST reviews with
   commit_id and AGENTS.md at the target base. It checks enrollment,
   enablement, recorded task/PR/repo, worker_failure exception, same-repo
   autonomous branch, base, draft/mergeability, contradictory labels,
   optional specification pin and same-head duplicate reviews. It
   rechecks control master and the PR head; potentially eligible
   results also get fresh CI/review/PR observations.
6. A successful guard result is recorded as **dry_run only**. Other
   terminal results are stale/withheld/failed, and an unavailable
   dependency becomes retryable. validation_result stores bounded
   machine-readable evidence; last_error stores a short reason code.
   MERGE_CHECK is a separate dry-run check requiring the latest completed
   trusted exact-head review to be APPROVED and required CI green.
   Nothing can grant approval based only on a Supabase verdict.

**Important:** this queue-scoped token can still read and update *test
queue records*, so keep it in trusted default-branch workflows only. The
Edge Function's underlying database key **still bypasses RLS**. It must
stay server-side; a named Supabase key alone is *not* table-scoped.

## Existing database

The migration 20260925160013_review_bridge_test_lease_fencing.sql was
already applied to Supabase project ayewunekctfmdxgjtqfl and is committed
verbatim. Do not replay it. It adds claim_token and validation_result to
the existing queue plus private test-only RPC handlers. The existing
INSERT trigger and Step 2 Edge Function were left unchanged.

## Operator setup and controlled cutover

**Do this only after the Step 3 PR has passed CI and been merged.** Never
put secret values in Git, a task spec, or this chat.

1. In Supabase, copy the existing **named** sb_secret_ key originally
   created for SUPABASE_REVIEW_BRIDGE_KEY (or mint a fresh named key). Save
   it in **Edge Function Secrets** as REVIEW_BRIDGE_DB_KEY. Do NOT copy a
   Supabase key into any new GitHub secret.
2. Generate a **different** 32-byte or longer random value using PowerShell:

   ```powershell
   [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
   ```

   Save the **same value** in Supabase Edge Function Secrets as
   REVIEW_BRIDGE_QUEUE_TOKEN and in AutonomousWork GitHub Actions
   repository **Secrets** as REVIEW_BRIDGE_QUEUE_TOKEN. This is
   deliberately different from REVIEW_BRIDGE_WEBHOOK_SECRET.
3. Verify that the deployed review-bridge-queue Edge Function has
   verify_jwt=false and independent shared-token verification (requests
   without the token must get 401 after all required secrets exist).
   The older review-bridge-dispatch stays deployed and unchanged.
4. In AutonomousWork -> Settings -> Secrets and variables -> Actions ->
   **Variables**, add REVIEW_BRIDGE_STEP3_ENABLED with value true.
   This selects the new dry-run job. Until set, the Step 2 handler keeps
   working. Ensure AUTONOMOUS_APP_CLIENT_ID and
   AUTONOMOUS_APP_PRIVATE_KEY already used by dispatch.yml still exist.
5. Submit a new **synthetic** test_only=true WITHHOLD fixture for the
   current live eligible task/PR/HEAD, clearly marked *not a code
   review*. The same INSERT trigger should start a repository_dispatch
   GitHub run. Expect an acknowledged status of withheld (the explicit
   reviewer verdict) or a more conservative stale/withheld validation
   reason if live controls/PR facts have changed. The Action should be
   successful and validation_result should contain the actual guard
   evidence where applicable. An invalid project/branch should withhold,
   never dry-run approve. Do not enqueue fabricated non-test reviews.
6. Start workflow_dispatch with that **same UUID** a second time. A
   terminal record must be a no-op; its attempts and processed_at must
   not change. For retryable records, a manual recovery run may claim
   again within the four-attempt ceiling. Confirm the Action has no
   pull-request or contents **write** token permission.
7. Once verified, **DELETE** the former GitHub Actions
   SUPABASE_REVIEW_BRIDGE_KEY privileged secret. Keep the named secret
   value only in Supabase Edge Function Secrets; consider rotating it
   after the temporary GitHub copy has been removed. Do not enable
   non-test processing as part of this step.

## Verification queries (read-only)

Inspect queue processing without exposing keys:

```sql
select id, test_only, status, attempts, claimed_at, lease_until,
       processed_at, last_error, validation_result,
       github_review_id, merge_sha
from public.autonomous_review_queue
order by created_at desc limit 5;
```

Verify RPC privileges without changing RLS:

```sql
select routine_schema, routine_name
from information_schema.routines
where routine_name in (
  'review_bridge_claim_test_queue',
  'review_bridge_finish_test_queue'
);
```

CI must run node --test tools/review-bridge/*.test.mjs, including
missing credentials, repeated deliveries, token fencing, disabled
controls, false task/repo mapping, bad branches, old heads, pending
and failed CI, duplicate exact-head reviews, pinned spec changes and
the narrow worker_failure exception.

## Kill switch / failures

- Set REVIEW_BRIDGE_STEP3_ENABLED=false or remove the variable to fall
  back to **Step 2** while the old privileged key remains installed.
  After removing that old GitHub key, disabling Step 3 will intentionally
  stop the Step 2 acknowledgement until you explicitly restore it.
- The INSERT webhook can be stopped separately with
  supabase/review-bridge/deactivate.sql. This does not delete rows.
- 401: mismatch/missing scoped queue token; 503: missing Edge secrets.
  502: Supabase backend failure (no secret-bearing error body).
  409: an invalid, stale or stolen lease cannot acknowledge; inspect
  status/attempts before manual recovery.
- No periodic recovery is enabled. An uncertain network failure leaves
  the record retryable or processing until lease expiry; never infer that
  a downstream mutation happened. Four claim attempts is a hard cap.

Steps 4 and 5 must independently enforce current review/merge guards
and use separate trusted reviewer/merge identities. Do not reuse a
Step 3 dry_run result as approval authorization.
