BEGIN;
CREATE TABLE public.musegod_custody_ledger_state (scope text NOT NULL,ledger_id text NOT NULL CHECK(ledger_id IN ('base_automation','robinhood_treasury')),revision bigint NOT NULL CHECK(revision>0),payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),PRIMARY KEY(scope,ledger_id));
CREATE TABLE public.musegod_custody_ledger_blocks (scope text NOT NULL,ledger_id text NOT NULL,block_number bigint NOT NULL CHECK(block_number>=0),payload jsonb NOT NULL,PRIMARY KEY(scope,ledger_id,block_number));
CREATE TABLE public.musegod_custody_ledger_events (scope text NOT NULL,ledger_id text NOT NULL,id text NOT NULL,block_number bigint NOT NULL CHECK(block_number>=0),transaction_index integer NOT NULL CHECK(transaction_index>=0),log_index integer NOT NULL CHECK(log_index>=0),payload jsonb NOT NULL,PRIMARY KEY(scope,ledger_id,id),UNIQUE(scope,ledger_id,block_number,transaction_index,log_index));
ALTER TABLE public.musegod_custody_ledger_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.musegod_custody_ledger_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.musegod_custody_ledger_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.musegod_custody_ledger_state,public.musegod_custody_ledger_blocks,public.musegod_custody_ledger_events FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.musegod_custody_ledger_state,public.musegod_custody_ledger_blocks,public.musegod_custody_ledger_events TO service_role;
CREATE FUNCTION public.musegod_validate_custody_fragments(p_fragments jsonb,p_amount text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE f jsonb; total numeric:=0;
BEGIN
 IF jsonb_typeof(p_fragments) IS DISTINCT FROM 'array' OR jsonb_array_length(p_fragments)=0 OR NOT coalesce(p_amount ~ '^(0|[1-9][0-9]*)$',false) THEN RETURN false; END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(p_fragments) LOOP
  IF NOT coalesce(f->>'amount' ~ '^[1-9][0-9]*$',false) OR NOT (f ? 'batchId') OR
   (f->'batchId'<>'null'::jsonb AND (jsonb_typeof(f->'batchId')<>'string' OR length(f->>'batchId') NOT BETWEEN 1 AND 200)) THEN RETURN false; END IF;
  total:=total+(f->>'amount')::numeric;
 END LOOP;
 RETURN total=p_amount::numeric;
END $$;
CREATE FUNCTION public.musegod_commit_custody_ledger(p_scope text,p_commit jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE expected bigint; next_state jsonb; ledger text; current_state jsonb; current_revision bigint; b jsonb;e jsonb;c jsonb;old_event jsonb;ancestor bigint;raw text;pair record;
BEGIN
 next_state:=p_commit->'state';ledger:=next_state->>'id';expected:=(p_commit->>'expectedRevision')::bigint;
 IF p_scope !~ '^(base|robinhood|verify-[a-z0-9-]+|restore-[a-z0-9-]+)$' OR ledger NOT IN ('base_automation','robinhood_treasury') OR
  (p_scope='base' AND ledger<>'base_automation') OR (p_scope='robinhood' AND ledger<>'robinhood_treasury') THEN RAISE EXCEPTION 'Custody journal belongs to another chain'; END IF;
 IF expected IS NULL OR expected<0 OR next_state->>'version' IS DISTINCT FROM '1' OR
  next_state->>'chainId' IS DISTINCT FROM (CASE WHEN ledger='base_automation' THEN '8453' ELSE '4663' END) OR
  (next_state->>'revision')::bigint IS DISTINCT FROM expected+1 OR NOT coalesce(next_state->>'account' ~ '^0x[0-9a-fA-F]{40}$',false) OR
  jsonb_typeof(next_state->'openingBalances') IS DISTINCT FROM 'object' OR jsonb_typeof(next_state->'observedBalances') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid custody state'; END IF;
 FOREACH raw IN ARRAY ARRAY[next_state->'checkpoint'->>'number',next_state->'cursor'->>'number'] LOOP IF NOT coalesce(raw ~ '^(0|[1-9][0-9]*)$',false) THEN RAISE EXCEPTION 'Invalid custody block number'; END IF; END LOOP;
 FOREACH raw IN ARRAY ARRAY[next_state->'checkpoint'->>'hash',next_state->'checkpoint'->>'parentHash',next_state->'cursor'->>'hash',next_state->'cursor'->>'parentHash'] LOOP IF NOT coalesce(raw ~ '^0x[0-9a-fA-F]{64}$',false) THEN RAISE EXCEPTION 'Invalid custody block identity'; END IF; END LOOP;
 FOR pair IN SELECT * FROM jsonb_each_text(next_state->'openingBalances') UNION ALL SELECT * FROM jsonb_each_text(next_state->'observedBalances') LOOP
  IF pair.key !~ '^0x[0-9a-f]{40}$' OR NOT coalesce(pair.value ~ '^(0|[1-9][0-9]*)$',false) THEN RAISE EXCEPTION 'Invalid custody balance'; END IF;
 END LOOP;
 PERFORM pg_advisory_xact_lock(hashtextextended('musegod_custody_ledger:'||p_scope||':'||ledger,0));
 SELECT revision,payload INTO current_revision,current_state FROM public.musegod_custody_ledger_state WHERE scope=p_scope AND ledger_id=ledger;
 IF coalesce(current_revision,0)<>expected THEN RAISE EXCEPTION 'Custody revision changed; retry'; END IF;
 IF current_state IS NOT NULL AND (current_state->'checkpoint'<>next_state->'checkpoint' OR lower(current_state->>'account')<>lower(next_state->>'account') OR current_state->>'chainId'<>next_state->>'chainId' OR
  NOT ((next_state->'openingBalances') @> (current_state->'openingBalances'))) THEN RAISE EXCEPTION 'Custody checkpoint or graph cannot be replaced'; END IF;
 IF (next_state->'cursor'->>'number')::bigint<(next_state->'checkpoint'->>'number')::bigint THEN RAISE EXCEPTION 'Custody cursor precedes checkpoint'; END IF;
 IF p_commit ? 'rollbackAfterBlock' THEN
  ancestor:=(p_commit->>'rollbackAfterBlock')::bigint;
  IF current_state IS NULL OR ancestor<(current_state->'checkpoint'->>'number')::bigint OR ancestor>(current_state->'cursor'->>'number')::bigint THEN RAISE EXCEPTION 'Invalid custody rollback ancestor'; END IF;
  DELETE FROM public.musegod_custody_ledger_events WHERE scope=p_scope AND ledger_id=ledger AND block_number>ancestor;
  DELETE FROM public.musegod_custody_ledger_blocks WHERE scope=p_scope AND ledger_id=ledger AND block_number>ancestor;
 END IF;
 FOR b IN SELECT value FROM jsonb_array_elements(coalesce(p_commit->'blocks','[]')) LOOP
  IF NOT coalesce(b->>'hash' ~ '^0x[0-9a-fA-F]{64}$' AND b->>'parentHash' ~ '^0x[0-9a-fA-F]{64}$',false) THEN RAISE EXCEPTION 'Invalid custody block identity'; END IF;
  IF EXISTS(SELECT 1 FROM public.musegod_custody_ledger_blocks WHERE scope=p_scope AND ledger_id=ledger AND block_number=(b->>'number')::bigint AND payload<>b) THEN RAISE EXCEPTION 'Conflicting canonical custody block; rollback first'; END IF;
  INSERT INTO public.musegod_custody_ledger_blocks VALUES(p_scope,ledger,(b->>'number')::bigint,b) ON CONFLICT DO NOTHING;
 END LOOP;
 FOR e IN SELECT value FROM jsonb_array_elements(coalesce(p_commit->'events','[]')) LOOP
  IF e->>'id' IS DISTINCT FROM lower(e->>'transactionHash')||':'||(e->>'logIndex') OR NOT coalesce(e->>'blockHash' ~ '^0x[0-9a-fA-F]{64}$' AND e->>'transactionHash' ~ '^0x[0-9a-fA-F]{64}$' AND e->>'asset' ~ '^0x[0-9a-fA-F]{40}$' AND e->>'amount' ~ '^(0|[1-9][0-9]*)$' AND e->>'kind' IN ('in','out'),false) OR
   lower(CASE WHEN e->>'kind'='in' THEN e->>'to' ELSE e->>'from' END) IS DISTINCT FROM lower(next_state->>'account') OR lower(e->>'from')=lower(e->>'to') THEN RAISE EXCEPTION 'Invalid custody event'; END IF;
  IF (e->>'blockNumber')::bigint<=(next_state->'checkpoint'->>'number')::bigint OR (e->>'blockNumber')::bigint>(next_state->'cursor'->>'number')::bigint OR
   NOT EXISTS(SELECT 1 FROM public.musegod_custody_ledger_blocks WHERE scope=p_scope AND ledger_id=ledger AND block_number=(e->>'blockNumber')::bigint AND lower(payload->>'hash')=lower(e->>'blockHash')) THEN RAISE EXCEPTION 'Custody event outside canonical journal interval'; END IF;
  IF e ? 'fragments' AND (e->>'kind'<>'in' OR NOT (e ? 'evidence') OR NOT public.musegod_validate_custody_fragments(e->'fragments',e->>'amount')) THEN RAISE EXCEPTION 'Custody fragments do not conserve funds'; END IF;
  IF EXISTS(SELECT 1 FROM public.musegod_custody_ledger_events WHERE scope=p_scope AND ledger_id=ledger AND id=e->>'id' AND payload<>e) THEN RAISE EXCEPTION 'Conflicting canonical custody event'; END IF;
  INSERT INTO public.musegod_custody_ledger_events VALUES(p_scope,ledger,e->>'id',(e->>'blockNumber')::bigint,(e->>'transactionIndex')::integer,(e->>'logIndex')::integer,e) ON CONFLICT DO NOTHING;
 END LOOP;
 FOR c IN SELECT value FROM jsonb_array_elements(coalesce(p_commit->'classifications','[]')) LOOP
  SELECT payload INTO old_event FROM public.musegod_custody_ledger_events WHERE scope=p_scope AND ledger_id=ledger AND id=c->>'eventId';
  IF old_event IS NULL OR old_event->>'kind'<>'in' OR NOT (c ? 'evidence') OR NOT public.musegod_validate_custody_fragments(c->'fragments',old_event->>'amount') THEN RAISE EXCEPTION 'Invalid custody classification'; END IF;
  IF NOT coalesce((c->>'revalidate')::boolean,false) AND old_event ? 'evidence' AND (old_event->'evidence'<>c->'evidence' OR old_event->'fragments'<>c->'fragments') THEN RAISE EXCEPTION 'Custody provenance is already verified'; END IF;
  UPDATE public.musegod_custody_ledger_events SET payload=old_event||jsonb_build_object('fragments',c->'fragments','evidence',c->'evidence') WHERE scope=p_scope AND ledger_id=ledger AND id=c->>'eventId';
 END LOOP;
 INSERT INTO public.musegod_custody_ledger_state VALUES(p_scope,ledger,expected+1,next_state) ON CONFLICT(scope,ledger_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload;
 RETURN next_state;
END $$;
-- Extend the existing validator; legacy Across IDs remain numeric and are never interpreted as Relay IDs.
ALTER FUNCTION public.musegod_validate_vault_base_fill(jsonb,jsonb,jsonb) RENAME TO musegod_validate_legacy_vault_base_fill;
CREATE FUNCTION public.musegod_validate_vault_base_fill(p_event jsonb,p_evidence jsonb,p_state jsonb)
RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
 SELECT CASE WHEN p_evidence->>'protocol'='splits_native_relay_v1' THEN coalesce(
  p_event->>'kind'='weth_in' AND lower(p_evidence->>'treasury')=lower(p_event->>'from') AND p_evidence->>'treasuryEventId'=p_event->>'id' AND
  (p_evidence->>'treasuryRevision')::bigint>0 AND p_evidence->>'fillLogIndex'=p_event->>'logIndex' AND
  lower(p_evidence->>'fillTransactionHash')=lower(p_event->>'transactionHash') AND lower(p_evidence->>'fillBlockHash')=lower(p_event->>'blockHash') AND
  lower(p_evidence->>'recipient')=lower(p_state->>'vault') AND lower(p_evidence->>'outputToken')=lower(p_state->>'weth') AND p_evidence->>'outputAmount'=p_event->>'amount' AND
  public.musegod_validate_custody_fragments(p_evidence->'fragments',p_event->>'amount') AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_evidence->'fragments') f WHERE f->'batchId'<>'null'::jsonb),false)
 ELSE public.musegod_validate_legacy_vault_base_fill(p_event,p_evidence,p_state) END;
$$;
REVOKE ALL ON FUNCTION public.musegod_validate_custody_fragments(jsonb,text),public.musegod_commit_custody_ledger(text,jsonb),public.musegod_validate_vault_base_fill(jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.musegod_validate_custody_fragments(jsonb,text),public.musegod_commit_custody_ledger(text,jsonb),public.musegod_validate_vault_base_fill(jsonb,jsonb,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.musegod_backup(p_scope text)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
 SELECT jsonb_build_object('version',3,'scope',p_scope,
 'plans',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_plans t where scope=p_scope),
 'tokens',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_tokens t where scope=p_scope),
 'snapshots',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_snapshots t where scope=p_scope),
 'quota',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_quota t where scope=p_scope),
 'pending_launches',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_pending_launches t where scope=p_scope),
 'buyback_batches',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.musegod_buyback_batches t where scope=p_scope),
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
 IF EXISTS(select 1 from public.musegod_plans where scope=p_scope) OR EXISTS(select 1 from public.musegod_tokens where scope=p_scope) OR
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
 INSERT INTO public.musegod_buyback_batches SELECT p_scope,id,updated_at,payload FROM jsonb_populate_recordset(null::public.musegod_buyback_batches,coalesce(p_backup->'buyback_batches','[]'));
 -- Existing controls are never overwritten by recovery. Isolated restore scopes retain their backed-up revision.
 INSERT INTO public.musegod_runtime_controls SELECT p_scope,paused,revision,updated_at,reason FROM jsonb_populate_recordset(null::public.musegod_runtime_controls,coalesce(p_backup->'runtime_controls','[]')) ON CONFLICT(scope) DO NOTHING;
 INSERT INTO public.musegod_vault_ledger_state SELECT p_scope,revision,payload FROM jsonb_populate_recordset(null::public.musegod_vault_ledger_state,coalesce(p_backup->'vault_ledger_state','[]'));
 INSERT INTO public.musegod_vault_ledger_blocks SELECT p_scope,block_number,payload FROM jsonb_populate_recordset(null::public.musegod_vault_ledger_blocks,coalesce(p_backup->'vault_ledger_blocks','[]'));
 INSERT INTO public.musegod_vault_ledger_events SELECT p_scope,id,block_number,transaction_index,log_index,payload FROM jsonb_populate_recordset(null::public.musegod_vault_ledger_events,coalesce(p_backup->'vault_ledger_events','[]'));
 INSERT INTO public.musegod_custody_ledger_state SELECT p_scope,ledger_id,revision,payload FROM jsonb_populate_recordset(null::public.musegod_custody_ledger_state,coalesce(p_backup->'custody_ledger_state','[]'));
 INSERT INTO public.musegod_custody_ledger_blocks SELECT p_scope,ledger_id,block_number,payload FROM jsonb_populate_recordset(null::public.musegod_custody_ledger_blocks,coalesce(p_backup->'custody_ledger_blocks','[]'));
 INSERT INTO public.musegod_custody_ledger_events SELECT p_scope,ledger_id,id,block_number,transaction_index,log_index,payload FROM jsonb_populate_recordset(null::public.musegod_custody_ledger_events,coalesce(p_backup->'custody_ledger_events','[]'));
END $$;
REVOKE ALL ON FUNCTION public.musegod_backup(text),public.musegod_restore(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.musegod_backup(text),public.musegod_restore(text,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.musegod_commit_vault_ledger(p_scope text,p_commit jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE current_state jsonb; current_revision bigint; expected bigint; next_state jsonb; e jsonb; b jsonb; c jsonb; previous_event jsonb; ancestor bigint; raw text;
BEGIN
 IF p_scope !~ '^(robinhood|verify-[a-z0-9-]+|restore-[a-z0-9-]+)$' THEN RAISE EXCEPTION 'Vault ledger belongs to the Robinhood store'; END IF;
 IF jsonb_typeof(p_commit) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid vault ledger commit'; END IF;
 expected:=(p_commit->>'expectedRevision')::bigint; next_state:=p_commit->'state';
 IF expected IS NULL OR expected<0 OR jsonb_typeof(next_state) IS DISTINCT FROM 'object' OR
  NOT coalesce(next_state ?& ARRAY['vault','weth','swapper','checkpoint','cursor','observedBalance','observedTotalSpent','observedTotalBurned'],false) OR
  next_state->>'version' IS DISTINCT FROM '1' OR next_state->>'chainId' IS DISTINCT FROM '4663' OR
  (next_state->>'revision')::bigint IS DISTINCT FROM expected+1 OR
  next_state->>'vault' !~ '^0x[0-9a-fA-F]{40}$' OR next_state->>'weth' !~ '^0x[0-9a-fA-F]{40}$' OR next_state->>'swapper' !~ '^0x[0-9a-fA-F]{40}$' THEN RAISE EXCEPTION 'Invalid vault ledger state'; END IF;
 FOREACH raw IN ARRAY ARRAY[next_state->>'observedBalance',next_state->>'observedTotalSpent',next_state->>'observedTotalBurned',
  next_state->'checkpoint'->>'wethBalance',next_state->'checkpoint'->>'totalSpent',next_state->'checkpoint'->>'totalBurned',next_state->'checkpoint'->>'number',next_state->'cursor'->>'number'] LOOP
  IF NOT coalesce(raw ~ '^(0|[1-9][0-9]*)$',false) THEN RAISE EXCEPTION 'Invalid raw vault amount'; END IF;
 END LOOP;
 FOREACH raw IN ARRAY ARRAY[next_state->'checkpoint'->>'hash',next_state->'checkpoint'->>'parentHash',next_state->'cursor'->>'hash',next_state->'cursor'->>'parentHash'] LOOP
  IF NOT coalesce(raw ~ '^0x[0-9a-fA-F]{64}$',false) THEN RAISE EXCEPTION 'Invalid vault block identity'; END IF;
 END LOOP;
 PERFORM pg_advisory_xact_lock(hashtextextended('musegod_vault_ledger:'||p_scope,0));
 SELECT revision,payload INTO current_revision,current_state FROM public.musegod_vault_ledger_state WHERE scope=p_scope;
 IF coalesce(current_revision,0)<>expected THEN RAISE EXCEPTION 'Vault ledger revision changed; retry reconciliation'; END IF;
 IF current_state IS NOT NULL AND (current_state->'checkpoint'<>next_state->'checkpoint' OR
  lower(current_state->>'vault')<>lower(next_state->>'vault') OR lower(current_state->>'weth')<>lower(next_state->>'weth') OR lower(current_state->>'swapper')<>lower(next_state->>'swapper')) THEN RAISE EXCEPTION 'Vault checkpoint or graph cannot be replaced'; END IF;
 IF (next_state->'cursor'->>'number')::bigint<(next_state->'checkpoint'->>'number')::bigint THEN RAISE EXCEPTION 'Vault cursor precedes checkpoint'; END IF;
 IF p_commit ? 'rollbackAfterBlock' THEN
  ancestor:=(p_commit->>'rollbackAfterBlock')::bigint;
  IF current_state IS NULL OR ancestor<(current_state->'checkpoint'->>'number')::bigint OR ancestor>(current_state->'cursor'->>'number')::bigint THEN RAISE EXCEPTION 'Invalid vault rollback ancestor'; END IF;
  DELETE FROM public.musegod_vault_ledger_events WHERE scope=p_scope AND block_number>ancestor;
  DELETE FROM public.musegod_vault_ledger_blocks WHERE scope=p_scope AND block_number>ancestor;
 END IF;
 FOR b IN SELECT value FROM jsonb_array_elements(coalesce(p_commit->'blocks','[]')) LOOP
  IF NOT coalesce(b->>'hash' ~ '^0x[0-9a-fA-F]{64}$' AND b->>'parentHash' ~ '^0x[0-9a-fA-F]{64}$',false) THEN RAISE EXCEPTION 'Invalid vault block identity'; END IF;
  IF EXISTS(SELECT 1 FROM public.musegod_vault_ledger_blocks WHERE scope=p_scope AND block_number=(b->>'number')::bigint AND payload<>b) THEN RAISE EXCEPTION 'Conflicting canonical vault block; roll back first'; END IF;
  INSERT INTO public.musegod_vault_ledger_blocks VALUES(p_scope,(b->>'number')::bigint,b) ON CONFLICT DO NOTHING;
 END LOOP;
 FOR e IN SELECT value FROM jsonb_array_elements(coalesce(p_commit->'events','[]')) LOOP
  IF e->>'id' IS DISTINCT FROM lower(e->>'transactionHash')||':'||(e->>'logIndex') OR
   e->>'transactionHash' !~ '^0x[0-9a-fA-F]{64}$' OR e->>'blockHash' !~ '^0x[0-9a-fA-F]{64}$' OR
   e->>'kind' NOT IN ('weth_in','weth_out','executed') THEN RAISE EXCEPTION 'Invalid vault event identity'; END IF;
  IF (e->>'blockNumber')::bigint<=(next_state->'checkpoint'->>'number')::bigint OR (e->>'blockNumber')::bigint>(next_state->'cursor'->>'number')::bigint THEN RAISE EXCEPTION 'Vault event outside indexed interval'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.musegod_vault_ledger_blocks WHERE scope=p_scope AND block_number=(e->>'blockNumber')::bigint AND lower(payload->>'hash')=lower(e->>'blockHash')) THEN RAISE EXCEPTION 'Vault event does not match indexed canonical block'; END IF;
  IF e->>'kind'='executed' THEN
   FOREACH raw IN ARRAY ARRAY[e->>'wethAmount',e->>'museToDead',e->>'profit'] LOOP IF NOT coalesce(raw ~ '^(0|[1-9][0-9]*)$',false) THEN RAISE EXCEPTION 'Invalid raw vault amount'; END IF; END LOOP;
  ELSE
   IF NOT coalesce(e->>'amount' ~ '^(0|[1-9][0-9]*)$',false) THEN RAISE EXCEPTION 'Invalid raw vault amount'; END IF;
   IF e->>'kind'='weth_in' AND NOT coalesce(e->>'source' IN ('base','robinhood_engine','donation','unknown'),false) THEN RAISE EXCEPTION 'Invalid vault source classification'; END IF;
  END IF;
  IF e->>'source'='base' AND NOT public.musegod_validate_vault_base_fill(e,e->'baseFill',next_state) THEN RAISE EXCEPTION 'Base fill evidence does not match canonical Vault transfer'; END IF;
  IF EXISTS(SELECT 1 FROM public.musegod_vault_ledger_events WHERE scope=p_scope AND id=e->>'id' AND payload<>e) THEN RAISE EXCEPTION 'Conflicting canonical vault event'; END IF;
  INSERT INTO public.musegod_vault_ledger_events VALUES(p_scope,e->>'id',(e->>'blockNumber')::bigint,(e->>'transactionIndex')::integer,(e->>'logIndex')::integer,e) ON CONFLICT DO NOTHING;
 END LOOP;
 FOR c IN SELECT value FROM jsonb_array_elements(coalesce(p_commit->'classifications','[]')) LOOP
  SELECT payload INTO previous_event FROM public.musegod_vault_ledger_events WHERE scope=p_scope AND id=c->>'eventId';
  IF previous_event IS NULL OR previous_event->>'kind'<>'weth_in' OR NOT coalesce(c->>'source' IN ('base','robinhood_engine','donation','unknown'),false) THEN RAISE EXCEPTION 'Invalid vault source classification'; END IF;
  IF NOT coalesce((c->>'revalidate')::boolean,false) AND previous_event->>'source'<>'unknown' AND (previous_event->>'source'<>c->>'source' OR coalesce(previous_event->'baseFill','null')<>coalesce(c->'baseFill','null')) THEN RAISE EXCEPTION 'Vault source classification is already verified'; END IF;
  IF c->>'source'='base' AND NOT public.musegod_validate_vault_base_fill(previous_event,c->'baseFill',next_state) THEN RAISE EXCEPTION 'Base fill evidence does not match canonical Vault transfer'; END IF;
  UPDATE public.musegod_vault_ledger_events SET payload=(previous_event-'baseFill')||jsonb_build_object('source',c->>'source')||CASE WHEN c ? 'baseFill' THEN jsonb_build_object('baseFill',c->'baseFill') ELSE '{}' END WHERE scope=p_scope AND id=c->>'eventId';
 END LOOP;
 INSERT INTO public.musegod_vault_ledger_state VALUES(p_scope,expected+1,next_state) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,payload=excluded.payload;
 RETURN next_state;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
