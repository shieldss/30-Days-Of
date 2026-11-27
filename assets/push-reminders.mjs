export const CONFIG_KEY='thirty-days-of-push-v1';
const DAY=86400000, LATE=15*60000;
const validTime=t=>/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t);
const localDate=d=>[d.getFullYear(),d.getMonth()+1,d.getDate()].map((n,i)=>String(n).padStart(i?2:4,'0')).join('-');
const ordinal=(y,m,d)=>Date.UTC(y,m-1,d)/DAY;
export function reminderSchedule(state,now=new Date()){
 const s=state.settings||{}, result=[];
 if(!s.notifications)return result;
 const active=(state.challenges||[]).filter(c=>c.status==='active'&&c.reminders!==false&&/^\d{4}-\d{2}-\d{2}$/.test(c.startDate)&&Number(c.startingDay)>=1&&Number(c.startingDay)<=30).map(c=>({...c,startOrdinal:ordinal(...c.startDate.split('-').map(Number))}));
 if(!active.length)return result;
 for(let offset=0;offset<30;offset++){
  const noon=new Date(now.getFullYear(),now.getMonth(),now.getDate()+offset,12),date=localDate(noon);
  const thisDay=ordinal(noon.getFullYear(),noon.getMonth()+1,noon.getDate());
  const scheduled=active.map(c=>[c,Number(c.startingDay)+thisDay-c.startOrdinal]).filter(([c,day])=>day>=Number(c.startingDay)&&day<=30);
  if(!scheduled.length)continue;
  const due=(time,kind)=>{
   if(!validTime(time)||s[kind==='daily'?'lastDaily':'lastIncomplete']===date)return;
   const [h,m]=time.split(':').map(Number), timestamp=+new Date(noon.getFullYear(),noon.getMonth(),noon.getDate(),h,m);
   const end=Math.min(timestamp+LATE,+new Date(noon.getFullYear(),noon.getMonth(),noon.getDate()+1));
   if(end<=+now||end<=timestamp)return;
   result.push({id:date+'-'+kind,due:timestamp,until:end});
  };
  if(s.dailyReminder)due(s.dailyTime,'daily');
  if(s.incompleteReminder&&scheduled.some(([c,d])=>!c.days?.some(x=>Number(x.day)===d&&(x.completed||x.skipped))))due(s.incompleteTime,'incomplete');
 }
 return result.sort((a,b)=>a.due-b.due||a.id.localeCompare(b.id));
}
export function pushOrigin(raw){
 let u;try{u=new URL(String(raw).trim());}catch{throw Error('Enter the HTTPS address of your 30 Days of… Worker.');}
 if(u.protocol!=='https:'||!u.hostname.endsWith('.workers.dev')||u.port||u.username||u.password||u.pathname!=='/'||u.search||u.hash)
  throw Error('Use the HTTPS workers.dev address without a path.');
 return u.origin;
}
export const supported=()=>globalThis.isSecureContext&&'Notification'in globalThis&&'PushManager'in globalThis&&'serviceWorker'in navigator;
export function getConfig(){
 try{const c=JSON.parse(localStorage.getItem(CONFIG_KEY));return c?.id&&c.url&&c.key?c:null;}catch{return null;}
}
const put=c=>localStorage.setItem(CONFIG_KEY,JSON.stringify(c));
const randomID=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
async function registration(){
 const url=new URL('./',location.href);
 const reg=await navigator.serviceWorker.getRegistration(url.href);
 if(!reg?.active||reg.scope!==url.href)throw Error('Reload 30 Days of… online to activate its notification worker.');
 return reg;
}
async function api(c,path,method='GET',body){
 const res=await fetch(c.url+path,{method,redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(12000),
  headers:{Authorization:'Bearer '+c.key,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 if(!res.ok){const details=await res.json().catch(()=>({}));throw Error(details.error||'The reminder service returned '+res.status+'.');}
 return res;
}
const path=c=>'/v1/device/'+c.id;
let tail=Promise.resolve(),last='',message='',listener=()=>{};
const queue=fn=>{const next=tail.then(fn);tail=next.catch(()=>{});return next;};
const status=s=>{message=s;listener();};
export const onStatus=cb=>{listener=cb;};
export const statusMessage=()=>message;
const send=(c,sub,state)=>api(c,path(c),'PUT',{subscription:sub.toJSON(),jobs:reminderSchedule(state)});
export async function connect(rawUrl,rawKey,getState){
 const previous=getConfig(),url=pushOrigin(rawUrl), same=previous?.url===url, key=String(rawKey||'').trim()||(same?previous.key:'');
 if(previous&&!same)throw Error('Disconnect the previous server before changing its address.');
 if(!/^[a-f0-9]{64}$/.test(key))throw Error('Enter the 64-character pairing key for the 30 Days of… Worker.');
 if(!supported())throw Error('This browser does not support Web Push. On iPhone or iPad, install the app on your Home Screen first.');
 if(await Notification.requestPermission()!=='granted')throw Error('Allow notifications for this app in your browser settings.');
 await queue(async()=>{
  const c={url,key,id:previous?.id||randomID(),deleting:false};
  const r=await (await api(c,'/v1/config')).json();
  if(r.app!=='thirty-days-of')throw Error('This is not the 30 Days of… reminder server. Use the separate Worker URL, not Fuel & Flow’s.');
  if(!/^[A-Za-z0-9_-]{87}$/.test(r.publicKey||''))throw Error('The server push key is invalid.');
  const keyBytes=Uint8Array.from(atob(r.publicKey.replaceAll('-','+').replaceAll('_','/')+'='),x=>x.charCodeAt(0));
  const reg=await registration();let sub=await reg.pushManager.getSubscription(),created=false;
  const old=new Uint8Array(sub?.options?.applicationServerKey??[]);
  if(sub&&(old.length!==keyBytes.length||old.some((x,i)=>x!==keyBytes[i]))){await sub.unsubscribe();sub=null;}
  if(!sub){sub=await reg.pushManager.subscribe({applicationServerKey:keyBytes,userVisibleOnly:true});created=true;}
  const state=await getState();
  try{await send(c,sub,state);put(c);last=JSON.stringify([c.id,reminderSchedule(state)]);status('Push connected. Reminders are synced for this device.');}
  catch(err){if(created)await sub.unsubscribe().catch(()=>{});throw err;}
 });
}
export function reconcile(getState,{force=false}={}){
 if(!supported()||!getConfig())return Promise.resolve();
 return queue(async()=>{
  const c=getConfig();if(!c)return;
  try{
   const state=await getState();
   if(c.deleting){
    const reg=await registration(),sub=await reg.pushManager.getSubscription();
    if(sub)await sub.unsubscribe();
    for(const n of await reg.getNotifications())if(n.tag.startsWith('30-days-reminder'))n.close();
    await api(c,path(c),'DELETE');localStorage.removeItem(CONFIG_KEY);last='';status('Push disconnected.');return;
   }
   const jobs=reminderSchedule(state),fingerprint=JSON.stringify([c.id,jobs]);
   if(!state.settings.notifications&&jobs.length===0){ // Cancel immediately when reminders or app data are turned off.
    if(force||last!==fingerprint)await api(c,path(c),'DELETE');
    last=fingerprint;status('Push reminders are paused on this device.');return;
   }
   if(Notification.permission!=='granted')throw Error('Notifications are blocked. Allow them for 30 Days of… in browser settings, then tap Sync now.');
   const sub=await (await registration()).pushManager.getSubscription();
   if(!sub)throw Error('Disconnect push and connect again to renew this browser’s subscription.');
   if(!force&&last===fingerprint)return;
   await api(c,path(c),'PUT',{subscription:sub.toJSON(),jobs});last=fingerprint;
   status(force?syncMessage(jobs):'Push connected. Reminders are synced for this device.');
  }catch(err){status(navigator.onLine===false?'Not synced while offline. Reopen the app online to send changes.':err.message);}
 });
}
export function disconnect(getState){
 const c=getConfig();if(!c)return Promise.resolve();
 put({...c,deleting:true});return reconcile(getState);
}

export function syncMessage(jobs){
 if(!jobs.length)return 'Server synced. No reminders are scheduled. Check that an active challenge has reminders enabled and that Daily challenge or Incomplete day is on.';
 const next=jobs[0],date=new Date(next.due);
 const label=next.id.endsWith('-incomplete')?'Incomplete day':'Daily challenge';
 const when=date.toLocaleString([], {weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
 return 'Server synced. Next reminder on this device’s schedule: '+label+' at '+when+'. The server skips reminders it already sent.';
}
export async function testBrowserNotification(){
 if(!supported()||Notification.permission!=='granted')throw Error('Allow notifications for 30 Days of… in your browser first.');
 const reg=await registration();
 await reg.showNotification('30 Days of… · Browser test',{
  body:'This device can display notifications. This check does not test background push.',
  icon:'./assets/icon-192.png',badge:'./assets/icon-192.png',tag:'30-days-browser-test'
 });
}
export function testPushDelivery(){
 return queue(async()=>{
  const c=getConfig();
  if(!c||c.deleting)throw Error('Connect background push first.');
  if(!supported()||Notification.permission!=='granted')throw Error('Allow notifications for 30 Days of… in your browser first.');
  const reg=await registration(),sub=await reg.pushManager.getSubscription();
  if(!sub)throw Error('Disconnect push and connect again to renew this browser’s subscription.');
  const config=await (await api(c,'/v1/config')).json();
  if(config.app!=='thirty-days-of')throw Error('Use the Worker for 30 Days of…, not Fuel & Flow.');
  if(config.testPush!==true)throw Error('Update your existing 30 Days of… Worker to enable test push. The browser test and regular reminders still work without this update.');
  const channel=new MessageChannel();
  const ready=await new Promise(resolve=>{
   const timer=setTimeout(()=>resolve(false),2000);
   channel.port1.onmessage=event=>{clearTimeout(timer);resolve(event.data?.testPush===true);};
   reg.active.postMessage({type:'PUSH_TEST_SUPPORT'},[channel.port2]);
  }).finally(()=>channel.port1.close());
  if(!ready)throw Error('Reload 30 Days of… online to activate the app update, then try again.');
  await api(c,path(c),'POST',sub.toJSON());
 });
}
