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

-- The runtime reports NFT mode enabled, and `nft:reverify` runs, only while both guards exist, unique and valid. A project without
-- this migration answers 404 for the function, which the server also reads as not ready: NFT mode fails closed.
CREATE FUNCTION public.musegod_nft_guards_ready()
RETURNS boolean LANGUAGE sql STABLE SET search_path TO '' AS $$
  SELECT count(*) = 2 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
  WHERE i.indrelid = 'public.musegod_tokens'::pg_catalog.regclass AND i.indisunique AND i.indisvalid
    AND c.relname IN ('musegod_tokens_launch_fee_once', 'musegod_tokens_nft_verified_once')
$$;
REVOKE ALL ON FUNCTION public.musegod_nft_guards_ready() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.musegod_nft_guards_ready() TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
