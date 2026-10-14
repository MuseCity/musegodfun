BEGIN;

-- NFT mode's two single-use rules, enforced by the database for every writer (each server runtime and `npm run nft:reverify`):
-- one launch-fee payment funds one coin, and each NFT has at most one `verified` coin. Scoped like every musegod table.
-- The expressions are exactly the predicates of SupabaseStore.tokenUsingLaunchFee and SupabaseStore.verifiedNftCoin
-- (server/supabase-store.ts). A `launchFee` is stored only after it verified as sent by the coin's creator, so the hash alone
-- names its payer. `->>` reads nft.chainId (a JSON number) as text, exactly as the `payload->nft->>chainId=eq.<id>` filter does.
-- PostgREST answers a refused write with 409 and code 23505; the server recognises these two index names only
-- (TOKEN_UNIQUE_INDEXES in server/store.ts): registration settles the coin rejected, the CLI reports CONFLICT.
-- Production has no NFT records yet (NFT mode has never been enabled), so building these indexes cannot fail on existing rows.
-- Apply before enabling NFT mode.
CREATE UNIQUE INDEX musegod_tokens_launch_fee_once ON public.musegod_tokens
  (scope, lower(payload->'launchFee'->>'txHash'))
  WHERE payload->'launchFee'->>'txHash' IS NOT NULL;
CREATE UNIQUE INDEX musegod_tokens_nft_verified_once ON public.musegod_tokens
  (scope, (payload->'nft'->>'chainId'), lower(payload->'nft'->>'contract'), (payload->'nft'->>'tokenId'))
  WHERE payload->'nftVerification'->>'status' = 'verified';

-- The indexes refuse a second spend only at registration, after both creations are on-chain. Before a real signature the server
-- therefore claims the NFT (`nft:<chainId>:<contract>:<tokenId>`) and, for a paid NFT, the fee (`fee:<lowercased tx hash>`) for the
-- launch (LaunchpadService.validateLaunch; Store.claimLaunch in SQLite). The owner is the plan's launch intent with its creator, which every
-- refresh of the plan keeps (a plan without one owns its claims by its id). One call claims all of them or none, under a per-scope lock,
-- so two owners can never both hold a key. It answers the claims another owner still holds (empty: granted). The same owner renews its
-- own claims, and an expired claim is anyone's. Registration deletes the owner's claims (PostgREST DELETE by scope and owner) and never
-- reads them.
CREATE TABLE public.musegod_launch_claims (
  scope text NOT NULL,
  claim text NOT NULL CHECK (claim ~ '^(nft|fee):' AND length(claim) <= 204),
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 200),
  expires_at bigint NOT NULL,
  PRIMARY KEY (scope, claim)
);
CREATE INDEX musegod_launch_claims_owner ON public.musegod_launch_claims(scope, owner);
ALTER TABLE public.musegod_launch_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.musegod_launch_claims FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.musegod_launch_claims TO service_role;
CREATE FUNCTION public.musegod_claim_launch(p_scope text,p_owner text,p_claims text[],p_expires_at bigint,p_now bigint)
RETURNS text[] LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE held text[];
BEGIN
 IF p_scope IS NULL OR p_scope !~ '^(base|robinhood|verify-[a-z0-9-]+|restore-[a-z0-9-]+)$' OR p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200
  OR coalesce(cardinality(p_claims),0) NOT BETWEEN 1 AND 2 OR array_position(p_claims,NULL) IS NOT NULL
  OR EXISTS(SELECT 1 FROM unnest(p_claims) c WHERE c !~ '^(nft|fee):' OR length(c) > 204)
  OR (SELECT count(DISTINCT c) FROM unnest(p_claims) c) <> cardinality(p_claims)
  OR p_now IS NULL OR p_now < 0 OR p_expires_at IS NULL OR p_expires_at <= p_now THEN RAISE EXCEPTION 'Invalid launch claim'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('musegod_launch_claims:'||p_scope,0));
 DELETE FROM public.musegod_launch_claims WHERE scope=p_scope AND expires_at<=p_now;
 SELECT coalesce(array_agg(claim ORDER BY claim),'{}') INTO held FROM public.musegod_launch_claims
  WHERE scope=p_scope AND claim=ANY(p_claims) AND owner<>p_owner;
 IF cardinality(held) > 0 THEN RETURN held; END IF;
 INSERT INTO public.musegod_launch_claims SELECT p_scope,c,p_owner,p_expires_at FROM unnest(p_claims) c
  ON CONFLICT(scope,claim) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at;
 RETURN '{}';
END $$;
REVOKE ALL ON FUNCTION public.musegod_claim_launch(text,text,text[],bigint,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.musegod_claim_launch(text,text,text[],bigint,bigint) TO service_role;

-- The runtime reports NFT mode enabled, and `nft:reverify` runs, only while both guards exist, unique and valid, together with the
-- launch-claim table and function. A project without this migration answers 404 for the function, which the server also reads as not
-- ready: NFT mode fails closed.
CREATE FUNCTION public.musegod_nft_guards_ready()
RETURNS boolean LANGUAGE sql STABLE SET search_path TO '' AS $$
  SELECT count(*) = 2
    AND pg_catalog.to_regclass('public.musegod_launch_claims') IS NOT NULL
    AND pg_catalog.to_regprocedure('public.musegod_claim_launch(text,text,text[],bigint,bigint)') IS NOT NULL
  FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
  WHERE i.indrelid = 'public.musegod_tokens'::pg_catalog.regclass AND i.indisunique AND i.indisvalid
    AND c.relname IN ('musegod_tokens_launch_fee_once', 'musegod_tokens_nft_verified_once')
$$;
REVOKE ALL ON FUNCTION public.musegod_nft_guards_ready() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.musegod_nft_guards_ready() TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
