-- Operator kill switch. Does not delete queue records or credentials.
drop trigger if exists review_bridge_insert_dispatch
  on public.autonomous_review_queue;
