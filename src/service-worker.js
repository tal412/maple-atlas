const CACHE=__CACHE_NAME__,FILES=__OFFLINE_FILES__,BASE=new URL('./',self.location.href),CHANNEL=__CHANNEL__;
self.addEventListener('install',event=>{event.waitUntil(self.skipWaiting());});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('maple-atlas-offline-'+CHANNEL+'-')&&name!==CACHE)await caches.delete(name);await self.clients.claim();})());});
const canonical=request=>{const url=new URL(request.url);url.search='';url.hash='';if(url.pathname===BASE.pathname)url.pathname+='index.html';return url.href;};
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url),relative=url.pathname.slice(BASE.pathname.length);
  if(request.method!=='GET'||url.origin!==BASE.origin||!url.pathname.startsWith(BASE.pathname)||(CHANNEL==='main'&&relative.startsWith('dev/')))return;
  // Market refreshes have their own dated IndexedDB cache and failure states.
  // Do not disguise a failed refresh as a successful service-worker cache hit.
  if(!['','index.html','favicon.svg','data/visual-index.json'].includes(relative)&&!relative.startsWith('assets/')&&!relative.startsWith('vendor/')&&!/^data\/(?:search-[a-f0-9]+\.json|visual-[a-f0-9]+\.bin)$/.test(relative))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE),key=canonical(request),saved=await cache.match(key),fresh=request.mode==='navigate'||relative==='data/visual-index.json';
    if(saved&&!fresh)return saved;
    try{const response=await fetch(request);if(response.ok){try{await cache.put(key,response.clone());}catch(_){}return response;}if(saved)return saved;return response;}catch(e){if(saved)return saved;throw e;}
  })());
});
self.addEventListener('message',event=>{
  if(event.data?.type!=='save-companion-offline'||!event.ports[0])return;
  const port=event.ports[0];event.waitUntil((async()=>{
    try{const cache=await caches.open(CACHE);let saved=0;
      for(const file of FILES){const url=new URL(file,BASE).href;if(!await cache.match(url)){const response=await fetch(url,{cache:'reload'});if(!response.ok)throw Error('Could not save '+file+'. Retry while online.');await cache.put(url,response);}
        port.postMessage({saved:++saved,total:FILES.length});}
      port.postMessage({done:true});
    }catch(e){port.postMessage({error:e.message||'Offline storage is unavailable or full.'});}
  })());
});
