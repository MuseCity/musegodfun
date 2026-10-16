import {clientBucket} from './abuse';
/** Pending admissions count before pool lookup can yield; accepted sockets are counted by the host. */
export class StreamAdmission{
 private pending=new Map<string,number>();private total=0;
 reserve(ip:string,accepted:string[]){const key=clientBucket(ip);if(accepted.length+this.total>=128||accepted.filter(x=>clientBucket(x)===key).length+(this.pending.get(key)??0)>=8)return null;
  this.total++;this.pending.set(key,(this.pending.get(key)??0)+1);let done=false;
  return ()=>{if(done)return;done=true;this.total--;const n=this.pending.get(key)!-1;if(n)this.pending.set(key,n);else this.pending.delete(key);};
 }
}
