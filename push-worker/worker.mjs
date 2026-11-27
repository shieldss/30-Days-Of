// Web Push for 30 Days of…; only generic reminder kinds are carried in the payload.
const enc=new TextEncoder();
const LIMIT=15*60000, HORIZON=31*86400000;
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
  Authorization:'vapid t='+jwt+'.'+b64(sig)+', k='+env.VAPID_PUBLIC_KEY,TTL:String(ttl),Urgency:'normal',
  'Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream',Topic:'thirty-days-'+kind
 },body:await encodePush(subscription.keys,{kind})});
}
export function validateSchedule(raw,now=Date.now()){
 if(!Array.isArray(raw?.jobs)||raw.jobs.length>60)throw Error('Invalid schedule size.');
 const keys=raw.subscription?.keys||{}, endpoint=pushEndpoint(raw.subscription?.endpoint).href;
 if(!/^[A-Za-z0-9_-]{87}$/.test(keys.p256dh||'')||!/^[A-Za-z0-9_-]{22}$/.test(keys.auth||'')||unb64(keys.p256dh)[0]!==4)throw Error('Invalid subscription keys.');
 const ids=new Set(),jobs=[];
 for(const j of raw.jobs){
  if(!/^\d{4}-\d{2}-\d{2}-(daily|incomplete)$/.test(j?.id||'')||ids.has(j.id)||!Number.isSafeInteger(j.due)||j.due>now+HORIZON||!Number.isSafeInteger(j.until)||j.until<=j.due||j.until-j.due>LIMIT)throw Error('Invalid reminder time or ID.');
  ids.add(j.id);if(j.until>now)jobs.push({id:j.id,due:j.due,until:j.until});
 }
 jobs.sort((a,b)=>a.due-b.due||a.id.localeCompare(b.id));
 return {subscription:{endpoint,keys:{p256dh:keys.p256dh,auth:keys.auth}},jobs};
}
function response(status,body){return body===undefined?new Response(null,{status}):Response.json(body,{status});}
function cors(r,origin){
 const out=new Response(r.body,r);
 out.headers.set('Access-Control-Allow-Origin',origin);
 out.headers.set('Access-Control-Allow-Methods','GET, PUT, DELETE, OPTIONS');
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
  if(path==='/v1/config'&&request.method==='GET')return reply(200,{app:'thirty-days-of',publicKey:env.VAPID_PUBLIC_KEY});
  const match=/^\/v1\/device\/([0-9a-f]{32})$/.exec(path);
  if(!match||!['PUT','DELETE'].includes(request.method))return reply(404);
  const stub=env.REMINDERS.get(env.REMINDERS.idFromName(match[1]));
  if(request.method==='DELETE')return cors(await stub.fetch('https://internal/cancel',{method:'DELETE'}),origin);
  // Read at most 12 KiB even when Content-Length is missing.
  try{
   if(!request.body)return reply(400,{error:'Missing schedule.'});
   const reader=request.body.getReader(), chunks=[];let n=0;
   for(;;){const x=await reader.read();if(x.done)break;n+=x.value.length;if(n>12288){await reader.cancel();return reply(413);}chunks.push(x.value);}
   const bytes=new Uint8Array(n);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   const normalized=validateSchedule(JSON.parse(new TextDecoder().decode(bytes)));
   return cors(await stub.fetch('https://internal/schedule',{method:'PUT',body:JSON.stringify(normalized)}),origin);
  }catch{return reply(400,{error:'Invalid browser push subscription or reminder time.'});}
 }
};

export class ChallengeReminders{
 constructor(ctx,env){this.storage=ctx.storage;this.env=env;}
 async write(plan,sent,now=Date.now()){
  const jobs=(plan?.jobs||[]).filter(j=>j.until>now&&!sent[j.id]);
  if(jobs.length){
   await this.storage.put('plan',{...plan,jobs});
   await this.storage.setAlarm(Math.max(jobs[0].due,now));
  }else{
   await this.storage.delete('plan');await this.storage.deleteAlarm();
   const next=Math.min(...Object.values(sent));if(Number.isFinite(next))await this.storage.setAlarm(next);
  }
 }
 async marks(now=Date.now()){
  const current=await this.storage.get('sent')||{};
  return Object.fromEntries(Object.entries(current).filter(([,until])=>until>now));
 }
 async fetch(request){
  const sent=await this.marks();
  if(request.method==='DELETE'){await this.write(null,sent);return response(204);}
  const plan=await request.json();plan.revision=crypto.randomUUID();
  await this.write(plan,sent);return response(204);
 }
 async alarm(info={}){
  const now=Date.now(),plan=await this.storage.get('plan'),sent=await this.marks(now);
  if(!Object.keys(sent).length)await this.storage.delete('sent');else await this.storage.put('sent',sent);
  const due=plan?.jobs.filter(j=>j.due<=now&&j.until>now&&!sent[j.id])||[];
  if(!due.length){await this.write(plan,sent,now);return;}
  const target=due[0].due, batch=due.filter(j=>j.due===target);
  const kind=batch.some(j=>j.id.endsWith('-incomplete'))?'incomplete':'daily';
  const ttl=Math.max(1,Math.min(300,Math.floor((Math.min(...batch.map(j=>j.until))-now)/1000)));
  let res;
  try{res=await fetch(await vapidRequest(plan.subscription,this.env,kind,{now,ttl}));}
  catch(err){if((info.retryCount||0)<5)throw err;}
  let latest=await this.storage.get('plan');
  if(res?.ok){
   for(const j of batch)sent[j.id]=now+2*86400000;
   await this.storage.put('sent',sent);
  }else if(latest?.revision===plan.revision&&(res?.status===404||res?.status===410)){
   latest=null;
  }else if(latest?.revision===plan.revision&&(!res||res.status===429||res.status>=500)&&(info.retryCount||0)<5){
   throw Error('Push provider temporarily unavailable.');
  }else if(latest?.revision===plan.revision){
   const attempted=new Set(batch.map(j=>j.id));latest={...latest,jobs:latest.jobs.filter(j=>!attempted.has(j.id))};
  }
  await this.write(latest,sent);
 }
}
