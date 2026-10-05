-- Initial server-only application schema for a fresh Supabase database.

BEGIN;

CREATE TABLE public.musegod_buyback_batches (
  scope text NOT NULL,
  id text NOT NULL,
  updated_at bigint NOT NULL,
  payload jsonb NOT NULL
);

CREATE TABLE public.musegod_pending_launches (
  scope text NOT NULL,
  hash text NOT NULL,
  plan_id text NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  block_hash text,
  updated_at bigint NOT NULL
);

CREATE TABLE public.musegod_plans (
  scope text NOT NULL,
  id text NOT NULL,
  creator text NOT NULL,
  data text NOT NULL,
  prepared_at bigint NOT NULL,
  payload jsonb NOT NULL
);

CREATE TABLE public.musegod_quota (
  scope text NOT NULL,
  key text NOT NULL,
  count integer NOT NULL
);

CREATE TABLE public.musegod_snapshots (
  scope text NOT NULL,
  key text NOT NULL,
  at bigint NOT NULL,
  payload jsonb NOT NULL
);

CREATE TABLE public.musegod_tokens (
  scope text NOT NULL,
  address text NOT NULL,
  tx_hash text NOT NULL,
  created_at bigint NOT NULL,
  payload jsonb NOT NULL
);

ALTER TABLE public.musegod_buyback_batches ADD CONSTRAINT musegod_buyback_batches_check CHECK (((jsonb_typeof(payload) = 'object'::text) AND (payload ? 'id'::text) AND (jsonb_typeof((payload -> 'id'::text)) = 'string'::text) AND ((payload ->> 'id'::text) = id)));

ALTER TABLE public.musegod_buyback_batches ADD CONSTRAINT musegod_buyback_batches_id_check CHECK (((char_length(id) >= 1) AND (char_length(id) <= 200)));

ALTER TABLE public.musegod_buyback_batches ADD CONSTRAINT musegod_buyback_batches_pkey PRIMARY KEY (scope, id);

ALTER TABLE public.musegod_pending_launches ADD CONSTRAINT musegod_pending_launches_pkey PRIMARY KEY (scope, hash);

ALTER TABLE public.musegod_pending_launches ADD CONSTRAINT musegod_pending_launches_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'failed'::text, 'replaced'::text])));

ALTER TABLE public.musegod_plans ADD CONSTRAINT musegod_plans_pkey PRIMARY KEY (scope, id);

ALTER TABLE public.musegod_quota ADD CONSTRAINT musegod_quota_count_check CHECK ((count >= 0));

ALTER TABLE public.musegod_quota ADD CONSTRAINT musegod_quota_pkey PRIMARY KEY (scope, key);

ALTER TABLE public.musegod_snapshots ADD CONSTRAINT musegod_snapshots_pkey PRIMARY KEY (scope, key);

ALTER TABLE public.musegod_tokens ADD CONSTRAINT musegod_tokens_pkey PRIMARY KEY (scope, address);

ALTER TABLE public.musegod_tokens ADD CONSTRAINT musegod_tokens_scope_tx_hash_key UNIQUE (scope, tx_hash);

ALTER TABLE public.musegod_pending_launches ADD CONSTRAINT musegod_pending_launches_scope_plan_id_fkey FOREIGN KEY (scope, plan_id) REFERENCES public.musegod_plans(scope, id);

CREATE INDEX musegod_buyback_batches_updated ON public.musegod_buyback_batches USING btree (scope, updated_at DESC, id);

CREATE INDEX musegod_pending_plan ON public.musegod_pending_launches USING btree (scope, plan_id);

CREATE INDEX musegod_pending_queue ON public.musegod_pending_launches USING btree (scope, updated_at);

CREATE INDEX musegod_plans_lookup ON public.musegod_plans USING btree (scope, creator, md5(data));

CREATE INDEX musegod_snapshots_expiry ON public.musegod_snapshots USING btree (scope, at);

CREATE INDEX musegod_tokens_created ON public.musegod_tokens USING btree (scope, created_at DESC);

ALTER TABLE public.musegod_buyback_batches ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.musegod_buyback_batches FROM PUBLIC,anon,authenticated,service_role;

GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.musegod_buyback_batches TO service_role;

ALTER TABLE public.musegod_pending_launches ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.musegod_pending_launches FROM PUBLIC,anon,authenticated,service_role;

GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.musegod_pending_launches TO service_role;

ALTER TABLE public.musegod_plans ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.musegod_plans FROM PUBLIC,anon,authenticated,service_role;

GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.musegod_plans TO service_role;

ALTER TABLE public.musegod_quota ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.musegod_quota FROM PUBLIC,anon,authenticated,service_role;

GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.musegod_quota TO service_role;

ALTER TABLE public.musegod_snapshots ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.musegod_snapshots FROM PUBLIC,anon,authenticated,service_role;

GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.musegod_snapshots TO service_role;

ALTER TABLE public.musegod_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.musegod_tokens FROM PUBLIC,anon,authenticated,service_role;

GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.musegod_tokens TO service_role;

CREATE OR REPLACE FUNCTION public.musegod_backup(p_scope text)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
 select jsonb_build_object('version',2,'scope',p_scope,
 'plans',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_plans t where scope=p_scope),
 'tokens',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_tokens t where scope=p_scope),
 'snapshots',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_snapshots t where scope=p_scope),
 'quota',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_quota t where scope=p_scope),
 'pending_launches',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_pending_launches t where scope=p_scope),
 'buyback_batches',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_buyback_batches t where scope=p_scope));
$function$;

REVOKE ALL ON FUNCTION public.musegod_backup(p_scope text) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.musegod_backup(p_scope text) TO service_role;

CREATE OR REPLACE FUNCTION public.musegod_cleanup(p_scope text, p_now bigint)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  delete from public.musegod_snapshots where scope=p_scope and at<p_now-86400000;
  delete from public.musegod_quota where scope=p_scope and key<to_char(to_timestamp((p_now-8640000000)/1000.0) at time zone 'UTC','YYYY-MM');
  delete from public.musegod_pending_launches where scope=p_scope and status='failed' and updated_at<p_now-2592000000;
  delete from public.musegod_plans p where scope=p_scope and prepared_at<p_now-2592000000 and not exists(select 1 from public.musegod_pending_launches q where q.scope=p.scope and q.plan_id=p.id);
end $function$;

REVOKE ALL ON FUNCTION public.musegod_cleanup(p_scope text, p_now bigint) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.musegod_cleanup(p_scope text, p_now bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.musegod_find_plan(p_scope text, p_creator text, p_data text)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select payload from public.musegod_plans where scope=p_scope and creator=p_creator and md5(data)=md5(p_data) and data=p_data limit 1;
$function$;

REVOKE ALL ON FUNCTION public.musegod_find_plan(p_scope text, p_creator text, p_data text) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.musegod_find_plan(p_scope text, p_creator text, p_data text) TO service_role;

CREATE OR REPLACE FUNCTION public.musegod_mark_launch(p_scope text, p_hash text, p_status text, p_block_hash text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  update public.musegod_pending_launches set status=p_status,block_hash=p_block_hash,updated_at=(extract(epoch from clock_timestamp())*1000)::bigint where scope=p_scope and hash=p_hash;
  if p_status='confirmed' then
    update public.musegod_pending_launches set status='replaced',updated_at=(extract(epoch from clock_timestamp())*1000)::bigint
    where scope=p_scope and hash<>p_hash and plan_id=(select plan_id from public.musegod_pending_launches where scope=p_scope and hash=p_hash);
  end if;
end $function$;

REVOKE ALL ON FUNCTION public.musegod_mark_launch(p_scope text, p_hash text, p_status text, p_block_hash text) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.musegod_mark_launch(p_scope text, p_hash text, p_status text, p_block_hash text) TO service_role;

CREATE OR REPLACE FUNCTION public.musegod_reserve_market_call(p_scope text, p_now bigint, p_daily integer DEFAULT 300, p_monthly integer DEFAULT 9000)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare d text := to_char(to_timestamp(p_now/1000.0) at time zone 'UTC','YYYY-MM-DD'); m text := left(d,7);
begin
  if p_daily not between 0 and 300 or p_monthly not between 0 and 9000 then raise exception 'Invalid market budget'; end if;
  perform pg_advisory_xact_lock(hashtextextended('musegod_market:' || p_scope,0));
  if coalesce((select count from public.musegod_quota where scope=p_scope and key=d),0)>=p_daily or coalesce((select count from public.musegod_quota where scope=p_scope and key=m),0)>=p_monthly then return false; end if;
  insert into public.musegod_quota values(p_scope,d,1),(p_scope,m,1) on conflict(scope,key) do update set count=musegod_quota.count+1;
  return true;
end $function$;

REVOKE ALL ON FUNCTION public.musegod_reserve_market_call(p_scope text, p_now bigint, p_daily integer, p_monthly integer) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.musegod_reserve_market_call(p_scope text, p_now bigint, p_daily integer, p_monthly integer) TO service_role;

CREATE OR REPLACE FUNCTION public.musegod_restore(p_scope text, p_backup jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  perform pg_advisory_xact_lock(hashtextextended('musegod_market:' || p_scope,0));
  if jsonb_typeof(p_backup) is distinct from 'object' or
    coalesce(p_backup->>'version','') not in ('1','2') then
    raise exception 'Unsupported backup';
  end if;
  if exists(select 1 from public.musegod_plans where scope=p_scope) or
    exists(select 1 from public.musegod_tokens where scope=p_scope) or
    exists(select 1 from public.musegod_snapshots where scope=p_scope) or
    exists(select 1 from public.musegod_quota where scope=p_scope) or
    exists(select 1 from public.musegod_pending_launches where scope=p_scope) or
    exists(select 1 from public.musegod_buyback_batches where scope=p_scope) then
    raise exception 'Restore target is not empty';
  end if;
  insert into public.musegod_plans select p_scope,id,creator,data,prepared_at,payload
    from jsonb_populate_recordset(null::public.musegod_plans,coalesce(p_backup->'plans','[]'));
  insert into public.musegod_tokens select p_scope,address,tx_hash,created_at,payload
    from jsonb_populate_recordset(null::public.musegod_tokens,coalesce(p_backup->'tokens','[]'));
  insert into public.musegod_snapshots select p_scope,key,at,payload
    from jsonb_populate_recordset(null::public.musegod_snapshots,coalesce(p_backup->'snapshots','[]'));
  insert into public.musegod_quota select p_scope,key,count
    from jsonb_populate_recordset(null::public.musegod_quota,coalesce(p_backup->'quota','[]'));
  insert into public.musegod_pending_launches select p_scope,hash,plan_id,status,block_hash,updated_at
    from jsonb_populate_recordset(null::public.musegod_pending_launches,coalesce(p_backup->'pending_launches','[]'));
  insert into public.musegod_buyback_batches select p_scope,id,updated_at,payload
    from jsonb_populate_recordset(null::public.musegod_buyback_batches,coalesce(p_backup->'buyback_batches','[]'));
end $function$;

REVOKE ALL ON FUNCTION public.musegod_restore(p_scope text, p_backup jsonb) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.musegod_restore(p_scope text, p_backup jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
