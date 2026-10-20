import assert from "node:assert/strict";
import type { PostCommand, PostResult, PostKeyRecord, PostRecord } from "../../server/post-store";
export const TOKEN=`0x${"1".repeat(40)}`,OTHER=`0x${"2".repeat(40)}`,NOW=1_800_000_000_000;
export const keyRecord=(id="key-1",token=TOKEN,now=NOW):PostKeyRecord=>({id,token,issuer:`0x${"3".repeat(40)}`,name:"Agent",hash:"a".repeat(64),prefix:"mgp_test",createdAt:now,expiresAt:now+30*86_400_000,revokedAt:null});
export const postRecord=(id="post-1",token=TOKEN,keyId="key-1",now=NOW):PostRecord=>({id,token,keyId,text:"Hello",imageIds:[],images:[],videoUrl:null,createdAt:now,deletedAt:null});
export async function exercisePostStore(run:(c:PostCommand)=>PostResult|Promise<PostResult>){
 const key=keyRecord();
 assert.equal((await run({action:"keyCreate",row:key})).key?.id,key.id);
 assert.equal((await run({action:"keyCreate",row:key})).error?.code,"POST_KEY_EXISTS");
 assert.deepEqual(await run({action:"keyGet",token:OTHER,id:key.id}),{});
 for(let i=2;i<=5;i++)assert.equal((await run({action:"keyCreate",row:keyRecord(`key-${i}`)})).error,undefined);
 assert.equal((await run({action:"keyCreate",row:keyRecord("key-6")})).error?.code,"POST_KEY_LIMIT");
 await run({action:"keyRevoke",token:TOKEN,id:"key-5",now:NOW});
 assert.equal((await run({action:"keyCreate",row:keyRecord("key-6")})).error,undefined);
 const first:PostCommand={action:"postCreate",token:TOKEN,keyId:key.id,post:postRecord(),idempotencyKey:"first",requestHash:"b".repeat(64),now:NOW};
 assert.equal((await run(first)).post?.id,"post-1");
 assert.equal((await run(first)).duplicate,true);
 assert.equal((await run({...first,requestHash:"c".repeat(64)})).error?.code,"POST_IDEMPOTENCY_CONFLICT");
 assert.equal((await run({...first,token:OTHER})).error?.status,401);
 assert.equal((await run({action:"postDelete",token:TOKEN,postId:"post-1",now:NOW+1})).deleted,true);
 assert.equal((await run(first)).post?.deletedAt,NOW+1);
 assert.equal((await run({action:"postsList",token:TOKEN,limit:20})).posts?.length,0);
 await run({action:"keyRevoke",token:TOKEN,id:key.id,now:NOW+2});
 assert.equal((await run(first)).error?.status,401,"idempotency never bypasses current key authority");
 assert.equal((await run({...first,keyId:"key-2",post:postRecord("post-2",TOKEN,"key-2"),idempotencyKey:"second"})).error,undefined);
 assert.equal((await run({...first,keyId:"key-3",post:postRecord("post-3",TOKEN,"key-3"),idempotencyKey:"third"})).error?.status,429,"token post rate spans keys");
 const later=NOW+60_000;
 const p=postRecord("post-3",TOKEN,"key-3",later);
 assert.equal((await run({...first,keyId:"key-3",post:p,idempotencyKey:"third",now:later})).error,undefined);
 const id="d".repeat(64),reserve:PostCommand={action:"mediaReserve",token:TOKEN,keyId:"key-2",id,leaseId:"lease-1",now:later};
 assert.equal((await run(reserve)).media?.state,"pending");
 assert.equal((await run(reserve)).error?.code,"POST_MEDIA_PENDING");
 await run({action:"mediaFail",token:TOKEN,id,leaseId:"wrong"});
 assert.equal((await run(reserve)).error?.code,"POST_MEDIA_PENDING");
 await run({action:"mediaFail",token:TOKEN,id,leaseId:"lease-1"});
 assert.equal((await run({...reserve,leaseId:"lease-2"})).media?.leaseId,"lease-2");
 assert.equal((await run({action:"mediaComplete",token:TOKEN,keyId:"key-2",id,leaseId:"lease-1",url:"https://example.org/image.webp",now:later})).error?.code,"POST_MEDIA_LEASE");
 const complete:PostCommand={action:"mediaComplete",token:TOKEN,keyId:"key-2",id,leaseId:"lease-2",url:"https://example.org/image.webp",now:later};
 assert.equal((await run(complete)).media?.state,"ready");
 assert.equal((await run(reserve)).duplicate,true);
 const withImage=postRecord("image-post",TOKEN,"key-2",later);withImage.imageIds=[id];withImage.images=[{id,url:"https://tampered.invalid"}];
 const saved=await run({...first,keyId:"key-2",post:withImage,idempotencyKey:"image-post",now:later});
 assert.deepEqual(saved.post?.images,[{id,url:"https://example.org/image.webp"}],"image URLs come from ready token media");
 await run({action:"keyRevoke",token:TOKEN,id:"key-2",now:later});
 assert.equal((await run(complete)).error?.status,401,"media completion rechecks revocation");
 const page=(await run({action:"postsList",token:TOKEN,limit:1})).posts!;assert.equal(page.length,1);
 const next=(await run({action:"postsList",token:TOKEN,limit:20,before:{createdAt:page[0].createdAt,id:page[0].id}})).posts!;
 assert(!next.some(p=>p.id===page[0].id));
 // Every attempted retry consumes a day slot, even if Pinata did not provide an answer.
 const retryToken=`0x${"4".repeat(40)}`,retryKey=keyRecord("retry-key",retryToken);await run({action:"keyCreate",row:retryKey});
 for(let i=0;i<10;i++){
  const r=await run({action:"mediaReserve",token:retryToken,keyId:retryKey.id,id,leaseId:String(i),now:NOW+i*60_000});assert.equal(r.error,undefined);
  await run({action:"mediaFail",token:retryToken,id,leaseId:String(i)});
 }
 assert.equal((await run({action:"mediaReserve",token:retryToken,keyId:retryKey.id,id,leaseId:"last",now:NOW+11*60_000})).error?.status,429);
 // A refusal known to precede any upload releases its token and shared day slots: 55 cycles pass both the 10 and 50 caps.
 const releaseToken=`0x${"5".repeat(40)}`,releaseKey=keyRecord("release-key",releaseToken);await run({action:"keyCreate",row:releaseKey});
 for(let i=0;i<55;i++){
  const at=NOW+i*60_000;
  assert.equal((await run({action:"mediaReserve",token:releaseToken,keyId:releaseKey.id,id,leaseId:`r${i}`,now:at})).error,undefined,`release cycle ${i}`);
  assert.equal((await run({action:"mediaRelease",token:releaseToken,id,leaseId:"other",now:at})).media?.state,"pending","another lease cannot release");
  assert.equal((await run({action:"mediaRelease",token:releaseToken,id,leaseId:`r${i}`,now:at})).media?.state,"failed");
  assert.equal((await run({action:"mediaRelease",token:releaseToken,id,leaseId:`r${i}`,now:at})).media?.state,"failed","a second release refunds nothing");
 }
}
