const BUILD_VERSION = "1.0";
const CACHE_NAME = `rendo-pwa-v${BUILD_VERSION}`;
const APP_SHELL = [
  "./","./index.html",`./style.css?v=${BUILD_VERSION}`,`./app.js?v=${BUILD_VERSION}`,
  `./manifest.webmanifest?v=${BUILD_VERSION}`,"./version.json","./icons/icon-192.png",
  "./icons/icon-512.png","./icons/logo.png","./icons/apple-touch-icon.png",
  "./icons/favicon-32.png","./icons/favicon-16.png"
];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).catch(()=>null));
  self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil((async()=>{
    const keys = await caches.keys();
    await Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener("message", event => { if(event.data === "SKIP_WAITING") self.skipWaiting(); });
async function networkFirst(request){
  const cache=await caches.open(CACHE_NAME);
  try{const response=await fetch(request,{cache:"no-store"}); if(response?.status===200) cache.put(request,response.clone()).catch(()=>null); return response;}
  catch(_){return (await cache.match(request)) || (request.mode==="navigate" ? cache.match("./index.html") : Response.error());}
}
async function cacheFirst(request){
  const cache=await caches.open(CACHE_NAME); const hit=await cache.match(request); if(hit) return hit;
  const response=await fetch(request); if(response?.status===200) cache.put(request,response.clone()).catch(()=>null); return response;
}
self.addEventListener("fetch", event=>{
  if(event.request.method!=="GET") return;
  const url=new URL(event.request.url);
  if(url.hostname.includes("firestore.googleapis.com") || url.hostname.includes("identitytoolkit.googleapis.com")) return;
  const local=url.origin===self.location.origin;
  const fresh=local && (event.request.mode==="navigate" || /\.(?:html|js|css|json|webmanifest)$/.test(url.pathname));
  event.respondWith(fresh ? networkFirst(event.request) : cacheFirst(event.request));
});
