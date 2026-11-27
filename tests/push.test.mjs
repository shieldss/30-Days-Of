import test from 'node:test';
import assert from 'node:assert/strict';
import {createECDH,createDecipheriv,hkdfSync,randomBytes,generateKeyPairSync,verify} from 'node:crypto';
import {reminderSchedule,pushOrigin} from '../assets/push-reminders.mjs';
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
