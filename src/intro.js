/* Homepage: shown on a first visit, and from Your character → About Maple Atlas
 * (or the logo on a computer). Skipped when the visit is a companion pairing. */
(function(){
  const root=document.getElementById('maple-atlas-concept'),dialog=root?.querySelector('#mc-intro');if(!dialog)return;
  const key='maple-atlas-intro-seen:'+location.pathname.replace(/index\.html$/,'');
  const seen=()=>{try{return localStorage.getItem(key)==='1';}catch(_){return true;}};
  const markSeen=()=>{try{localStorage.setItem(key,'1');}catch(_){}};
  const paired=()=>{try{return Object.keys(localStorage).some(k=>k.startsWith('maple-atlas-mac-pairing:'));}catch(_){return false;}};
  function open(){root.querySelector('#mc-profile-dialog')?.close();if(!dialog.open)dialog.showModal();dialog.querySelector('.mc-intro-scroll').scrollTop=0;}
  function close(){markSeen();dialog.close();}
  root.querySelector('#mc-intro-open')?.addEventListener('click',open);
  const logo=root.querySelector('.mc-logo');
  if(logo){logo.setAttribute('role','button');logo.tabIndex=0;logo.title='About Maple Atlas';logo.classList.add('cursor-interaction');logo.addEventListener('click',open);logo.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});}
  dialog.querySelector('#mc-intro-close').onclick=close;
  dialog.querySelector('#mc-intro-map').onclick=close;
  dialog.querySelector('#mc-intro-connect').onclick=()=>{
    close();const phone=root.querySelector('#mc-mobile-companion');
    (phone&&phone.offsetParent?phone:root.querySelector('#mc-companion-desktop'))?.click();
  };
  dialog.addEventListener('cancel',markSeen);
  // A visit that opened the companion (a pairing QR) or a phone already paired with a
  // Mac is a returning player: no homepage.
  const pairing=root.querySelector('#mc-companion-dialog')?.open;
  if(pairing||paired())markSeen();
  else if(!seen())open();
})();
