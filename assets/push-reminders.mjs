export const CONFIG_KEY='thirty-days-of-push-v1';
const DAY=86400000, LATE=15*60000;
const validTime=t=>/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t);
const localDate=d=>[d.getFullYear(),d.getMonth()+1,d.getDate()].map((n,i)=>String(n).padStart(i?2:4,'0')).join('-');
const ordinal=(y,m,d)=>Date.UTC(y,m-1,d)/DAY;
// Use the same device calendar clock for foreground and background. Date resolves a
// spring gap forward by the gap, and uses the first occurrence of a fall overlap.
export function localReminderTime(day,time){
 if(!validTime(time))return NaN;
 const [h,m]=time.split(':').map(Number);
 return +new Date(day.getFullYear(),day.getMonth(),day.getDate(),h,m);
}
export const deviceTimeZone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone||'device local time';
const formattedDue=due=>new Date(due).toLocaleString([], {
 weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'
});
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
   const timestamp=localReminderTime(noon,time);
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
const send=(c,sub,jobs)=>api(c,path(c),'PUT',{subscription:sub.toJSON(),jobs,report:true});
const fingerprint=(c,subscription,jobs)=>JSON.stringify([c.id,subscription,jobs]);
function serverKey(config){
 if(config.app!=='thirty-days-of')throw Error('This is not the 30 Days of… reminder server. Use the separate Worker URL, not Fuel & Flow’s.');
 if(!/^[A-Za-z0-9_-]{87}$/.test(config.publicKey||''))throw Error('The server push key is invalid.');
 return Uint8Array.from(atob(config.publicKey.replaceAll('-','+').replaceAll('_','/')+'='),x=>x.charCodeAt(0));
}
async function configuredKey(c){
 if(/^[A-Za-z0-9_-]{87}$/.test(c.publicKey||''))return serverKey({app:'thirty-days-of',publicKey:c.publicKey});
 const remote=await (await api(c,'/v1/config')).json();
 const key=serverKey(remote);
 const current=getConfig();
 if(current?.id===c.id&&!current.deleting)put({...current,publicKey:remote.publicKey});
 return key;
}
async function nativeSubscription(reg,c){
 const current=await reg.pushManager.getSubscription();
 if(current)return {sub:current,recovered:false};
 if(await reg.pushManager.permissionState?.({userVisibleOnly:true})==='denied')
  throw Error('Background push permission is blocked. Allow notifications for this app in your browser, then tap Sync now.');
 const key=await configuredKey(c);let sub;
 try{sub=await reg.pushManager.subscribe({applicationServerKey:key,userVisibleOnly:true});}
 catch{throw Error('The browser did not restore its push subscription. Open the installed app or Chrome directly and tap Sync now. If it still fails, reconnect push using the existing Worker and key. Your challenges are safe.');}
 return {sub,recovered:true};
}
export async function connect(rawUrl,rawKey,getState){
 const previous=getConfig(),url=pushOrigin(rawUrl), same=previous?.url===url, key=String(rawKey||'').trim()||(same?previous.key:'');
 if(previous&&!same)throw Error('Disconnect the previous server before changing its address.');
 if(!/^[a-f0-9]{64}$/.test(key))throw Error('Enter the 64-character pairing key for the 30 Days of… Worker.');
 if(!supported())throw Error('This browser does not support Web Push. On iPhone or iPad, install the app on your Home Screen first.');
 if(await Notification.requestPermission()!=='granted')throw Error('Allow notifications for this app in your browser settings.');
 await queue(async()=>{
  const c={url,key,id:previous?.id||randomID(),deleting:false};
  const r=await (await api(c,'/v1/config')).json();
  const keyBytes=serverKey(r);c.publicKey=r.publicKey;
  const reg=await registration();let sub=await reg.pushManager.getSubscription(),created=false;
  const old=new Uint8Array(sub?.options?.applicationServerKey??[]);
  if(sub&&(old.length!==keyBytes.length||old.some((x,i)=>x!==keyBytes[i]))){await sub.unsubscribe();sub=null;}
  if(!sub){sub=await reg.pushManager.subscribe({applicationServerKey:keyBytes,userVisibleOnly:true});created=true;}
  const state=await getState();
  try{const jobs=reminderSchedule(state),reply=await send(c,sub,jobs),report=await receipt(reply);put(c);last=fingerprint(c,sub.toJSON(),jobs);status(syncMessage(jobs,report));}
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
   const jobs=reminderSchedule(state);
   if(!state.settings.notifications&&jobs.length===0){ // Cancel immediately when reminders or app data are turned off.
    const paused='paused:'+c.id;
    if(force||last!==paused)await api(c,path(c),'DELETE');
    last=paused;status('Push reminders are paused on this device ('+deviceTimeZone()+').');return;
   }
   if(Notification.permission!=='granted')throw Error('Notifications are blocked. Allow them for 30 Days of… in browser settings, then tap Sync now.');
   const {sub,recovered}=await nativeSubscription(await registration(),c);
   const fp=fingerprint(c,sub.toJSON(),jobs);
   if(!force&&!recovered&&last===fp)return;
   const reply=await send(c,sub,jobs);
   const report=await receipt(reply);last=fp;
   status((recovered?'Browser subscription restored. ':'')+syncMessage(jobs,report));
  }catch(err){status(navigator.onLine===false?'Not synced while offline. Reopen the app online to send changes.':err.message);}
 });
}
export function disconnect(getState){
 const c=getConfig();if(!c)return Promise.resolve();
 put({...c,deleting:true});return reconcile(getState);
}

const receipt=reply=>reply.status===200?reply.json():null;
const kindName=kind=>kind==='incomplete'?'Incomplete day':'Daily challenge';
function deliveryText(record){
 const status={
  accepted:'accepted by the push provider (not proof of receipt)',
  'missed-window':'missed its delivery window',
  'subscription-expired':'failed because the browser subscription expired',
  'prepare-failed':'could not be prepared by the Worker',
  'provider-rejected':'was rejected by the push provider',
  'temporary-failure':'could not reach the push provider in time',
  retrying:'is waiting to retry'
 }[record.status]||'has no reported result';
 return status+(Number.isInteger(record.http)?' (HTTP '+record.http+')':'');
}
export function syncMessage(jobs,report=null){
 const timezone=' Device time zone: '+deviceTimeZone()+'.';
 if(!report){
  if(!jobs.length)return 'No reminders are scheduled. Check that an active challenge has reminders enabled and that Daily challenge or Incomplete day is on.'+timezone;
  const next=jobs[0];
  return 'Schedule submitted. This older Worker can’t confirm the alarm. Next on this device: '+kindName(next.id.split('-').at(-1))+' at '+formattedDue(next.due)+'.'+timezone;
 }
 let text;
 if(!report.next)text='Worker synced. No new reminders are queued. Make sure an active challenge allows reminders and that Daily challenge or Incomplete day is on; already-sent reminders won’t repeat.';
 else if(!Number.isFinite(report.alarm))text='Worker has '+report.queued+' queued reminders but no alarm. Tap Sync now again.';
 else text='Worker confirmed '+report.queued+' queued '+(report.queued===1?'reminder':'reminders')+'. Next: '+kindName(report.next.kind)+' at '+formattedDue(report.next.due)+'.';
 if(report.next?.retryAt)text+=' Retry scheduled for '+formattedDue(report.next.retryAt)+'.';
 if(Number.isFinite(report.serverTime)&&Math.abs(Date.now()-report.serverTime)>120000)text+=' The device clock differs from the Worker by over two minutes; check automatic date and time.';
 if(report.last)text+=' Last '+kindName(report.last.kind).toLowerCase()+' at '+formattedDue(report.last.due)+' '+deliveryText(report.last)+'.';
 if(report.test)text+=' Scheduled test at '+formattedDue(report.test.due)+' '+(report.test.status?deliveryText(report.test):'is queued')+'.';
 return text+timezone;
}
export async function testBrowserNotification(){
 if(!supported()||Notification.permission!=='granted')throw Error('Allow notifications for 30 Days of… in your browser first.');
 const reg=await registration();
 await reg.showNotification('30 Days of… · Browser test',{
  body:'This device can display notifications. This check does not test background push.',
  icon:'./assets/icon-192.png',badge:'./assets/icon-192.png',tag:'30-days-browser-test'
 });
}
export function testPushDelivery({scheduled=false}={}){
 return queue(async()=>{
  const c=getConfig();
  if(!c||c.deleting)throw Error('Connect background push first.');
  if(!supported()||Notification.permission!=='granted')throw Error('Allow notifications for 30 Days of… in your browser first.');
  const reg=await registration(),{sub}=await nativeSubscription(reg,c);
  const config=await (await api(c,'/v1/config')).json();
  if(config.app!=='thirty-days-of')throw Error('Use the Worker for 30 Days of…, not Fuel & Flow.');
  if(config.testPush!==true||scheduled&&config.scheduleDiagnostics!==true)throw Error('Update your existing 30 Days of… Worker to enable this test. Keep your current pairing.');
  const channel=new MessageChannel();
  const ready=await new Promise(resolve=>{
   const timer=setTimeout(()=>resolve(false),2000);
   channel.port1.onmessage=event=>{clearTimeout(timer);resolve(event.data?.testPush===true&&(!scheduled||event.data?.scheduledPush===true));};
   reg.active.postMessage({type:'PUSH_TEST_SUPPORT'},[channel.port2]);
  }).finally(()=>channel.port1.close());
  if(!ready)throw Error('Reload 30 Days of… online to activate the app update, then try again.');
  const reply=await api(c,path(c)+(scheduled?'/scheduled-test':''),'POST',sub.toJSON());
  if(scheduled){
   const {due}=await reply.json();
   if(!Number.isFinite(due))throw Error('The Worker did not confirm a scheduled test time.');
   return 'Scheduled test queued for '+formattedDue(due)+'. Close the app or lock this device; look for “30 Days of… · Scheduled test.”';
  }
 });
}
