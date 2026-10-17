BEGIN;

-- Coin profiles (owner-signed social links, tasks/token-ip-detail-plan.md §5) are stored in musegod_snapshots under keys
-- `profile:<lowercased coin address>`, beside the persistent `pinata:` and `buyback:index:` records. Like those, they are records,
-- not caches, so cleanup must keep them. This replaces musegod_cleanup with the same body plus that exclusion; its signature,
-- SECURITY INVOKER, search_path and grants are unchanged (docs/evidence/database-schema.json stays valid).
-- Apply before releasing the token profile editor; until then a profile would be deleted a day after it was saved.
CREATE OR REPLACE FUNCTION public.musegod_cleanup(p_scope text,p_now bigint)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 DELETE FROM public.musegod_snapshots WHERE scope=p_scope AND at<p_now-86400000 AND key NOT LIKE 'pinata:%' AND key NOT LIKE 'buyback:index:%' AND key NOT LIKE 'profile:%';
 DELETE FROM public.musegod_quota WHERE scope=p_scope AND key<to_char(to_timestamp((p_now-8640000000)/1000.0) at time zone 'UTC','YYYY-MM');
 DELETE FROM public.musegod_pending_launches WHERE scope=p_scope AND status IN ('failed','replaced') AND updated_at<p_now-2592000000;
 DELETE FROM public.musegod_plans p WHERE scope=p_scope AND protected_at IS NULL AND prepared_at<p_now-2592000000 AND NOT EXISTS(SELECT 1 FROM public.musegod_pending_launches q WHERE q.scope=p.scope AND q.plan_id=p.id);
END $$;
REVOKE ALL ON FUNCTION public.musegod_cleanup(text,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.musegod_cleanup(text,bigint) TO service_role;

COMMIT;
