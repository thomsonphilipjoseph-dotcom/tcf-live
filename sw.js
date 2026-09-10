const CACHE="tcf-live-v6-cuefix";
const SHELL=["./","./index.html","./styles.css","./manifest.json"];

self.addEventListener("install",event=>{
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)));
});

self.addEventListener("activate",event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET") return;
  const url=new URL(event.request.url);
  if(url.origin!==location.origin) return;

  // Network-first for code so GitHub updates do not get trapped behind stale PWA cache.
  if(url.pathname.endsWith("/app.js") || url.pathname.endsWith("/index.html") || url.pathname.endsWith("/sw.js")){
    event.respondWith(
      fetch(event.request)
        .then(response=>{
          const copy=response.clone();
          caches.open(CACHE).then(cache=>cache.put(event.request,copy));
          return response;
        })
        .catch(()=>caches.match(event.request))
    );
    return;
  }

  event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request)));
});