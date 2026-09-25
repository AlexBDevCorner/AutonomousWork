CREATE TABLE public.connector_test (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.connector_test ENABLE ROW LEVEL SECURITY;