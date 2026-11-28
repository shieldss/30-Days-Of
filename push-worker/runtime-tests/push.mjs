import worker,{ChallengeReminders} from './worker.mjs';

const base64url=value=>btoa(String.fromCharCode(...new Uint8Array(value)))
 .replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');

export default {
 async test(){
  const signer=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const subscriber=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const env={
   VAPID_PRIVATE_JWK:JSON.stringify(await crypto.subtle.exportKey('jwk',signer.privateKey)),
   VAPID_PUBLIC_KEY:base64url(await crypto.subtle.exportKey('raw',signer.publicKey)),
   VAPID_SUBJECT:'mailto:operator@example.com'
  };
  const keys={
   p256dh:base64url(await crypto.subtle.exportKey('raw',subscriber.publicKey)),
   auth:base64url(crypto.getRandomValues(new Uint8Array(16)))
  };
  // globalOutbound binds all requests to the fake push provider. No live push is sent.
  for(const [kind,redirect] of [['daily',false],['incomplete',false],['daily',true]]){
   const data=new Map();
   const storage={get:async key=>data.get(key),put:async(key,value)=>data.set(key,value),
    delete:async key=>data.delete(key),setAlarm:async()=>{},deleteAlarm:async()=>{}};
   const device=new ChallengeReminders({storage},env);
   const now=Date.now(),id=new Date(now).toISOString().slice(0,10)+'-'+kind;
   const endpoint='https://fcm.googleapis.com/fcm/send/'+kind+(redirect?'-redirect':'');
   const reply=await device.fetch(new Request('https://internal/schedule',{
    method:'PUT',body:JSON.stringify({subscription:{endpoint,keys},jobs:[{id,due:now-1000,until:now+60000}]})
   }));
   if(reply.status!==204)throw Error('Could not queue '+kind+'.');
   await device.alarm();
   if(data.has('plan'))throw Error('The alarm did not consume its job.');
   if(Boolean(data.get('sent')?.[id])===redirect)throw Error('Incorrect delivery state for '+kind+'.');
  }
  const data=new Map(),job={jobs:[{id:'existing-job'}]};
  data.set('plan',job);
  const storage={get:async key=>data.get(key),put:async(key,value)=>data.set(key,value)};
  const device=new ChallengeReminders({storage},env);
  const pair='5'.repeat(64),origin='https://shieldss.github.io';
  const bindings={...env,PAIRING_KEY:pair,APP_ORIGIN:origin,
   REMINDERS:{idFromName:x=>x,get:()=>({fetch:(url,options)=>device.fetch(new Request(url,options))})}};
  const endpoint='https://fcm.googleapis.com/fcm/send/test';
  const post=(payload,key=pair)=>worker.fetch(new Request('https://example.workers.dev/v1/device/'+'b'.repeat(32),{
   method:'POST',headers:{Origin:origin,Authorization:'Bearer '+key},body:JSON.stringify(payload)
  }),bindings);
  if((await post({endpoint,keys},'bad')).status!==401)throw Error('Unauthenticated test passed.');
  if((await post({endpoint:'https://other.example/path',keys})).status!==400)throw Error('Unapproved push provider allowed.');
  const result=await post({endpoint,keys});
  if(result.status!==204)throw Error('Full test push failed: '+await result.text());
  if(data.get('plan')!==job||data.has('sent'))throw Error('Test push changed the schedule.');
  if((await post({endpoint,keys})).status!==429)throw Error('Missing test throttle.');
  data.delete('testAfter');
  const stale=await post({endpoint:endpoint+'-expired',keys});
  if(stale.status!==409||!(await stale.text()).includes('subscription has expired'))throw Error('Missing stale subscription diagnostic.');

 }
};

export {ChallengeReminders};
export const realAlarm = {
 async test(_ctrl,env){
  const receiver=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const keys={
   p256dh:base64url(await crypto.subtle.exportKey('raw',receiver.publicKey)),
   auth:base64url(crypto.getRandomValues(new Uint8Array(16)))
  };
  // Let workerd fire the real SQLite-backed Durable Object timer. Do not call alarm().
  for(const [kind,address] of [['daily','a'],['incomplete','b']]){
   const now=Date.now(),due=now+350;
   const send=(method,body)=>worker.fetch(new Request('https://relay.workers.dev/v1/device/'+address.repeat(32),{
    method,headers:{Origin:env.APP_ORIGIN,Authorization:'Bearer '+env.PAIRING_KEY},body:body&&JSON.stringify(body)
   }),env);
   const res=await send('PUT',{
    report:true,subscription:{endpoint:'https://fcm.googleapis.com/fcm/send/'+kind,keys},
    jobs:[{id:new Date(now).toISOString().slice(0,10)+'-'+kind,due,until:due+60000}]
   });
   if(res.status!==200)throw Error('Could not sync real Durable Object: '+await res.text());
   const queued=await res.json();
   if(queued.queued!==1||queued.alarm!==due||queued.next?.kind!==kind)throw Error('Actual alarm was not armed for '+kind+'.');
   const deadline=now+10000;
   let report;
   while(Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,125));
    report=await (await send('GET')).json();
    if(report.last)break;
   }
   if(report?.last?.status!=='accepted'||report.last.kind!==kind||report.last.at<due||report.queued!==0)
    throw Error('Actual alarm did not deliver '+kind+': '+JSON.stringify(report));
   if(kind==='daily'){
    // The first daily reminder already sent. A plain repeat for a later time
    // still deduplicates, while an explicit future-time edit arms today's alarm.
    const rescheduledAt=Date.now(),later=rescheduledAt+350,day=new Date(now).toISOString().slice(0,10);
    const job={id:day+'-daily',due:later,until:later+60000};
    const sync=async row=>await (await send('PUT',{
     report:true,reportDay:day,subscription:{endpoint:'https://fcm.googleapis.com/fcm/send/daily',keys},jobs:[row]
    })).json();
    const suppressed=await sync(job);
    if(suppressed.queued!==0||!suppressed.today.daily.alreadySent)throw Error('Ordinary same-day repeat was not suppressed.');
    const edited={...job,rescheduledAt};
    const moved=await sync(edited);
    if(moved.queued!==1||moved.alarm!==later||moved.today.daily.due!==later)throw Error('Edited alarm was not re-armed.');
    while(Date.now()<later+10000){
     await new Promise(resolve=>setTimeout(resolve,125));
     report=await (await send('GET')).json();
     if(report.last?.due===later)break;
    }
    if(report.last?.status!=='accepted'||report.last.due!==later||report.last.at<later||report.queued!==0)
     throw Error('Edited reminder did not fire: '+JSON.stringify(report));
    if((await sync(edited)).queued!==0)throw Error('Resync re-armed an edited reminder already sent.');
   }
   await send('DELETE');
  }
 }
};
