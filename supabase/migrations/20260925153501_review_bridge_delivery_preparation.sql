-- Step 2: prepare the INSERT-only webhook. This script does NOT enable
-- delivery. Activate separately, after the default-branch GitHub workflow
-- and all three secrets exist.
create extension if not exists pg_net with schema extensions;

create schema if not exists review_bridge;
revoke all on schema review_bridge from public, anon, authenticated;

create or replace function review_bridge.dispatch_queue_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  hook_secret text;
  request_id bigint;
begin
  -- Vault decryption happens only at call time. No credentials are embedded
  -- in trigger arguments, definitions, migrations or request bodies.
  select decrypted_secret into hook_secret
  from vault.decrypted_secrets
  where name = 'review_bridge_webhook_secret'
  limit 1;

  if hook_secret is null or length(hook_secret) < 32 then
    raise exception 'Review bridge webhook secret absent or too short';
  end if;

  select net.http_post(
    url := 'https://ayewunekctfmdxgjtqfl.supabase.co/functions/v1/review-bridge-dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-review-bridge-secret', hook_secret
    ),
    body := jsonb_build_object(
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'record', to_jsonb(NEW),
      'old_record', null
    ),
    timeout_milliseconds := 5000
  ) into request_id;

  return NEW;
end;
$$;

revoke all on function review_bridge.dispatch_queue_insert() from public, anon, authenticated;
comment on function review_bridge.dispatch_queue_insert() is
  'Step 2 delivery-only; enabled by separate activation after credentials and master workflow are ready';
