// Web Push for 30 Days of…; only generic reminder kinds are carried in the payload.
const enc=new TextEncoder();
const LIMIT=15*60000, HORIZON=31*86400000, TEST_DELAY=60000, TEST_WINDOW=3*60000;
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const jwtPart=v=>b64(enc.encode(JSON.stringify(v)));

function authorized(request,secret){
 if(!/^[a-f0-9]{64}$/.test(secret||''))return false;
 const received=request.headers.get('Authorization')||'', expected='Bearer '+secret;
 if(received.length!==expected.length)return false;
 let diff=0;
 for(let i=0;i<expected.length;i++)diff|=received.charCodeAt(i)^expected.charCodeAt(i);
 return diff===0;
}
export function pushEndpoint(raw){
 if(typeof raw!=='string'||raw.length>2048)throw Error('Invalid push endpoint.');
 const u=new URL(raw);
 const allowed=u.hostname==='fcm.googleapis.com'||u.hostname==='updates.push.services.mozilla.com'||u.hostname==='push.services.mozilla.com'||u.hostname.endsWith('.push.apple.com')||u.hostname==='web.push.apple.com'||u.hostname==='wns.windows.com'||u.hostname.endsWith('.notify.windows.com');
 if(!allowed||u.protocol!=='https:'||u.port||u.username||u.password||u.hash||u.pathname==='/')throw Error('This browser’s push service is not supported.');
 return u;
}
const unb64=s=>Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/').padEnd(Math.ceil(s.length/4)*4,'=')),c=>c.charCodeAt(0));
const join=(...values)=>{const out=new Uint8Array(values.reduce((n,v)=>n+v.length,0));let i=0;for(const v of values){out.set(v,i);i+=v.length;}return out;};
async function hkdf(secret,salt,info,bits){
 const key=await crypto.subtle.importKey('raw',secret,'HKDF',false,['deriveBits']);
 return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},key,bits));
}
// RFC 8291 (Web Push) using the RFC 8188 aes128gcm single final record format.
export async function encodePush(keys,payload){
 const curve={name:'ECDH',namedCurve:'P-256'},salt=crypto.getRandomValues(new Uint8Array(16)),ua=unb64(keys.p256dh);
 const client=await crypto.subtle.importKey('raw',ua,curve,false,[]);
 const server=await crypto.subtle.generateKey(curve,true,['deriveBits']);
 const as=new Uint8Array(await crypto.subtle.exportKey('raw',server.publicKey));
 const shared=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:client},server.privateKey,256));
 const ikm=await hkdf(shared,unb64(keys.auth),join(enc.encode('WebPush: info\0'),ua,as),256);
 const cek=await hkdf(ikm,salt,enc.encode('Content-Encoding: aes128gcm\0'),128);
 const iv=await hkdf(ikm,salt,enc.encode('Content-Encoding: nonce\0'),96);
 const key=await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['encrypt']);
 const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,join(enc.encode(JSON.stringify(payload)),Uint8Array.of(2))));
 const recordSize=new Uint8Array(4);new DataView(recordSize.buffer).setUint32(0,4096);
 return join(salt,recordSize,Uint8Array.of(as.length),as,cipher);
}
export async function vapidRequest(subscription,env,kind,{now=Date.now(),ttl=90}={}){
 const u=pushEndpoint(subscription.endpoint);
 const key=await crypto.subtle.importKey('jwk',JSON.parse(env.VAPID_PRIVATE_JWK),{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
 const jwt=jwtPart({typ:'JWT',alg:'ES256'})+'.'+jwtPart({aud:u.origin,exp:Math.floor(now/1000)+12*3600,sub:env.VAPID_SUBJECT});
 const sig=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,enc.encode(jwt));
 // Cloudflare Workers require manual to reject redirects without forwarding VAPID credentials.
 return new Request(u,{method:'POST',redirect:'manual',headers:{
  Authorization:'vapid t='+jwt+'.'+b64(sig)+', k='+env.VAPID_PUBLIC_KEY,TTL:String(ttl),Urgency:kind==='test'?'normal':'high',
  'Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream',Topic:'thirty-days-'+kind
 },body:await encodePush(subscription.keys,{kind})});
}
function normalizeSubscription(subscription){
 const keys=subscription?.keys||{}, endpoint=pushEndpoint(subscription?.endpoint).href;
 if(!/^[A-Za-z0-9_-]{87}$/.test(keys.p256dh||'')||!/^[A-Za-z0-9_-]{22}$/.test(keys.auth||'')||unb64(keys.p256dh)[0]!==4)throw Error('Invalid subscription keys.');
 return {endpoint,keys:{p256dh:keys.p256dh,auth:keys.auth}};
}
export function validateSchedule(raw,now=Date.now()){
 if(!Array.isArray(raw?.jobs)||raw.jobs.length>60)throw Error('Invalid schedule size.');
 const subscription=normalizeSubscription(raw.subscription);
 const ids=new Set(),jobs=[];
 for(const j of raw.jobs){
  if(!/^\d{4}-\d{2}-\d{2}-(daily|incomplete)$/.test(j?.id||'')||ids.has(j.id)||!Number.isSafeInteger(j.due)||j.due>now+HORIZON||!Number.isSafeInteger(j.until)||j.until<=j.due||j.until-j.due>LIMIT)throw Error('Invalid reminder time or ID.');
  ids.add(j.id);if(j.until>now)jobs.push({id:j.id,due:j.due,until:j.until});
 }
 jobs.sort((a,b)=>a.due-b.due||a.id.localeCompare(b.id));
 return {subscription,jobs};
}
function response(status,body){return body===undefined?new Response(null,{status}):Response.json(body,{status});}
function cors(r,origin){
 const out=new Response(r.body,r);
 out.headers.set('Access-Control-Allow-Origin',origin);
 out.headers.set('Access-Control-Allow-Methods','GET, PUT, POST, DELETE, OPTIONS');
 out.headers.set('Access-Control-Allow-Headers','Authorization, Content-Type');
 out.headers.set('Cache-Control','no-store');
 out.headers.set('Vary','Origin');
 return out;
}
export default {
 async fetch(request,env){
  const origin=request.headers.get('Origin'), path=new URL(request.url).pathname;
  if(origin!==env.APP_ORIGIN)return response(403);
  const reply=(status,data)=>cors(response(status,data),origin);
  if(request.method==='OPTIONS')return reply(204);
  if(!authorized(request,env.PAIRING_KEY))return reply(401,{error:'Check the pairing key.'});
  if(!/^[A-Za-z0-9_-]{87}$/.test(env.VAPID_PUBLIC_KEY||'')||!env.VAPID_PRIVATE_JWK||!/^mailto:[^\s@]+@[^\s@]+$/.test(env.VAPID_SUBJECT||''))return reply(503,{error:'The reminder service is not fully configured.'});
  if(path==='/v1/config'&&request.method==='GET')return reply(200,{app:'thirty-days-of',publicKey:env.VAPID_PUBLIC_KEY,testPush:true,scheduleDiagnostics:true});
  const match=/^\/v1\/device\/([0-9a-f]{32})(\/scheduled-test)?$/.exec(path);
  const method=request.method,timed=!!match?.[2];
  if(!match||!(timed?method==='POST':['GET','PUT','POST','DELETE'].includes(method)))return reply(404);
  const stub=env.REMINDERS.get(env.REMINDERS.idFromName(match[1]));
  const forward=async(route,options)=>{
   try{return cors(await stub.fetch('https://internal/'+route,options),origin);}
   catch{return reply(503,{error:'The Worker could not reach its reminder queue. Try Sync now again.'});}
  };
  if(method==='GET')return forward('status');
  if(method==='DELETE')return forward('cancel',{method:'DELETE'});

  // Read at most 12 KiB even when Content-Length is missing.
  try{
   if(!request.body)return reply(400,{error:'Missing schedule.'});
   const reader=request.body.getReader(), chunks=[];let n=0;
   for(;;){const x=await reader.read();if(x.done)break;n+=x.value.length;if(n>12288){await reader.cancel();return reply(413);}chunks.push(x.value);}
   const bytes=new Uint8Array(n);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   const data=JSON.parse(new TextDecoder().decode(bytes));
   if(method==='POST'){
    const subscription=normalizeSubscription(data);
    return forward(timed?'scheduled-test':'test',{method:'POST',body:JSON.stringify(subscription)});
   }
   const normalized=validateSchedule(data);
   return forward(data.report===true?'schedule-report':'schedule',{method:'PUT',body:JSON.stringify(normalized)});
  }catch{return reply(400,{error:'Invalid browser push subscription or reminder time.'});}
 }
};

export class ChallengeReminders{
 constructor(ctx,env){this.storage=ctx.storage;this.env=env;this.tail=Promise.resolve();}
 // Serialize queue updates and alarm dispatch on this device. A provider fetch yields;
 // without this, an overlapping sync can restore canceled jobs or undo a retry.
 run(action){
  const next=this.tail.then(action);
  this.tail=next.catch(()=>{});
  return next;
 }
 async report(){
  const now=Date.now(),[plan,test,last,lastTest,alarm]=await Promise.all([
   this.storage.get('plan'),this.storage.get('scheduledTest'),this.storage.get('lastDelivery'),
   this.storage.get('lastScheduledTest'),this.storage.getAlarm()
  ]);
  const jobs=(plan?.jobs||[]).filter(j=>j.until>now);
  const next=jobs[0];
  return {queued:jobs.length,next:next?{
   due:next.due,...(next.retryAt?{retryAt:next.retryAt}:{}),kind:jobs.some(j=>j.due===next.due&&j.id.endsWith('-incomplete'))?'incomplete':'daily'
  }:null,alarm,serverTime:now,last:last||null,test:test?{due:test.due}:lastTest||null};
 }
 async write(plan,sent,now=Date.now()){
  const jobs=(plan?.jobs||[]).filter(j=>j.until>now&&!sent[j.id]);
  const test=await this.storage.get('scheduledTest');
  const next=Math.min(jobs[0]?Math.max(jobs[0].due,jobs[0].retryAt||0):Infinity,
   test?Math.max(test.due,test.retryAt||0):Infinity,...Object.values(sent));
  // Commit queue and its alarm together. No alarm means nothing remains to deliver or expire.
  await Promise.all([
   jobs.length?this.storage.put('plan',{...plan,jobs}):this.storage.delete('plan'),
   Number.isFinite(next)?this.storage.setAlarm(Math.max(next,now+1)):this.storage.deleteAlarm()
  ]);
 }
 async marks(now=Date.now()){
  const current=await this.storage.get('sent')||{};
  return Object.fromEntries(Object.entries(current).filter(([,until])=>until>now));
 }
 async fetch(request){
  const route=new URL(request.url).pathname;
  // An immediate diagnostic is deliberately independent of the reminder queue.
  if(request.method==='POST'&&route==='/test')return this.test(await request.json());
  return this.run(async()=>{
   if(request.method==='GET'&&route==='/status')return response(200,await this.report());
   const now=Date.now(),sent=await this.marks(now);
   if(request.method==='POST'&&route==='/scheduled-test'){
    const existing=await this.storage.get('scheduledTest');
    if(existing&&existing.until>now)return response(429,{error:'A scheduled test is already pending. Check its status after it runs.'});
    const subscription=await request.json(),due=now+TEST_DELAY;
    await this.storage.put('scheduledTest',{subscription,due,until:due+TEST_WINDOW});
    await this.write(await this.storage.get('plan'),sent,now);
    return response(200,{due});
   }
   if(request.method==='DELETE'){
    await Promise.all(['scheduledTest','lastScheduledTest','lastDelivery'].map(key=>this.storage.delete(key)));
    await this.write(null,sent,now);return response(204);
   }
   const plan=await request.json(),existing=await this.storage.get('plan');
   // A periodic sync must not wipe retry backoff for the same unchanged job.
   if(existing?.subscription?.endpoint===plan.subscription.endpoint){
    for(const job of plan.jobs){
     const old=existing.jobs.find(j=>j.id===job.id&&j.due===job.due&&j.until===job.until);
     if(old?.retryAt)Object.assign(job,{retryAt:old.retryAt,attempt:old.attempt});
    }
   }
   // Keep the last missed job visible even if a new sync wins the race with a late alarm.
   await this.recordExpired(existing,now);
   await this.write(plan,sent,now);
   return route==='/schedule-report'?response(200,await this.report()):response(204);
  });
 }
 async send(subscription,kind,now,until){
  let request;
  try{request=await vapidRequest(subscription,this.env,kind,{
   now,ttl:until?Math.max(1,Math.floor((until-now)/1000)):90
  });}
  catch{return {status:'prepare-failed'};}
  try{
   const reply=await fetch(request,{signal:AbortSignal.timeout(8000)});
   if(reply.ok)return {status:'accepted',http:reply.status};
   if(reply.status===404||reply.status===410)return {status:'subscription-expired',http:reply.status};
   return {status:reply.status===429||reply.status>=500?'temporary-failure':'provider-rejected',http:reply.status};
  }catch{return {status:'temporary-failure'};}
 }
 async test(subscription){
  const now=Date.now();
  if((await this.storage.get('testAfter')||0)>now)return response(429,{error:'Wait 30 seconds between test pushes.'});
  await this.storage.put('testAfter',now+30000);
  const result=await this.send(subscription,'test',now);
  if(result.status==='accepted')return response(204);
  if(result.status==='prepare-failed')return response(502,{error:'The reminder server could not prepare an encrypted test push. Check the Worker and its signing configuration.'});
  if(result.status==='subscription-expired')return response(409,{error:'The browser subscription has expired. Disconnect push and connect again, then try again.'});
  if(result.http)return response(502,{error:'The push provider rejected the test (HTTP '+result.http+').'});
  return response(502,{error:'Could not reach the push provider. Try again in 30 seconds.'});
 }
 async recordExpired(plan,now){
  const expired=plan?.jobs.filter(j=>j.until<=now).at(-1);
  if(expired)await this.storage.put('lastDelivery',{status:'missed-window',kind:expired.id.split('-').at(-1),due:expired.due,at:now});
 }
 alarm(){
  return this.run(async()=>{
   const now=Date.now(),plan=await this.storage.get('plan'),sent=await this.marks(now);
   if(!Object.keys(sent).length)await this.storage.delete('sent');else await this.storage.put('sent',sent);
   await this.recordExpired(plan,now);
   const due=plan?.jobs.filter(j=>Math.max(j.due,j.retryAt||0)<=now&&j.until>now&&!sent[j.id])||[];
   let latest=plan;
   if(due.length){
    const target=due[0].due,batch=due.filter(j=>j.due===target);
    const kind=batch.some(j=>j.id.endsWith('-incomplete'))?'incomplete':'daily';
    const until=Math.min(...batch.map(j=>j.until)),at=Date.now();
    const result=until<=at?{status:'missed-window'}:await this.send(plan.subscription,kind,at,until);
    const retry=this.retry({...batch[0],until},result);
    await this.storage.put('lastDelivery',{...result,kind,due:target,at:Date.now(),...(retry?{status:'retrying'}:{})});
    if(result.status==='accepted'){
     for(const j of batch)sent[j.id]=now+2*86400000;
     await this.storage.put('sent',sent);
    }else if(result.status==='subscription-expired'){
     latest=null;
    }else{
     const attempted=new Set(batch.map(j=>j.id));
     latest={...plan,jobs:plan.jobs.flatMap(j=>!attempted.has(j.id)?[j]:retry?[{...j,retryAt:retry.retryAt,attempt:retry.attempt}]:[])};
    }
   }
   const test=await this.storage.get('scheduledTest');
   const testNow=Date.now();
   if(test&&Math.max(test.due,test.retryAt||0)<=testNow){
    const result=test.until<=testNow?{status:'missed-window'}:await this.send(test.subscription,'scheduled-test',testNow,test.until);
    const retry=this.retry(test,result);
    const recorded={...result,due:test.due,at:Date.now(),...(retry?{status:'retrying'}:{})};
    await this.storage.put('lastScheduledTest',recorded);
    if(retry)await this.storage.put('scheduledTest',retry);
    else await this.storage.delete('scheduledTest');
   }
   await this.write(latest,sent);
  });
 }
 retry(job,result){
  if(result.status!=='temporary-failure')return null;
  const attempt=(job.attempt||0)+1;
  const delay=[30000,60000,120000,120000][attempt-1],retryAt=Date.now()+delay;
  return retryAt<job.until?{...job,attempt,retryAt}:null;
 }
}
