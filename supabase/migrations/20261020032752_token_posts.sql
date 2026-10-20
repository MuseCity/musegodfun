BEGIN;
-- Posts and bearer credentials are server-only. The public HTTP API never returns credential hashes.
CREATE TABLE public.musegod_post_api_keys (
 scope text NOT NULL,id text NOT NULL,token text NOT NULL,created_at bigint NOT NULL,payload jsonb NOT NULL,
 PRIMARY KEY(scope,id),CHECK(payload->>'id'=id AND payload->>'token'=token));
CREATE INDEX musegod_post_api_keys_token ON public.musegod_post_api_keys(scope,token,created_at DESC,id DESC);
CREATE TABLE public.musegod_posts (
 scope text NOT NULL,id text NOT NULL,token text NOT NULL,created_at bigint NOT NULL,idempotency_key text NOT NULL,request_hash text NOT NULL,payload jsonb NOT NULL,
 PRIMARY KEY(scope,id),UNIQUE(scope,token,idempotency_key),CHECK(payload->>'id'=id AND payload->>'token'=token));
CREATE INDEX musegod_posts_page ON public.musegod_posts(scope,token,created_at DESC,id DESC);
CREATE TABLE public.musegod_post_media (
 scope text NOT NULL,token text NOT NULL,id text NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(scope,token,id),
 CHECK(payload->>'id'=id AND payload->>'token'=token));
CREATE TABLE public.musegod_post_rates (scope text NOT NULL,key text NOT NULL,count integer NOT NULL,expires_at bigint NOT NULL,PRIMARY KEY(scope,key));
ALTER TABLE public.musegod_post_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.musegod_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.musegod_post_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.musegod_post_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.musegod_post_api_keys,public.musegod_posts,public.musegod_post_media,public.musegod_post_rates FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.musegod_post_api_keys,public.musegod_posts,public.musegod_post_media,public.musegod_post_rates TO service_role;

CREATE FUNCTION public.musegod_post_action(p_scope text,p_command jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE action text:=p_command->>'action'; v_token text; now_ms bigint; key_row jsonb; post_row jsonb; media_row jsonb;
 key_id text:=p_command->>'keyId'; item_id text:=p_command->>'id'; previous_hash text; image_id text; image_urls jsonb:='[]';
 charges jsonb:='[]'; c jsonb; bucket bigint; maximum integer; used integer; rate_scope text; rate_key text; until_ms bigint;
 result jsonb; page_limit integer;
BEGIN
 IF p_scope IS NULL OR p_scope !~ '^(base|robinhood|verify-[a-z0-9-]+|restore-[a-z0-9-]+)$' OR jsonb_typeof(p_command) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid Posts command scope'; END IF;
 v_token:=lower(CASE WHEN action='keyCreate' THEN p_command->'row'->>'token' ELSE p_command->>'token' END);
 now_ms:=coalesce((p_command->>'now')::bigint,CASE WHEN action='keyCreate' THEN (p_command->'row'->>'createdAt')::bigint END,floor(extract(epoch from clock_timestamp())*1000)::bigint);
 IF v_token IS NULL OR v_token !~ '^0x[0-9a-f]{40}$' OR now_ms<=0 THEN RAISE EXCEPTION 'Invalid Posts token or time'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('musegod_posts:'||p_scope||':'||v_token,0));
 IF action='keysList' THEN
  RETURN jsonb_build_object('keys',coalesce((SELECT jsonb_agg(payload ORDER BY created_at DESC,id DESC) FROM public.musegod_post_api_keys WHERE scope=p_scope AND musegod_post_api_keys.token=v_token),'[]'));
 ELSIF action='keyGet' THEN
  SELECT payload INTO key_row FROM public.musegod_post_api_keys WHERE scope=p_scope AND musegod_post_api_keys.token=v_token AND id=item_id;
  RETURN CASE WHEN key_row IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('key',key_row) END;
 ELSIF action='keyCreate' THEN
  key_row:=p_command->'row';item_id:=key_row->>'id';
  IF key_row->>'token' IS DISTINCT FROM v_token OR coalesce(key_row->>'hash','') !~ '^[0-9a-f]{64}$' OR coalesce(key_row->>'issuer','') !~ '^0x[0-9a-fA-F]{40}$' OR
   key_row->'revokedAt' IS DISTINCT FROM 'null'::jsonb OR (key_row->>'expiresAt')::bigint<=now_ms OR (key_row->>'expiresAt')::bigint>now_ms+2592000000 OR
   coalesce(length(item_id),0) NOT BETWEEN 1 AND 100 OR coalesce(length(key_row->>'name'),81)>80 THEN RAISE EXCEPTION 'Invalid Posts key'; END IF;
  IF EXISTS(SELECT 1 FROM public.musegod_post_api_keys WHERE scope=p_scope AND id=item_id) THEN RETURN '{"error":{"code":"POST_KEY_EXISTS","message":"This key creation was already used. Revoke the key and create a new one.","status":409}}'; END IF;
  IF (SELECT count(*) FROM public.musegod_post_api_keys WHERE scope=p_scope AND musegod_post_api_keys.token=v_token AND payload->'revokedAt'='null'::jsonb AND (payload->>'expiresAt')::bigint>now_ms)>=5 THEN RETURN '{"error":{"code":"POST_KEY_LIMIT","message":"Revoke an existing key before creating another.","status":409}}'; END IF;
  INSERT INTO public.musegod_post_api_keys VALUES(p_scope,item_id,v_token,now_ms,key_row);RETURN jsonb_build_object('key',key_row);
 ELSIF action='keyRevoke' THEN
  SELECT payload INTO key_row FROM public.musegod_post_api_keys WHERE scope=p_scope AND musegod_post_api_keys.token=v_token AND id=item_id FOR UPDATE;
  IF key_row IS NULL THEN RETURN '{"error":{"code":"POST_KEY_NOT_FOUND","message":"The API key was not found.","status":404}}'; END IF;
  IF key_row->'revokedAt'='null'::jsonb THEN key_row:=key_row||jsonb_build_object('revokedAt',now_ms); END IF;
  UPDATE public.musegod_post_api_keys SET payload=key_row WHERE scope=p_scope AND id=item_id;RETURN jsonb_build_object('key',key_row);
 ELSIF action='postsList' THEN
  page_limit:=greatest(1,least(50,(p_command->>'limit')::integer));
  RETURN jsonb_build_object('posts',coalesce((SELECT jsonb_agg(p.payload ORDER BY p.created_at DESC,p.id DESC) FROM
   (SELECT payload,created_at,id FROM public.musegod_posts WHERE scope=p_scope AND musegod_posts.token=v_token AND payload->'deletedAt'='null'::jsonb AND
    (NOT(p_command?'before') OR (created_at,id)<((p_command->'before'->>'createdAt')::bigint,p_command->'before'->>'id')) ORDER BY created_at DESC,id DESC LIMIT page_limit) p),'[]'));
 ELSIF action='mediaGet' THEN
  SELECT payload INTO media_row FROM public.musegod_post_media WHERE scope=p_scope AND musegod_post_media.token=v_token AND id=item_id;
  RETURN CASE WHEN media_row IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('media',media_row) END;
 ELSIF action='mediaFail' THEN
  SELECT payload INTO media_row FROM public.musegod_post_media WHERE scope=p_scope AND musegod_post_media.token=v_token AND id=item_id;
  IF media_row->>'state'='pending' AND media_row->>'leaseId'=p_command->>'leaseId' THEN
   media_row:=jsonb_build_object('id',item_id,'token',v_token,'state','failed','url',null);
   UPDATE public.musegod_post_media SET payload=media_row WHERE scope=p_scope AND musegod_post_media.token=v_token AND id=item_id;
  END IF;
  RETURN CASE WHEN media_row IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('media',media_row) END;
 ELSIF action='mediaRelease' THEN
  SELECT payload INTO media_row FROM public.musegod_post_media WHERE scope=p_scope AND musegod_post_media.token=v_token AND id=item_id;
  IF media_row->>'state'='pending' AND media_row->>'leaseId'=p_command->>'leaseId' THEN
   -- A refusal known to precede any upload returns this reservation's daily image slots; the per-key minute charge stays.
   IF media_row ? 'reservedAt' THEN
    bucket:=(media_row->>'reservedAt')::bigint/86400000;
    PERFORM pg_advisory_xact_lock(hashtextextended('musegod_post_global_images',0));
    UPDATE public.musegod_post_rates SET count=count-1 WHERE scope=p_scope AND key='images:'||v_token||':'||bucket AND count>0;
    UPDATE public.musegod_post_rates SET count=count-1 WHERE scope=CASE WHEN p_scope IN ('base','robinhood') THEN 'global' ELSE p_scope END AND key='images-global:'||bucket AND count>0;
   END IF;
   media_row:=jsonb_build_object('id',item_id,'token',v_token,'state','failed','url',null);
   UPDATE public.musegod_post_media SET payload=media_row WHERE scope=p_scope AND musegod_post_media.token=v_token AND id=item_id;
  END IF;
  RETURN CASE WHEN media_row IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('media',media_row) END;
 END IF;
 IF action NOT IN ('postCreate','postDelete','mediaReserve','mediaComplete') THEN RAISE EXCEPTION 'Unknown Posts command'; END IF;
 IF action<>'postDelete' OR key_id IS NOT NULL THEN
  SELECT payload INTO key_row FROM public.musegod_post_api_keys WHERE scope=p_scope AND musegod_post_api_keys.token=v_token AND id=key_id FOR UPDATE;
  IF key_row IS NULL OR key_row->'revokedAt' IS DISTINCT FROM 'null'::jsonb OR (key_row->>'expiresAt')::bigint<=now_ms THEN RETURN '{"error":{"code":"POST_KEY_INVALID","message":"The API key is invalid, expired or revoked.","status":401}}'; END IF;
 END IF;
 IF action='postCreate' THEN
  SELECT payload,request_hash INTO post_row,previous_hash FROM public.musegod_posts WHERE scope=p_scope AND musegod_posts.token=v_token AND idempotency_key=p_command->>'idempotencyKey';
  IF post_row IS NOT NULL THEN
   IF previous_hash IS DISTINCT FROM p_command->>'requestHash' THEN RETURN '{"error":{"code":"POST_IDEMPOTENCY_CONFLICT","message":"The idempotency key was already used for different content.","status":409}}'; END IF;
   RETURN jsonb_build_object('post',post_row,'duplicate',true);
  END IF;
  post_row:=p_command->'post';
  IF post_row->>'token' IS DISTINCT FROM v_token OR post_row->>'keyId' IS DISTINCT FROM key_id OR (post_row->>'createdAt')::bigint IS DISTINCT FROM now_ms OR post_row->'deletedAt' IS DISTINCT FROM 'null'::jsonb OR
   coalesce(length(p_command->>'idempotencyKey'),0) NOT BETWEEN 1 AND 200 OR coalesce(p_command->>'requestHash','') !~ '^[0-9a-f]{64}$' OR jsonb_typeof(post_row->'imageIds') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid Post'; END IF;
  FOR image_id IN SELECT jsonb_array_elements_text(post_row->'imageIds') LOOP
   SELECT payload INTO media_row FROM public.musegod_post_media WHERE scope=p_scope AND musegod_post_media.token=v_token AND id=image_id;
   IF media_row IS NULL OR media_row->>'state'<>'ready' OR media_row->>'url' IS NULL THEN RETURN '{"error":{"code":"POST_MEDIA_INVALID","message":"Each image must be an uploaded image for this token.","status":400}}'; END IF;
   image_urls:=image_urls||jsonb_build_array(jsonb_build_object('id',image_id,'url',media_row->>'url'));
  END LOOP;
  post_row:=post_row||jsonb_build_object('images',image_urls);
  charges:=jsonb_build_array(jsonb_build_object('key','posts-minute:'||v_token,'window',60000,'maximum',2),jsonb_build_object('key','posts-day:'||v_token,'window',86400000,'maximum',60));
 ELSIF action='postDelete' THEN
  SELECT payload INTO post_row FROM public.musegod_posts WHERE scope=p_scope AND musegod_posts.token=v_token AND id=p_command->>'postId' FOR UPDATE;
  IF post_row IS NULL THEN RETURN '{"error":{"code":"POST_NOT_FOUND","message":"The post was not found.","status":404}}'; END IF;
  IF post_row->'deletedAt'<>'null'::jsonb THEN RETURN jsonb_build_object('post',post_row,'deleted',true,'duplicate',true); END IF;
  charges:=jsonb_build_array(jsonb_build_object('key','delete:'||v_token,'window',60000,'maximum',30));
 ELSIF action='mediaReserve' THEN
  IF coalesce(item_id,'') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid media hash'; END IF;
  SELECT payload INTO media_row FROM public.musegod_post_media WHERE scope=p_scope AND musegod_post_media.token=v_token AND id=item_id;
  IF media_row->>'state'='ready' THEN RETURN jsonb_build_object('media',media_row,'duplicate',true); END IF;
  IF media_row->>'state'='pending' AND (media_row->>'pendingUntil')::bigint>now_ms THEN RETURN jsonb_build_object('error',jsonb_build_object('code','POST_MEDIA_PENDING','message','The image upload is already running. Retry shortly.','status',409,'retryAfter',greatest(1,ceil(((media_row->>'pendingUntil')::bigint-now_ms)/1000.0)::integer))); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('musegod_post_global_images',0));
  charges:=jsonb_build_array(jsonb_build_object('key','images:'||v_token,'window',86400000,'maximum',10),jsonb_build_object('key','images-global','window',86400000,'maximum',50,'global',true));
 ELSIF action='mediaComplete' THEN
  SELECT payload INTO media_row FROM public.musegod_post_media WHERE scope=p_scope AND musegod_post_media.token=v_token AND id=item_id;
  IF media_row IS NULL OR media_row->>'state'<>'pending' OR media_row->>'leaseId' IS DISTINCT FROM p_command->>'leaseId' OR (media_row->>'pendingUntil')::bigint<=now_ms THEN RETURN '{"error":{"code":"POST_MEDIA_LEASE","message":"The image upload lease expired. Retry the upload.","status":409}}'; END IF;
  media_row:=jsonb_build_object('id',item_id,'token',v_token,'state','ready','url',p_command->>'url');
  UPDATE public.musegod_post_media SET payload=media_row WHERE scope=p_scope AND musegod_post_media.token=v_token AND id=item_id;RETURN jsonb_build_object('media',media_row);
 END IF;
 IF key_id IS NOT NULL THEN charges:=charges||jsonb_build_array(jsonb_build_object('key','key:'||key_id,'window',60000,'maximum',10)); END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(charges) LOOP
  bucket:=now_ms/(c->>'window')::bigint;rate_scope:=CASE WHEN coalesce((c->>'global')::boolean,false) AND p_scope IN ('base','robinhood') THEN 'global' ELSE p_scope END;
  rate_key:=(c->>'key')||':'||bucket;until_ms:=(bucket+1)*(c->>'window')::bigint;maximum:=(c->>'maximum')::integer;
  SELECT count INTO used FROM public.musegod_post_rates WHERE scope=rate_scope AND key=rate_key;
  IF coalesce(used,0)>=maximum THEN RETURN jsonb_build_object('error',jsonb_build_object('code','POST_RATE_LIMITED','message','The post API limit has been reached. Try again later.','status',429,'retryAfter',greatest(1,ceil((until_ms-now_ms)/1000.0)::integer))); END IF;
 END LOOP;
 FOR c IN SELECT value FROM jsonb_array_elements(charges) LOOP
  bucket:=now_ms/(c->>'window')::bigint;rate_scope:=CASE WHEN coalesce((c->>'global')::boolean,false) AND p_scope IN ('base','robinhood') THEN 'global' ELSE p_scope END;rate_key:=(c->>'key')||':'||bucket;until_ms:=(bucket+1)*(c->>'window')::bigint;
  INSERT INTO public.musegod_post_rates VALUES(rate_scope,rate_key,1,until_ms) ON CONFLICT(scope,key) DO UPDATE SET count=musegod_post_rates.count+1;
 END LOOP;
 IF action='postCreate' THEN
  INSERT INTO public.musegod_posts VALUES(p_scope,post_row->>'id',v_token,now_ms,p_command->>'idempotencyKey',p_command->>'requestHash',post_row);RETURN jsonb_build_object('post',post_row);
 ELSIF action='postDelete' THEN
  post_row:=post_row||jsonb_build_object('deletedAt',now_ms);UPDATE public.musegod_posts SET payload=post_row WHERE scope=p_scope AND musegod_posts.token=v_token AND id=p_command->>'postId';RETURN jsonb_build_object('post',post_row,'deleted',true);
 ELSE
  media_row:=jsonb_build_object('id',item_id,'token',v_token,'state','pending','url',null,'leaseId',p_command->>'leaseId','pendingUntil',now_ms+120000,'reservedAt',now_ms);
  INSERT INTO public.musegod_post_media VALUES(p_scope,v_token,item_id,media_row) ON CONFLICT(scope,token,id) DO UPDATE SET payload=excluded.payload;RETURN jsonb_build_object('media',media_row);
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.musegod_post_action(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.musegod_post_action(text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.musegod_backup(p_scope text)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
 SELECT jsonb_build_object('version',3,'scope',p_scope,
 'post_api_keys',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_post_api_keys t where scope=p_scope),
 'posts',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_posts t where scope=p_scope),
 'post_media',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_post_media t where scope=p_scope),
 'post_rates',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_post_rates t where scope=p_scope),
 -- A production scope also carries the shared cross-chain image counter; restore merges it by maximum.
 'post_global_rates',CASE WHEN p_scope IN ('base','robinhood') THEN (select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_post_rates t where scope='global') ELSE '[]'::jsonb END,
 'plans',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_plans t where scope=p_scope),
 'tokens',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_tokens t where scope=p_scope),
 'snapshots',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_snapshots t where scope=p_scope),
 'quota',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_quota t where scope=p_scope),
 'pending_launches',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_pending_launches t where scope=p_scope),
 'buyback_batches',(select coalesce(jsonb_agg(to_jsonb(t)-'sequence'||jsonb_build_object('sequence',t.sequence::text)),'[]') from public.musegod_buyback_batches t where scope=p_scope),
 'runtime_controls',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_runtime_controls t where scope=p_scope),
 'vault_ledger_state',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_vault_ledger_state t where scope=p_scope),
 'vault_ledger_blocks',(select coalesce(jsonb_agg(to_jsonb(t) order by block_number),'[]') from public.musegod_vault_ledger_blocks t where scope=p_scope),
 'vault_ledger_events',(select coalesce(jsonb_agg(to_jsonb(t) order by block_number,transaction_index,log_index),'[]') from public.musegod_vault_ledger_events t where scope=p_scope),
 'custody_ledger_state',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_custody_ledger_state t where scope=p_scope),
 'custody_ledger_blocks',(select coalesce(jsonb_agg(to_jsonb(t) order by ledger_id,block_number),'[]') from public.musegod_custody_ledger_blocks t where scope=p_scope),
 'custody_ledger_events',(select coalesce(jsonb_agg(to_jsonb(t) order by ledger_id,block_number,transaction_index,log_index),'[]') from public.musegod_custody_ledger_events t where scope=p_scope));
$$;
CREATE OR REPLACE FUNCTION public.musegod_restore(p_scope text,p_backup jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('musegod_market:'||p_scope,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('musegod_vault_ledger:'||p_scope,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('musegod_custody_ledger:'||p_scope||':base_automation',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('musegod_custody_ledger:'||p_scope||':robinhood_treasury',0));
 IF jsonb_typeof(p_backup) IS DISTINCT FROM 'object' OR coalesce(p_backup->>'version','') NOT IN ('1','2','3') THEN RAISE EXCEPTION 'Unsupported backup'; END IF;
 IF EXISTS(select 1 from public.musegod_post_api_keys where scope=p_scope) OR EXISTS(select 1 from public.musegod_posts where scope=p_scope) OR EXISTS(select 1 from public.musegod_post_media where scope=p_scope) OR EXISTS(select 1 from public.musegod_post_rates where scope=p_scope) OR EXISTS(select 1 from public.musegod_plans where scope=p_scope) OR EXISTS(select 1 from public.musegod_tokens where scope=p_scope) OR
  EXISTS(select 1 from public.musegod_snapshots where scope=p_scope) OR EXISTS(select 1 from public.musegod_quota where scope=p_scope) OR
  EXISTS(select 1 from public.musegod_pending_launches where scope=p_scope) OR EXISTS(select 1 from public.musegod_buyback_batches where scope=p_scope) OR
  EXISTS(select 1 from public.musegod_vault_ledger_state where scope=p_scope) OR EXISTS(select 1 from public.musegod_vault_ledger_blocks where scope=p_scope) OR
  EXISTS(select 1 from public.musegod_vault_ledger_events where scope=p_scope) OR EXISTS(select 1 from public.musegod_custody_ledger_state where scope=p_scope) OR
  EXISTS(select 1 from public.musegod_custody_ledger_blocks where scope=p_scope) OR EXISTS(select 1 from public.musegod_custody_ledger_events where scope=p_scope) THEN RAISE EXCEPTION 'Restore target is not empty'; END IF;
 INSERT INTO public.musegod_plans SELECT p_scope,id,creator,data,prepared_at,payload,protected_at FROM jsonb_populate_recordset(null::public.musegod_plans,coalesce(p_backup->'plans','[]'));
 INSERT INTO public.musegod_tokens SELECT p_scope,address,tx_hash,created_at,payload FROM jsonb_populate_recordset(null::public.musegod_tokens,coalesce(p_backup->'tokens','[]'));
 INSERT INTO public.musegod_snapshots SELECT p_scope,key,at,payload FROM jsonb_populate_recordset(null::public.musegod_snapshots,coalesce(p_backup->'snapshots','[]'));
 INSERT INTO public.musegod_quota SELECT p_scope,key,count FROM jsonb_populate_recordset(null::public.musegod_quota,coalesce(p_backup->'quota','[]'));
 INSERT INTO public.musegod_pending_launches SELECT p_scope,hash,plan_id,status,block_hash,updated_at,coalesce(retry_at,0),coalesce(attempts,0),coalesce(finalized,false) FROM jsonb_populate_recordset(null::public.musegod_pending_launches,coalesce(p_backup->'pending_launches','[]'));
 INSERT INTO public.musegod_buyback_batches(scope,id,updated_at,payload,sequence) SELECT p_scope,id,updated_at,payload,coalesce(sequence,nextval('public.musegod_buyback_batches_sequence_seq'::regclass)) FROM jsonb_populate_recordset(null::public.musegod_buyback_batches,coalesce(p_backup->'buyback_batches','[]'));
 -- Existing controls are never overwritten by recovery. Isolated restore scopes retain their backed-up revision.
 INSERT INTO public.musegod_runtime_controls SELECT p_scope,paused,revision,updated_at,reason FROM jsonb_populate_recordset(null::public.musegod_runtime_controls,coalesce(p_backup->'runtime_controls','[]')) ON CONFLICT(scope) DO NOTHING;
 INSERT INTO public.musegod_vault_ledger_state SELECT p_scope,revision,payload FROM jsonb_populate_recordset(null::public.musegod_vault_ledger_state,coalesce(p_backup->'vault_ledger_state','[]'));
 INSERT INTO public.musegod_vault_ledger_blocks SELECT p_scope,block_number,payload FROM jsonb_populate_recordset(null::public.musegod_vault_ledger_blocks,coalesce(p_backup->'vault_ledger_blocks','[]'));
 INSERT INTO public.musegod_vault_ledger_events SELECT p_scope,id,block_number,transaction_index,log_index,payload FROM jsonb_populate_recordset(null::public.musegod_vault_ledger_events,coalesce(p_backup->'vault_ledger_events','[]'));
 INSERT INTO public.musegod_custody_ledger_state SELECT p_scope,ledger_id,revision,payload FROM jsonb_populate_recordset(null::public.musegod_custody_ledger_state,coalesce(p_backup->'custody_ledger_state','[]'));
 INSERT INTO public.musegod_custody_ledger_blocks SELECT p_scope,ledger_id,block_number,payload FROM jsonb_populate_recordset(null::public.musegod_custody_ledger_blocks,coalesce(p_backup->'custody_ledger_blocks','[]'));
 INSERT INTO public.musegod_custody_ledger_events SELECT p_scope,ledger_id,id,block_number,transaction_index,log_index,payload FROM jsonb_populate_recordset(null::public.musegod_custody_ledger_events,coalesce(p_backup->'custody_ledger_events','[]'));
 -- A restore never restores bearer authority. Keep nonce and audit history, but require fresh keys.
 INSERT INTO public.musegod_post_api_keys SELECT p_scope,id,token,created_at,
  payload||jsonb_build_object('revokedAt',coalesce(nullif(payload->'revokedAt','null'::jsonb),to_jsonb(floor(extract(epoch from clock_timestamp())*1000)::bigint)))
  FROM jsonb_populate_recordset(null::public.musegod_post_api_keys,coalesce(p_backup->'post_api_keys','[]'));
 INSERT INTO public.musegod_posts SELECT p_scope,id,token,created_at,idempotency_key,request_hash,payload FROM jsonb_populate_recordset(null::public.musegod_posts,coalesce(p_backup->'posts','[]'));
 INSERT INTO public.musegod_post_media SELECT p_scope,token,id,payload FROM jsonb_populate_recordset(null::public.musegod_post_media,coalesce(p_backup->'post_media','[]'));
 INSERT INTO public.musegod_post_rates SELECT p_scope,key,count,expires_at FROM jsonb_populate_recordset(null::public.musegod_post_rates,coalesce(p_backup->'post_rates','[]'));
 -- The shared image counter merges by maximum: idempotent, never lowers a live window, and two chain backups count each day once.
 -- An isolated restore scope keeps the counter inside its own scope, away from live global state.
 PERFORM pg_advisory_xact_lock(hashtextextended('musegod_post_global_images',0));
 INSERT INTO public.musegod_post_rates SELECT CASE WHEN p_scope IN ('base','robinhood') THEN 'global' ELSE p_scope END,key,count,expires_at
  FROM jsonb_populate_recordset(null::public.musegod_post_rates,coalesce(p_backup->'post_global_rates','[]'))
  ON CONFLICT(scope,key) DO UPDATE SET count=greatest(musegod_post_rates.count,excluded.count),expires_at=greatest(musegod_post_rates.expires_at,excluded.expires_at);
PERFORM pg_catalog.setval('public.musegod_buyback_batches_sequence_seq',greatest((SELECT last_value FROM public.musegod_buyback_batches_sequence_seq),(SELECT coalesce(max(sequence),1) FROM public.musegod_buyback_batches)));
END $$;
CREATE OR REPLACE FUNCTION public.musegod_cleanup(p_scope text,p_now bigint)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 DELETE FROM public.musegod_post_rates WHERE scope=p_scope AND expires_at<=p_now;
 -- Only a production scope clears the shared cross-chain image counter, and never ahead of the database clock, so a
 -- verify/restore scope's simulated time cannot reopen the live cap.
 IF p_scope IN ('base','robinhood') THEN
  DELETE FROM public.musegod_post_rates WHERE scope='global' AND expires_at<=least(p_now,floor(extract(epoch from clock_timestamp())*1000)::bigint);
 END IF;
 DELETE FROM public.musegod_snapshots WHERE scope=p_scope AND at<p_now-86400000 AND key NOT LIKE 'pinata:%' AND key NOT LIKE 'buyback:index:%' AND key NOT LIKE 'profile:%';
 DELETE FROM public.musegod_quota WHERE scope=p_scope AND key<to_char(to_timestamp((p_now-8640000000)/1000.0) at time zone 'UTC','YYYY-MM');
 DELETE FROM public.musegod_pending_launches WHERE scope=p_scope AND status IN ('failed','replaced') AND updated_at<p_now-2592000000;
 DELETE FROM public.musegod_plans p WHERE scope=p_scope AND protected_at IS NULL AND prepared_at<p_now-2592000000 AND NOT EXISTS(SELECT 1 FROM public.musegod_pending_launches q WHERE q.scope=p.scope AND q.plan_id=p.id);
END $$;
REVOKE ALL ON FUNCTION public.musegod_cleanup(text,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.musegod_cleanup(text,bigint) TO service_role;


NOTIFY pgrst,'reload schema';
COMMIT;
