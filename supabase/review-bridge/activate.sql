-- Apply manually ONLY after the workflow is merged to master and the
-- matching secret is installed in both Vault and Edge Function secrets.
-- INSERT only; existing rows are not replayed. Idempotent activation.
do $$
begin
  if not exists (
    select 1 from vault.secrets
    where name = 'review_bridge_webhook_secret'
  ) then
    raise exception 'Set review_bridge_webhook_secret in Vault before activation';
  end if;

  if to_regprocedure('review_bridge.dispatch_queue_insert()') is null then
    raise exception 'Run prepare.sql first';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.autonomous_review_queue'::regclass
      and tgname = 'review_bridge_insert_dispatch'
      and not tgisinternal
  ) then
    create trigger review_bridge_insert_dispatch
      after insert on public.autonomous_review_queue
      for each row
      when (NEW.status = 'queued')
      execute function review_bridge.dispatch_queue_insert();
  end if;
end;
$$;

-- Confirm the webhook was installed and is INSERT-only:
select tgname, pg_get_triggerdef(oid) as trigger_definition
from pg_trigger
where tgrelid = 'public.autonomous_review_queue'::regclass
  and tgname = 'review_bridge_insert_dispatch';
