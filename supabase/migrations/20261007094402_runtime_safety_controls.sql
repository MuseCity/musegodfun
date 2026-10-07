BEGIN;

CREATE TABLE public.musegod_runtime_controls (
  scope text PRIMARY KEY,
  paused boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 0 CHECK(revision >= 0),
  updated_at bigint NOT NULL DEFAULT 0,
  reason text NOT NULL DEFAULT 'Awaiting runtime activation' CHECK(length(reason) BETWEEN 1 AND 240)
);
CREATE TABLE public.musegod_runtime_budget (
  name text NOT NULL CHECK(name IN ('lifi','pinata','prepare')),
  bucket bigint NOT NULL,
  count integer NOT NULL CHECK(count > 0),
  PRIMARY KEY(name,bucket)
);
CREATE TABLE public.musegod_runtime_circuit (
  name text PRIMARY KEY CHECK(name IN ('lifi','pinata','prepare')),
  until_at bigint NOT NULL
);
CREATE TABLE public.musegod_prepare_slots (
  owner uuid PRIMARY KEY,
  expires_at bigint NOT NULL
);
ALTER TABLE public.musegod_prepare_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.musegod_runtime_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.musegod_runtime_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.musegod_runtime_circuit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.musegod_runtime_controls, public.musegod_runtime_budget, public.musegod_runtime_circuit, public.musegod_prepare_slots FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.musegod_runtime_controls, public.musegod_runtime_budget, public.musegod_runtime_circuit, public.musegod_prepare_slots TO service_role;
INSERT INTO public.musegod_runtime_controls(scope) VALUES('base'),('robinhood');

ALTER TABLE public.musegod_plans ADD COLUMN protected_at bigint;
ALTER TABLE public.musegod_pending_launches ADD COLUMN retry_at bigint NOT NULL DEFAULT 0,
 ADD COLUMN attempts integer NOT NULL DEFAULT 0, ADD COLUMN finalized boolean NOT NULL DEFAULT false;
CREATE INDEX musegod_tokens_page ON public.musegod_tokens(scope,created_at DESC,address);
CREATE INDEX musegod_pending_active_queue ON public.musegod_pending_launches(scope,retry_at,updated_at) WHERE NOT finalized AND status NOT IN ('failed','replaced');

CREATE FUNCTION public.musegod_update_runtime_control(p_scope text,p_paused boolean,p_reason text,p_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE r public.musegod_runtime_controls;
BEGIN
 IF p_scope !~ '^(base|robinhood|verify-[a-z0-9-]+|restore-[a-z0-9-]+)$' OR p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 1 AND 240 OR p_revision<0 THEN RAISE EXCEPTION 'Invalid runtime control update'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('musegod_control:'||p_scope,0));
 INSERT INTO public.musegod_runtime_controls(scope) VALUES(p_scope) ON CONFLICT DO NOTHING;
 UPDATE public.musegod_runtime_controls SET paused=p_paused,revision=revision+1,updated_at=(extract(epoch from clock_timestamp())*1000)::bigint,reason=p_reason WHERE scope=p_scope AND revision=p_revision RETURNING * INTO r;
 IF NOT FOUND THEN RAISE EXCEPTION 'Runtime control revision changed; read it again'; END IF;
 RETURN jsonb_build_object('paused',r.paused,'revision',r.revision,'updatedAt',r.updated_at,'reason',r.reason);
END $$;

CREATE FUNCTION public.musegod_reserve_runtime_budget(p_name text,p_now bigint,p_recovery boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE durations bigint[]; limits integer[]; reserve numeric; used bigint; until_at bigint; i integer;
BEGIN
 IF p_name='lifi' THEN durations:=ARRAY[60000,7200000]; limits:=ARRAY[80,9600]; reserve:=0.2;
 ELSIF p_name='pinata' THEN durations:=ARRAY[86400000]; limits:=ARRAY[100]; reserve:=0;
 ELSIF p_name='prepare' THEN durations:=ARRAY[60000,86400000]; limits:=ARRAY[40,2000]; reserve:=0.2;
 ELSE RAISE EXCEPTION 'Invalid runtime budget'; END IF;
 IF p_now<0 THEN RAISE EXCEPTION 'Invalid budget time'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('musegod_budget:'||p_name,0));
 SELECT c.until_at INTO until_at FROM public.musegod_runtime_circuit c WHERE name=p_name;
 IF until_at>p_now THEN RETURN jsonb_build_object('allowed',false,'retryAfter',ceil((until_at-p_now)/1000.0)); END IF;
 DELETE FROM public.musegod_runtime_budget WHERE name=p_name AND bucket<p_now-durations[array_length(durations,1)]-1000;
 FOR i IN 1..array_length(durations,1) LOOP
  SELECT coalesce(sum(count),0) INTO used FROM public.musegod_runtime_budget WHERE name=p_name AND bucket>=floor((p_now-durations[i])/1000.0)*1000;
  IF used>=floor(limits[i]*(CASE WHEN p_recovery THEN 1 ELSE 1-reserve END)) THEN RETURN jsonb_build_object('allowed',false,'retryAfter',ceil(durations[i]/1000.0)); END IF;
 END LOOP;
 INSERT INTO public.musegod_runtime_budget VALUES(p_name,floor(p_now/1000.0)*1000,1) ON CONFLICT(name,bucket) DO UPDATE SET count=public.musegod_runtime_budget.count+1;
 RETURN jsonb_build_object('allowed',true,'retryAfter',0);
END $$;

CREATE FUNCTION public.musegod_block_runtime_budget(p_name text,p_until bigint)
RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
 INSERT INTO public.musegod_runtime_circuit VALUES(p_name,p_until) ON CONFLICT(name) DO UPDATE SET until_at=greatest(public.musegod_runtime_circuit.until_at,excluded.until_at);
$$;
CREATE FUNCTION public.musegod_reserve_prepare_slot(p_owner uuid,p_now bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF p_now<0 THEN RAISE EXCEPTION 'Invalid preview lease'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('musegod_prepare_slots',0));
 DELETE FROM public.musegod_prepare_slots WHERE expires_at<=p_now;
 IF NOT EXISTS(SELECT 1 FROM public.musegod_prepare_slots WHERE owner=p_owner) AND (SELECT count(*) FROM public.musegod_prepare_slots)>=4 THEN RETURN false; END IF;
 INSERT INTO public.musegod_prepare_slots VALUES(p_owner,p_now+240000) ON CONFLICT(owner) DO UPDATE SET expires_at=excluded.expires_at;
 RETURN true;
END $$;

CREATE FUNCTION public.musegod_defer_launch(p_scope text,p_hash text,p_retry_at bigint)
RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
 UPDATE public.musegod_pending_launches SET retry_at=p_retry_at,attempts=attempts+1 WHERE scope=p_scope AND hash=p_hash;
$$;
CREATE OR REPLACE FUNCTION public.musegod_cleanup(p_scope text,p_now bigint)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 DELETE FROM public.musegod_snapshots WHERE scope=p_scope AND at<p_now-86400000 AND key NOT LIKE 'pinata:%' AND key NOT LIKE 'buyback:index:%';
 DELETE FROM public.musegod_quota WHERE scope=p_scope AND key<to_char(to_timestamp((p_now-8640000000)/1000.0) at time zone 'UTC','YYYY-MM');
 DELETE FROM public.musegod_pending_launches WHERE scope=p_scope AND status IN ('failed','replaced') AND updated_at<p_now-2592000000;
 DELETE FROM public.musegod_plans p WHERE scope=p_scope AND protected_at IS NULL AND prepared_at<p_now-2592000000 AND NOT EXISTS(SELECT 1 FROM public.musegod_pending_launches q WHERE q.scope=p.scope AND q.plan_id=p.id);
END $$;
REVOKE ALL ON FUNCTION public.musegod_update_runtime_control(text,boolean,text,bigint),public.musegod_reserve_runtime_budget(text,bigint,boolean),public.musegod_block_runtime_budget(text,bigint),public.musegod_defer_launch(text,text,bigint),public.musegod_reserve_prepare_slot(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.musegod_update_runtime_control(text,boolean,text,bigint),public.musegod_reserve_runtime_budget(text,bigint,boolean),public.musegod_block_runtime_budget(text,bigint),public.musegod_defer_launch(text,text,bigint),public.musegod_reserve_prepare_slot(uuid,bigint) TO service_role;
CREATE OR REPLACE FUNCTION public.musegod_restore(p_scope text, p_backup jsonb)
 RETURNS void
 LANGUAGE plpgsql SECURITY INVOKER
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
  insert into public.musegod_plans select p_scope,id,creator,data,prepared_at,payload,protected_at
    from jsonb_populate_recordset(null::public.musegod_plans,coalesce(p_backup->'plans','[]'));
  insert into public.musegod_tokens select p_scope,address,tx_hash,created_at,payload
    from jsonb_populate_recordset(null::public.musegod_tokens,coalesce(p_backup->'tokens','[]'));
  insert into public.musegod_snapshots select p_scope,key,at,payload
    from jsonb_populate_recordset(null::public.musegod_snapshots,coalesce(p_backup->'snapshots','[]'));
  insert into public.musegod_quota select p_scope,key,count
    from jsonb_populate_recordset(null::public.musegod_quota,coalesce(p_backup->'quota','[]'));
  insert into public.musegod_pending_launches select p_scope,hash,plan_id,status,block_hash,updated_at,coalesce(retry_at,0),coalesce(attempts,0),coalesce(finalized,false)
    from jsonb_populate_recordset(null::public.musegod_pending_launches,coalesce(p_backup->'pending_launches','[]'));
  insert into public.musegod_buyback_batches select p_scope,id,updated_at,payload
    from jsonb_populate_recordset(null::public.musegod_buyback_batches,coalesce(p_backup->'buyback_batches','[]'));
end $function$;

NOTIFY pgrst, 'reload schema';
COMMIT;
