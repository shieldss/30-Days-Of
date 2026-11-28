import test from 'node:test';
import assert from 'node:assert/strict';
import {createECDH,createDecipheriv,hkdfSync,randomBytes,generateKeyPairSync,verify} from 'node:crypto';
import {applyReminderTimeChange,reminderSchedule,pushOrigin} from '../assets/push-reminders.mjs';
import worker,{encodePush,vapidRequest,ChallengeReminders,validateSchedule} from '../push-worker/worker.mjs';

const date=(d,h,m=0)=>new Date(2026,10,d,h,m);
const settings={notifications:true,dailyReminder:true,incompleteReminder:true,dailyTime:'07:00',incompleteTime:'20:00'};
const active={status:'active',startDate:'2026-11-27',startingDay:29,days:[]};
test('schedule uses existing preferences, future dates, and stops on day 30',()=>{
 const now=date(27,6),jobs=reminderSchedule({settings,challenges:[active]},now);
 assert.deepEqual(jobs.map(x=>x.id),['2026-11-27-daily','2026-11-27-incomplete','2026-11-28-daily','2026-11-28-incomplete']);
 assert.equal(jobs[0].due,+date(27,7));
 assert.equal(reminderSchedule({settings,challenges:[active]},date(27,7,16))[0].id,'2026-11-27-incomplete');
});
test('early completion and skip cancel the incomplete reminder only; paused and opted-out excluded',()=>{
 const all={settings,challenges:[{...active,days:[{day:29,completed:true},{day:30,skipped:true}]},
 {...active,status:'paused'},{...active,reminders:false}]};
 assert.deepEqual(reminderSchedule(all,date(27,6)).map(x=>x.id),['2026-11-27-daily','2026-11-28-daily']);
 assert.equal(reminderSchedule({...all,settings:{...settings,notifications:false}},date(27,6)).length,0);
 assert.equal(reminderSchedule({settings,challenges:[{...active,startDate:'2026-12-01'}]},date(27,6))[0].id,'2026-12-01-daily');
});
test('fall-back date & wall-clock reminder stay local over daylight saving',()=>{
 const before=new Date(2026,9,31,6), first=new Date(2026,9,31,7), second=new Date(2026,10,1,7);
 const list=reminderSchedule({settings:{...settings,incompleteReminder:false},challenges:[{...active,startDate:'2026-10-31'}]},before);
 assert.deepEqual(list.slice(0,2).map(j=>j.due),[+first,+second]);
});
const receiver=createECDH('prime256v1');receiver.generateKeys();
const receiverPub=receiver.getPublicKey(),auth=randomBytes(16);
const keys={p256dh:receiverPub.toString('base64url'),auth:auth.toString('base64url')};
const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/fake',keys};
const enc=Buffer.from;
const decrypt=body=>{
 const raw=Buffer.from(body),pubLen=raw[20], ephemeral=raw.subarray(21,21+pubLen);
 const info=Buffer.concat([enc('WebPush: info\0'),receiverPub,ephemeral]);
 const ikm=hkdfSync('sha256',receiver.computeSecret(ephemeral),auth,info,32);
 const nonce=hkdfSync('sha256',ikm,raw.subarray(0,16),'Content-Encoding: nonce\0',12);
 const key=hkdfSync('sha256',ikm,raw.subarray(0,16),'Content-Encoding: aes128gcm\0',16);
 const cipher=createDecipheriv('aes-128-gcm',key,nonce);
 cipher.setAuthTag(raw.subarray(-16));
 const msg=Buffer.concat([cipher.update(raw.subarray(21+pubLen,-16)),cipher.final()]);
 assert.equal(raw.readUInt32BE(16),4096);assert.equal(msg.at(-1),2);
 return JSON.parse(msg.subarray(0,-1).toString());
};
const signer=generateKeyPairSync('ec',{namedCurve:'prime256v1'}), signerJWK=signer.privateKey.export({format:'jwk'});
const env={APP_ORIGIN:'https://shieldss.github.io',PAIRING_KEY:'a'.repeat(64),VAPID_SUBJECT:'mailto:test@example.com',
 VAPID_PRIVATE_JWK:JSON.stringify(signerJWK),VAPID_PUBLIC_KEY:Buffer.concat([Buffer.from([4]),Buffer.from(signerJWK.x,'base64url'),Buffer.from(signerJWK.y,'base64url')]).toString('base64url')};
test('the payload independently decrypts and VAPID token verifies',async()=>{
 assert.deepEqual(decrypt(await encodePush(keys,{kind:'daily'})),{kind:'daily'});
 const req=await vapidRequest(subscription,env,'incomplete');
 const [h,p,s]=req.headers.get('Authorization').match(/t=([^,]+)/)[1].split('.');
 assert.ok(verify('sha256',Buffer.from(h+'.'+p),{key:signer.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(s,'base64url')));
 assert.equal(JSON.parse(Buffer.from(p,'base64url')).aud,'https://fcm.googleapis.com');
 assert.deepEqual(decrypt(await req.arrayBuffer()),{kind:'incomplete'});
});
test('relay requires the matching pairing key and origin, and keeps only allowed fields',async()=>{
 const now=Date.now(),job={id:'2026-11-27-daily',due:now+60000,until:now+120000,title:'private'};
 assert.deepEqual(validateSchedule({subscription,jobs:[job]},now).jobs,[{id:job.id,due:job.due,until:job.until}]);
 assert.throws(()=>validateSchedule({subscription,jobs:[job,job]},now));
 assert.throws(()=>validateSchedule({subscription:{...subscription,endpoint:'https://fcm.googleapis.com.example.com/foo'},jobs:[job]},now));
 assert.throws(()=>pushOrigin('https://service.workers.dev/login'));
 const config=(origin,key)=>worker.fetch(new Request('https://relay.workers.dev/v1/config',{headers:{Origin:origin,Authorization:'Bearer '+key}}),env);
 assert.equal((await config('https://other.example',env.PAIRING_KEY)).status,403);
 assert.equal((await config(env.APP_ORIGIN,'bad')).status,401);
 assert.equal((await (await config(env.APP_ORIGIN,env.PAIRING_KEY)).json()).app,'thirty-days-of');
});
test('alarm groups simultaneous reminders, dedups across sync, then cancels pending jobs',async()=>{
 const map=new Map();let alarm=null;const storage={get:async k=>map.get(k),put:async(k,v)=>map.set(k,v),delete:async k=>map.delete(k),setAlarm:async n=>{alarm=n;},deleteAlarm:async()=>{alarm=null;}};
 const target=new ChallengeReminders({storage},env), native=globalThis.fetch;const pushes=[];
 globalThis.fetch=async req=>{pushes.push(decrypt(await req.arrayBuffer()));return new Response(null,{status:201});};
 try{
  const now=Date.now(),due=now-1000;
  const jobs=[{id:'2026-11-27-daily',due,until:now+90000},{id:'2026-11-27-incomplete',due,until:now+90000},{id:'2026-11-28-daily',due:now+60000,until:now+90000}];
  const put=()=>target.fetch(new Request('https://internal/schedule',{method:'PUT',body:JSON.stringify({subscription,jobs})}));
  await put();assert.ok(alarm);
  await target.alarm();assert.deepEqual(pushes,[{kind:'incomplete'}]);
  await put();assert.equal(map.get('plan').jobs.length,1);
  await target.alarm();assert.equal(pushes.length,1);
  await target.fetch(new Request('https://internal/cancel',{method:'DELETE'}));
  assert.equal(map.has('plan'),false);assert.ok(map.has('sent'));
 }finally{globalThis.fetch=native;}
});

test('sync messaging distinguishes an empty schedule from the next eligible reminder',async()=>{
 const {syncMessage}=await import('../assets/push-reminders.mjs');
 assert.match(syncMessage([]),/No reminders are scheduled/);
 const due=+new Date(2026,10,27,16);
 assert.match(syncMessage([{id:'2026-11-27-incomplete',due}]),/Incomplete day/);
 assert.match(syncMessage([{id:'2026-11-27-daily',due}]),/Daily challenge/);
});

test('service worker distinguishes a test notification from both reminder types',async()=>{
 const {runInNewContext}=await import('node:vm');
 const {readFile}=await import('node:fs/promises');
 const listeners={},shown=[];
 runInNewContext(await readFile(new URL('../sw.js',import.meta.url),'utf8'),{self:{
  addEventListener:(type,listener)=>listeners[type]=listener,
  registration:{showNotification:async(title,options)=>shown.push({title,...options})}
 }});
 for(const kind of ['test','daily','daily','incomplete','scheduled-test','unknown'])
  listeners.push({data:{json:()=>({kind})},waitUntil:()=>{}});
 assert.equal(shown[0].title,'30 Days of… · Test push');
 assert.deepEqual(shown.map(item=>item.tag),['30-days-reminder-test','30-days-reminder-daily','30-days-reminder-daily','30-days-reminder-incomplete','30-days-reminder-scheduled-test']);
 assert.ok(shown.every(item=>item.renotify));
});

test('device wall-clock mapping matches expected UTC instants across zones, DST gap, fold and travel',async()=>{
 const {localReminderTime,deviceTimeZone}=await import('../assets/push-reminders.mjs');
 const old=process.env.TZ;
 try{
  const challenge=(startDate)=>[{...active,startDate,startingDay:1}];
  const onlyDaily={...settings,incompleteReminder:false};
  process.env.TZ='America/New_York';
  assert.equal(deviceTimeZone(),'America/New_York');
  const autumn=reminderSchedule({settings:onlyDaily,challenges:challenge('2026-10-31')},new Date('2026-10-31T10:00:00Z'));
  assert.deepEqual(autumn.slice(0,2).map(x=>new Date(x.due).toISOString()),['2026-10-31T11:00:00.000Z','2026-11-01T12:00:00.000Z']);
  const fold=reminderSchedule({settings:{...onlyDaily,dailyTime:'01:30'},challenges:challenge('2026-11-01')},new Date('2026-11-01T04:00:00Z'));
  assert.equal(new Date(fold[0].due).toISOString(),'2026-11-01T05:30:00.000Z');
  assert.equal(fold.filter(j=>j.id==='2026-11-01-daily').length,1);
  const spring=reminderSchedule({settings:{...onlyDaily,dailyTime:'02:30'},challenges:challenge('2027-03-14')},new Date('2027-03-14T06:00:00Z'));
  assert.equal(new Date(spring[0].due).toISOString(),'2027-03-14T07:30:00.000Z');
  assert.equal(spring[0].due,localReminderTime(new Date('2027-03-14T07:00:00Z'),'02:30'));
  process.env.TZ='America/Los_Angeles';
  const pacific=reminderSchedule({settings:onlyDaily,challenges:challenge('2026-11-01')},new Date('2026-11-01T06:00:00Z'));
  assert.equal(new Date(pacific[0].due).toISOString(),'2026-11-01T15:00:00.000Z');
  process.env.TZ='Asia/Kathmandu';
  const nepal=reminderSchedule({settings:{...onlyDaily,dailyTime:'00:05'},challenges:challenge('2026-11-01')},new Date('2026-10-31T17:00:00Z'));
  assert.equal(nepal[0].id,'2026-11-01-daily');
  assert.equal(new Date(nepal[0].due).toISOString(),'2026-10-31T18:20:00.000Z');
 }finally{if(old===undefined)delete process.env.TZ;else process.env.TZ=old;}
});

test('a working immediate test does not hide subscription loss; Sync restores the same pairing and submits the fresh endpoint',async()=>{
 const {CONFIG_KEY,reconcile,statusMessage,testPushDelivery}=await import('../assets/push-reminders.mjs');
 const globals=new Map();
 function mock(key,value){globals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const pairing={id:'b'.repeat(32),key:'a'.repeat(64),url:'https://mock.workers.dev',deleting:false};
 const map=new Map([[CONFIG_KEY,JSON.stringify(pairing)]]), calls=[];
 const mkSub=name=>({toJSON:()=>({...subscription,endpoint:subscription.endpoint+'/'+name})});
 let current=mkSub('first'),subscribeCount=0;
 const scope='https://shieldss.github.io/30-Days-Of/';
 const registration={
  scope,active:{postMessage:(_,ports)=>ports[0].postMessage({testPush:true,scheduledPush:true})},
  pushManager:{
   getSubscription:async()=>current,
   permissionState:async()=> 'granted',
   subscribe:async options=>{
    subscribeCount++;assert.equal(options.userVisibleOnly,true);
    assert.equal(options.applicationServerKey.length,65);
    return current=mkSub('restored');
   }
  }
 };
 const state={settings:{...settings,dailyTime:'23:59',incompleteReminder:false},
  challenges:[{...active,startDate:localDay(new Date()),startingDay:1}]};
 function localDay(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
 mock('localStorage',{getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)});
 mock('Notification',{permission:'granted'});
 mock('PushManager',class{});
 mock('isSecureContext',true);
 mock('location',{href:scope+'#settings'});
 mock('navigator',{onLine:true,serviceWorker:{getRegistration:async url=>{assert.equal(url,scope);return registration;}}});
 mock('fetch',async (url,options)=>{
  const body=options.body&&JSON.parse(options.body);calls.push({url,options,body});
  if(url.endsWith('/v1/config'))return Response.json({app:'thirty-days-of',publicKey:env.VAPID_PUBLIC_KEY,testPush:true,scheduleDiagnostics:true});
  if(options.method==='POST')return new Response(null,{status:204});
  const due=body.jobs[0]?.due;
  return Response.json({queued:body.jobs.length,next:due?{due,kind:'daily'}:null,alarm:due??null,serverTime:Date.now()});
 });
 try{
  await testPushDelivery();
  assert.equal(calls.find(x=>x.options.method==='POST').body.endpoint.endsWith('/first'),true);
  await reconcile(()=>state);
  current=null;
  await reconcile(()=>state,{force:true});
  assert.equal(subscribeCount,1);
  assert.equal(JSON.parse(map.get(CONFIG_KEY)).key,pairing.key);
  const puts=calls.filter(x=>x.options.method==='PUT');
  assert.equal(puts.length,2);
  assert.equal(puts[1].url,pairing.url+'/v1/device/'+pairing.id);
  assert.equal(puts[1].body.subscription.endpoint.endsWith('/restored'),true);
  assert.deepEqual(puts[1].body.jobs,puts[0].body.jobs);
  assert.match(statusMessage(),/Browser subscription restored/);
  assert.match(statusMessage(),/Worker confirmed/);
  current=mkSub('native-replacement');
  await reconcile(()=>state);
  assert.equal(calls.filter(x=>x.options.method==='PUT').at(-1).body.subscription.endpoint.endsWith('/native-replacement'),true);
  assert.equal(subscribeCount,1);
 }finally{for(const [key,descriptor] of globals)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
});

test('server reports real queue, timed test delivery, retry backoff and invalidation',async()=>{
 const map=new Map();let alarm=null, mode='accept';
 const storage={get:async k=>map.get(k),put:async(k,v)=>map.set(k,v),delete:async k=>map.delete(k),getAlarm:async()=>alarm,setAlarm:async n=>{alarm=n;},deleteAlarm:async()=>{alarm=null;}};
 const device=new ChallengeReminders({storage},env),native=globalThis.fetch,pushes=[];
 const binding={...env,REMINDERS:{idFromName:x=>x,get:()=>({fetch:(url,options)=>device.fetch(new Request(url,options))})}};
 const request=(method,body,path='')=>worker.fetch(new Request('https://mock.workers.dev/v1/device/'+'a'.repeat(32)+path,{
  method,headers:{Origin:env.APP_ORIGIN,Authorization:'Bearer '+env.PAIRING_KEY},body:body&&JSON.stringify(body)
 }),binding);
 globalThis.fetch=async req=>{
  const payload=decrypt(await req.arrayBuffer());
  pushes.push({payload,ttl:+req.headers.get('TTL'),urgency:req.headers.get('Urgency')});
  return new Response(null,{status:mode==='reject'?503:201});
 };
 try{
  const now=Date.now(),job={id:'2026-11-28-daily',due:now-250,until:now+899000};
  const sync=()=>request('PUT',{subscription,jobs:[job],report:true});
  const queued=await (await sync()).json();
  assert.equal(queued.queued,1);
  assert.deepEqual(queued.next,{due:job.due,kind:'daily'});
  assert.ok(queued.alarm>=now);
  const timed=await (await request('POST',subscription,'/scheduled-test')).json();
  assert.ok(timed.due>now+59000);
  assert.equal((await request('POST',subscription,'/scheduled-test')).status,429);
  mode='reject';
  await device.alarm();
  const retryAlarm=alarm;
  assert.ok(retryAlarm>now+29000);
  assert.equal((await (await request('GET')).json()).last.status,'retrying');
  await sync();assert.equal(alarm,retryAlarm);
  await device.alarm();assert.equal(pushes.length,1);
  const test=map.get('scheduledTest');
  map.set('scheduledTest',{...test,due:now-100,until:now+120000});
  mode='accept';
  await device.alarm();
  const report=await (await request('GET')).json();
  assert.deepEqual(pushes.map(p=>p.payload.kind),['daily','scheduled-test']);
  assert.equal(pushes[0].urgency,'high');
  assert.ok(pushes[0].ttl>850);
  assert.equal(report.test.status,'accepted');
  assert.equal(report.queued,1);
  assert.equal(alarm,retryAlarm);
  await request('DELETE');
  assert.equal(map.has('plan'),false);
  assert.equal(map.has('scheduledTest'),false);
 }finally{globalThis.fetch=native;}
});

test('a deliberate same-day future time edit clears only its local sent guard',()=>{
 const now=date(28,12,40),s={...settings,lastDaily:'2026-11-28',lastIncomplete:'2026-11-28'};
 const state={settings:s,challenges:[{...active,startDate:'2026-11-28',startingDay:1}]};
 const daily='2026-11-28-daily',incomplete='2026-11-28-incomplete';
 assert.equal(reminderSchedule(state,now).some(j=>j.id===daily),false);
 applyReminderTimeChange(s,'dailyTime','12:45',now);
 const jobs=reminderSchedule(state,now),job=jobs.find(j=>j.id===daily);
 assert.equal(job.due,+date(28,12,45));assert.equal(job.rescheduledAt,+now);
 assert.equal(jobs.some(j=>j.id===incomplete),false);
 assert.equal(jobs.find(j=>j.id==='2026-11-29-daily').rescheduledAt,undefined);
 // An unchanged time and reopening the app must not reauthorize a second send.
 s.lastDaily='2026-11-28';
 applyReminderTimeChange(s,'dailyTime','12:45',date(28,12,46));
 assert.equal(reminderSchedule(state,date(28,12,46)).some(j=>j.id===daily),false);
 applyReminderTimeChange(s,'dailyTime','12:44',date(28,12,46));
 assert.equal(s.lastDaily,'2026-11-28');
 assert.equal(s.dailyTimeEdit,undefined);
});

test('Worker re-arms only the edited later time, then suppresses repeats and preserves the other reminder',async()=>{
 const map=new Map();let alarm=null, count=0;
 const storage={get:async k=>map.get(k),put:async(k,v)=>map.set(k,v),delete:async k=>map.delete(k),getAlarm:async()=>alarm,setAlarm:async n=>{alarm=n;},deleteAlarm:async()=>{alarm=null;}};
 const device=new ChallengeReminders({storage},env);
 device.send=async()=>{count++;return {status:'accepted',http:201};};
 const binding={...env,REMINDERS:{idFromName:x=>x,get:()=>({fetch:(url,options)=>device.fetch(new Request(url,options))})}};
 const day='2026-11-28',id=day+'-daily',other=day+'-incomplete',now=Date.now();
 const latest={id,due:now-300,until:now+60000}, evening={id:other,due:now+3600000,until:now+3660000};
 const sync=async (first=latest)=>{
  const reply=await worker.fetch(new Request('https://mock.workers.dev/v1/device/'+'b'.repeat(32),{
   method:'PUT',headers:{Origin:env.APP_ORIGIN,Authorization:'Bearer '+env.PAIRING_KEY},
   body:JSON.stringify({subscription,jobs:[first,evening],report:true,reportDay:day})}),binding);
  assert.equal(reply.status,200);return reply.json();
 };
 // Existing production marks are expiry timestamps; no reset is needed on deploy.
 map.set('sent',{[id]:now-3600000+2*86400000});
 assert.deepEqual((await sync()).today.daily,{queued:false,alreadySent:true});
 assert.equal((await sync({...latest,rescheduledAt:now+10})).today.daily.queued,false);
 const edited={...latest,rescheduledAt:now-1000};
 const rearmed=await sync(edited);
 assert.deepEqual(rearmed.today.daily,{queued:true,due:latest.due});
 assert.equal(rearmed.today.incomplete.due,evening.due);
 assert.equal(rearmed.queued,2);
 await device.alarm();
 assert.equal(count,1);
 const after=await sync(edited);
 assert.deepEqual(after.today.daily,{queued:false,alreadySent:true});
 assert.deepEqual(after.today.incomplete,{queued:true,due:evening.due});
 assert.equal(after.next.kind,'incomplete');
 await device.alarm();
 assert.equal(count,1);
});
