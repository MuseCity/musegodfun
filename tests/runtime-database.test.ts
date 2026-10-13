import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const postgresImage="postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
let dockerAvailable=false;
try {execFileSync("docker",["image","inspect",postgresImage],{stdio:"ignore"});dockerAvailable=true;}catch{}
test("runtime migration enforces service-only control, shared quotas and compatible recovery restore, and the NFT single-use guards",{skip:!dockerAvailable,timeout:30_000},()=>{
  let container="";
  const sql=(source:string)=>execFileSync("docker",["exec","-i",container,"psql","-U","postgres","-X","-v","ON_ERROR_STOP=1"],{encoding:"utf8",input:source,stdio:["pipe","pipe","pipe"]});
  try {
    // A disposable, network-isolated database; no host port, mounted data or production credentials.
    container=execFileSync("docker",["run","--detach","--rm","--network","none","--tmpfs","/var/lib/postgresql/data","--env","POSTGRES_HOST_AUTH_METHOD=trust",postgresImage,"-c","listen_addresses="],{encoding:"utf8"}).trim();
    execFileSync("docker",["exec",container,"sh","-c","for i in $(seq 1 100); do test \"$(cat /proc/1/comm)\" = postgres && pg_isready -U postgres >/dev/null && exit 0; sleep 0.1; done; exit 1"],{stdio:"pipe"});
    sql("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
    for(const migration of ["20261005000537_musegod_store.sql","20261007094402_runtime_safety_controls.sql","20261014120000_nft_single_use_indexes.sql"])
      sql(readFileSync(`supabase/migrations/${migration}`,"utf8"));
    sql(`SET ROLE service_role;
      DO $$ BEGIN IF NOT (SELECT paused FROM public.musegod_runtime_controls WHERE scope='robinhood') THEN RAISE EXCEPTION 'default must pause'; END IF; END $$;
      SELECT public.musegod_update_runtime_control('robinhood',false,'local fixture',0);
      SELECT public.musegod_update_runtime_control('robinhood',true,'incident fixture',1);
      DO $$ BEGIN BEGIN PERFORM public.musegod_update_runtime_control('robinhood',false,'stale',0); RAISE EXCEPTION 'CAS failed'; EXCEPTION WHEN raise_exception THEN IF SQLERRM='CAS failed' THEN RAISE; END IF; END; END $$;
      DO $$ DECLARE r jsonb; BEGIN FOR i IN 1..64 LOOP r:=public.musegod_reserve_runtime_budget('lifi',1000000,false); IF NOT (r->>'allowed')::boolean THEN RAISE EXCEPTION 'early budget denial'; END IF; END LOOP; IF (public.musegod_reserve_runtime_budget('lifi',1000000,false)->>'allowed')::boolean THEN RAISE EXCEPTION 'budget exceeded'; END IF; IF NOT (public.musegod_reserve_runtime_budget('lifi',1000000,true)->>'allowed')::boolean THEN RAISE EXCEPTION 'missing recovery reserve'; END IF; END $$;
      SELECT public.musegod_block_runtime_budget('lifi',1090000);
      DO $$ BEGIN IF (public.musegod_reserve_runtime_budget('lifi',1061000,true)->>'allowed')::boolean THEN RAISE EXCEPTION 'circuit bypass'; END IF; END $$;
      DO $$ BEGIN
        FOR i IN 1..4 LOOP IF NOT public.musegod_reserve_prepare_slot(('00000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,1000000) THEN RAISE EXCEPTION 'early slot denial'; END IF; END LOOP;
        IF public.musegod_reserve_prepare_slot('00000000-0000-0000-0000-000000000005',1000000) THEN RAISE EXCEPTION 'slot limit bypass'; END IF;
        IF NOT public.musegod_reserve_prepare_slot('00000000-0000-0000-0000-000000000001',1100000) THEN RAISE EXCEPTION 'slot renewal failed'; END IF;
        IF NOT public.musegod_reserve_prepare_slot('00000000-0000-0000-0000-000000000005',1240001) THEN RAISE EXCEPTION 'expired slots not released'; END IF;
      END $$;
      INSERT INTO public.musegod_plans(scope,id,creator,data,prepared_at,payload,protected_at) VALUES('base','plan','creator','data',1,'{}',10);
      INSERT INTO public.musegod_pending_launches(scope,hash,plan_id,status,updated_at,retry_at,attempts,finalized) VALUES('base','tx','plan','confirmed',1,20,3,true);
      SELECT public.musegod_restore('restore-fixture',public.musegod_backup('base'));
      DO $$ BEGIN IF (SELECT protected_at FROM public.musegod_plans WHERE scope='restore-fixture' AND id='plan')<>10 THEN RAISE EXCEPTION 'protected plan lost'; END IF; IF NOT (SELECT finalized FROM public.musegod_pending_launches WHERE scope='restore-fixture' AND hash='tx') THEN RAISE EXCEPTION 'queue state lost'; END IF; END $$;
      RESET ROLE; SET ROLE anon;
      DO $$ BEGIN BEGIN PERFORM * FROM public.musegod_runtime_controls; RAISE EXCEPTION 'public table access'; EXCEPTION WHEN insufficient_privilege THEN NULL; END; BEGIN PERFORM public.musegod_update_runtime_control('robinhood',false,'attack',2); RAISE EXCEPTION 'public function access'; EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $$;
      RESET ROLE; SET ROLE authenticated;
      DO $$ BEGIN BEGIN PERFORM public.musegod_reserve_runtime_budget('lifi',1000000,true); RAISE EXCEPTION 'public budget access'; EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $$;
      RESET ROLE;`);
    const rls=sql("SELECT bool_and(relrowsecurity) FROM pg_class WHERE relname IN ('musegod_runtime_controls','musegod_runtime_budget','musegod_runtime_circuit','musegod_prepare_slots');");
    assert.match(rls,/\bt\b/);
    // NFT single-use guards (20261014120000): each index refuses exactly what the store lookups treat as equal, per scope, and the readiness
    // function sees both, is service-only, and reports a missing guard.
    sql(`SET ROLE service_role;
      DO $$ BEGIN IF public.musegod_nft_guards_ready() IS NOT TRUE THEN RAISE EXCEPTION 'guards not ready'; END IF; END $$;
      INSERT INTO public.musegod_tokens VALUES('base','0xa1','0xt1',1,'{"launchFee":{"asset":"stable","txHash":"0xAB"},"nft":{"chainId":4663,"contract":"0xC0","tokenId":"1"},"nftVerification":{"status":"verified"}}');
      INSERT INTO public.musegod_tokens VALUES('base','0xa1','0xt1',1,'{"launchFee":{"asset":"stable","txHash":"0xAB"},"nft":{"chainId":4663,"contract":"0xC0","tokenId":"1"},"nftVerification":{"status":"verified"}}') ON CONFLICT(scope,address) DO NOTHING;
      DO $$ BEGIN
        BEGIN INSERT INTO public.musegod_tokens VALUES('base','0xa2','0xt2',2,'{"launchFee":{"asset":"stable","txHash":"0xab"}}') ON CONFLICT(scope,address) DO NOTHING; RAISE EXCEPTION 'fee spent twice';
        EXCEPTION WHEN unique_violation THEN IF SQLERRM NOT LIKE '%"musegod_tokens_launch_fee_once"%' THEN RAISE; END IF; END;
        BEGIN INSERT INTO public.musegod_tokens VALUES('base','0xa3','0xt3',3,'{"nft":{"chainId":4663,"contract":"0xc0","tokenId":"1"},"nftVerification":{"status":"verified"}}'); RAISE EXCEPTION 'second verified coin';
        EXCEPTION WHEN unique_violation THEN IF SQLERRM NOT LIKE '%"musegod_tokens_nft_verified_once"%' THEN RAISE; END IF; END;
      END $$;
      INSERT INTO public.musegod_tokens VALUES('base','0xa4','0xt4',4,'{"nft":{"chainId":4663,"contract":"0xc0","tokenId":"1"},"nftVerification":{"status":"rejected","reason":"already_launched"}}');
      INSERT INTO public.musegod_tokens VALUES('base','0xa5','0xt5',5,'{"nft":{"chainId":4663,"contract":"0xC0","tokenId":"1"},"nftVerification":{"status":"unverified","reason":"fee_unconfirmed","feeClaim":{"asset":"stable","txHash":"0xab"}}}');
      INSERT INTO public.musegod_tokens VALUES('base','0xa6','0xt6',6,'{"nft":{"chainId":4663,"contract":"0xc0","tokenId":"2"},"nftVerification":{"status":"verified"}}');
      DO $$ BEGIN
        BEGIN UPDATE public.musegod_tokens SET payload=jsonb_set(payload,'{nftVerification}','{"status":"verified"}') WHERE scope='base' AND address='0xa5'; RAISE EXCEPTION 'verified by compare-and-swap';
        EXCEPTION WHEN unique_violation THEN NULL; END;
      END $$;
      INSERT INTO public.musegod_tokens VALUES('verify-other','0xa1','0xt1',1,'{"launchFee":{"asset":"stable","txHash":"0xab"},"nft":{"chainId":4663,"contract":"0xc0","tokenId":"1"},"nftVerification":{"status":"verified"}}');
      DO $$ BEGIN IF (SELECT count(*) FROM public.musegod_tokens) <> 5 THEN RAISE EXCEPTION 'unexpected token rows'; END IF; END $$;
      RESET ROLE; SET ROLE anon;
      DO $$ BEGIN BEGIN PERFORM public.musegod_nft_guards_ready(); RAISE EXCEPTION 'public guard function'; EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $$;
      RESET ROLE;
      BEGIN; DROP INDEX public.musegod_tokens_nft_verified_once;
      DO $$ BEGIN IF public.musegod_nft_guards_ready() THEN RAISE EXCEPTION 'a missing guard was not reported'; END IF; END $$;
      ROLLBACK;
      SET ROLE service_role;
      DO $$ BEGIN IF public.musegod_nft_guards_ready() IS NOT TRUE THEN RAISE EXCEPTION 'guards lost'; END IF; END $$;
      RESET ROLE;`);
  }finally{
    if(container)try{execFileSync("docker",["rm","-f",container],{stdio:"ignore"});}catch{}
  }
});
