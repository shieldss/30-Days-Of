const VERSION = '30days-v1.0.0-build-12';
const CORE = ['./','./index.html','./styles.css?v=1.0.0-7','./challenge-app.js?v=1.0.0-12','./manifest.json','./assets/logo.svg','./assets/icon.svg','./assets/icon-192.png','./assets/icon-512.png','./assets/icon-maskable-512.png'];
const cacheKey = request => { const url = new URL(typeof request === 'string' ? request : request.url, self.registration.scope); url.searchParams.set('__app_cache', VERSION); return url.href; };
self.addEventListener('install',event=>event.waitUntil(caches.open(VERSION).then(cache=>cache.addAll(CORE.map(cacheKey))).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==VERSION).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')self.skipWaiting()});
self.addEventListener('fetch',event=>{const req=event.request;if(req.method!=='GET'||new URL(req.url).origin!==self.location.origin)return;const key=cacheKey(req);event.respondWith(caches.match(key).then(hit=>hit||fetch(req).then(response=>{if(response.ok){const copy=response.clone();caches.open(VERSION).then(cache=>cache.put(key,copy))}return response}).catch(()=>caches.match(cacheKey('./index.html')))))});
