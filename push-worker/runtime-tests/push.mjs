import {ChallengeReminders} from './worker.mjs';

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
 }
};
