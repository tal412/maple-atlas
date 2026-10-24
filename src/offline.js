(function(){
  const button=document.getElementById('mc-offline-save'),status=document.getElementById('mc-offline-status');
  let registration=null;
  async function register(){
    if(!('serviceWorker' in navigator))throw Error('This browser cannot save the app offline. You can still pair while the page is open.');
    if(!registration)registration=navigator.serviceWorker.register('./sw.js').catch(e=>{registration=null;throw e;});
    await registration;
    return Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Offline storage is not ready. Please retry.')),12000))]);
  }
  if('serviceWorker' in navigator)void register().catch(()=>{});
  button.onclick=async()=>{
    button.disabled=true;status.textContent='Preparing offline essentials…';
    try{
      const reg=await register();
      await new Promise((resolve,reject)=>{
        const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();reject(Error('Download took too long. Saved files remain; retry to finish.'));},120000);
        channel.port1.onmessage=e=>{
          const value=e.data;if(value.error){clearTimeout(timer);channel.port1.close();reject(Error(value.error));}
          else if(value.done){clearTimeout(timer);channel.port1.close();resolve();}
          else status.textContent='Saving offline essentials · '+value.saved+' / '+value.total+' files';
        };
        reg.active.postMessage({type:'save-companion-offline'},[channel.port2]);
      });status.textContent='Offline essentials saved: atlas, search, QR pairing and visual matching. Opened game images are cached as you explore. Market updates require internet.';
    }catch(e){status.textContent=e.message;}finally{button.disabled=false;}
  };
})();
