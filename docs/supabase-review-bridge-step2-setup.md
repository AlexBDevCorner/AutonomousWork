# Step 2: delivery-only bridge activation

This is **not** a PR reviewer. It only delivers a queue UUID from an
INSERT-only PostgreSQL trigger to a secured Supabase Edge Function, sends
`repository_dispatch` to AutonomousWork, and conditionally acknowledges
the same test row as `dry_run`. There is no GitHub review/merge code or
permission. Both the Edge Function and the workflow reject
`test_only=false` until a separate rollout decision.

## Prerequisites (operator; do not put credential values in chat or Git)

1. Merge the delivery PR to **master**. GitHub requires
   `.github/workflows/review-bridge.yml` on the default branch to accept
   `repository_dispatch`.
2. In GitHub, create repository **Actions secret**
   `SUPABASE_REVIEW_BRIDGE_KEY`, using a **separately named** Supabase
   secret API key for the project `ayewunekctfmdxgjtqfl`. Treat it as a
   *privileged* key: named Supabase secret keys bypass RLS and cannot
   themselves be scoped to this one table. Step 3 must replace this
   temporary access with a genuinely restricted queue-specific access
   method before any non-test processing.
3. Create a fine-grained GitHub token restricted to
   **AlexBDevCorner/AutonomousWork** with **Contents: Read and write**
   (required for repository dispatch), and place it in the Supabase
   project's **Edge Function secret** `GITHUB_DISPATCH_TOKEN`. This token
   must not grant access to the worker repositories.
4. Generate a fresh random secret of at least 32 bytes. Store it under
   `REVIEW_BRIDGE_WEBHOOK_SECRET` in **Supabase Edge Function secrets**
   and as the identical value in **Database > Vault**, named
   `review_bridge_webhook_secret`. Use the Dashboard Vault UI; never put
   a literal credential in SQL migration files, SQL-editor history or Git.
   Do not reuse the GitHub or Supabase API keys as this webhook secret.
5. Verify the deployed `review-bridge-dispatch` Edge Function has
   **JWT verification disabled**. It implements independent constant-time
   shared-secret verification, exact event-shape checks and the test-only
   gate. The webhook sends `x-review-bridge-secret`, not a bearer JWT.

## Database setup

The project initially had Vault installed but **pg_net not enabled**.
`supabase/migrations/20260925153501_review_bridge_delivery_preparation.sql` enables pg_net and creates a
non-public, security-definer trigger function. It was applied to the existing project as migration `20260925153501` and is
now tracked verbatim alongside the two earlier existing migrations.
Do **not** replay migrations that are already recorded in this project.
For fresh environments, apply them in normal version order. Unlike
the existing queue table migration, it does not recreate the queue.

The trigger intentionally stays **inactive** until all credentials and
the default-branch workflow are ready. Then execute
`supabase/review-bridge/activate.sql` in the SQL editor. This checks
the Vault entry and creates an INSERT-only trigger. Re-running it is
idempotent. `deactivate.sql` is an immediate operator kill switch.

## End-to-end fixture

Insert a single synthetic **WITHHOLD**, `test_only=true` queue record
through the Supabase connector (the same write path scheduled reviewers
will use). Use real-looking metadata (e.g., task ID, PR number and
40-hex SHA) but explicitly label the summary **synthetic connectivity
fixture, not an actual code review**. Existing table constraints and
unique indexes apply. Do not test with `APPROVE` or use a genuine review
as a fixture.

Expected evidence:

- One new `public.autonomous_review_queue` record with its UUID.
- One HTTP 202 response from the Edge Function in `net._http_response`
  (it retains responses only temporarily); Edge logs show the same UUID.
- A new `Supabase review delivery (dry run)` GitHub Actions run on
  **master**, triggered by `autonomous_review_inserted`.
- The workflow GETs **exactly that UUID** through the Supabase REST
  Data API. It verifies the row again and conditionally PATCHes only
  `status=queued AND test_only=true AND id=<UUID>` to `dry_run`.
- Read the same UUID back through the Supabase connector: status
  `dry_run`, `processed_at` populated, no `github_review_id` or
  `merge_sha`. Existing reviewers remain paused.

To check recent webhook errors (pg_net responses expire):
```sql
select id, status_code, error_msg, created
from net._http_response
where status_code >= 400 or error_msg is not null
order by created desc
limit 20;
```
Edge Function logs also record dispatch failures without echoing tokens.
A 503 indicates missing Edge secrets, 401 a mismatched webhook secret,
422 a rejected event shape, and 502 a GitHub dispatch problem.

**Recovery:** If an INSERT webhook fails, keep the queued record and
manually start the workflow on master via Actions > Supabase review
delivery (dry run) > Run workflow with that UUID. No automatic replay
or worker dispatch is introduced here. A successful duplicate event
is a no-op once the row is `dry_run`.

**Rollback:** Run `deactivate.sql` to remove the trigger. The already
deployed function and workflow are inert without new events. Revoke/
rotate the three secrets if a credential is exposed.

**Out of scope:** production reviews, exact-head CI checks, guarded
leases/claims, merge, correction dispatch and scheduled cutover are
later plan iterations.
