const VERSION = '30days-__APP_VERSION__';
const CACHE_PREFIX = '30days-';
const CORE = ['./','./index.html','./styles.css?v=__APP_VERSION__','./challenge-app.js?v=__APP_VERSION__','./assets/push-reminders.mjs?v=__APP_VERSION__','./manifest.json','./assets/logo.svg','./assets/icon.svg','./assets/icon-192.png','./assets/icon-512.png','./assets/icon-maskable-512.png'];
const cacheKey = request => { const url = new URL(typeof request === 'string' ? request : request.url, self.registration.scope); url.searchParams.set('__app_cache', VERSION); return url.href; };
self.addEventListener('install',event=>event.waitUntil(caches.open(VERSION).then(cache=>cache.addAll(CORE.map(cacheKey)))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith(CACHE_PREFIX)&&key!==VERSION).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')self.skipWaiting()});
self.addEventListener('fetch',event=>{const req=event.request;if(req.method!=='GET'||!req.url.startsWith(self.registration.scope))return;const key=cacheKey(req);event.respondWith(caches.match(key).then(hit=>hit||fetch(req).then(response=>{if(response.ok){const copy=response.clone();caches.open(VERSION).then(cache=>cache.put(key,copy))}return response}).catch(()=>caches.match(cacheKey('./index.html')))))});

self.addEventListener('push',event=>{
 let kind;
 try{kind=event.data?.json().kind;}catch{}
 if(kind!=='daily'&&kind!=='incomplete')return;
 const title=kind==='daily'?'Your 30 Days of… challenge is ready':"Don't lose your streak";
 const body=kind==='daily'?"Open the app to see today’s challenges.":"You have a challenge still to complete today.";
 event.waitUntil(self.registration.showNotification(title,{body,icon:'./assets/icon-192.png',badge:'./assets/icon-192.png',tag:'30-days-reminder-'+kind,data:{app:'thirty-days-of'}}));
});
self.addEventListener('notificationclick',event=>{
 if(event.notification.data?.app!=='thirty-days-of')return;
 event.notification.close();
 const home=new URL('./#today',self.registration.scope).href;
 event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(async list=>{
  const client=list.find(c=>c.url.startsWith(self.registration.scope));
  if(client)return client.focus();
  return clients.openWindow(home);
 }));
});
