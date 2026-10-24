(function(scope) {
  function createLoader({image,onState,timeoutMs=6000,schedule=setTimeout,unschedule=clearTimeout}) {
    let generation=0,attempt=0,timer=null,sources=[];
    function cancel() {
      generation++;unschedule(timer);timer=null;
      image.onload=null;image.onerror=null;image.removeAttribute('src');
    }
    function begin(urls) {
      cancel();const request=generation;onState('loading');
      function next(index) {
        unschedule(timer);const token=++attempt;
        const current=()=>request===generation&&token===attempt;
        if(index===urls.length){image.onload=null;image.onerror=null;image.removeAttribute('src');onState('error');return;}
        const fail=()=>{if(current())next(index+1);};
        image.onload=()=>{
          if(!current())return;
          if(!image.naturalWidth){fail();return;}
          unschedule(timer);timer=null;image.onload=null;image.onerror=null;onState('ready');
        };
        image.onerror=fail;
        timer=schedule(fail,timeoutMs);
        image.src=urls[index];
      }
      next(0);
    }
    function load(urls) {sources=[...new Set(urls.filter(Boolean))];begin(sources);}
    function retry() {const stamp=Date.now();begin(sources.map(url=>url+(url.includes('?')?'&':'?')+'retry='+stamp));}
    return {load,retry,cancel};
  }
  function previews({root,get}) {
    let controllers=[],observer;
    function refresh() {
      observer?.disconnect();controllers.forEach(c=>c.cancel());controllers=[];
      const starts=new Map();
      observer=typeof IntersectionObserver==='undefined'?null:new IntersectionObserver(entries=>{
        for(const entry of entries)if(entry.isIntersecting){starts.get(entry.target)?.();starts.delete(entry.target);observer.unobserve(entry.target);}
      },{root:root.querySelector('#mc-detail'),rootMargin:'80px'});
      for(const button of root.querySelectorAll('.mc-map-preview')){
        const image=button.querySelector('img');if(!image)continue;
        const map=get(button.dataset.localmap),message=button.querySelector('.mc-preview-message');
        const controller=createLoader({image,onState:state=>{
          image.hidden=state!=='ready';message.hidden=state==='ready';
          message.textContent=state==='error'?'Preview unavailable · Open full map':'Loading preview…';
        }});
        controllers.push(controller);
        const start=()=>controller.load([map.localMinimap,map.minimap]);
        if(button.dataset.lazy==='true'&&observer){starts.set(button,start);observer.observe(button);}else start();
      }
    }
    return {refresh};
  }
  const api={createLoader,previews};scope.MapleMapImages=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
