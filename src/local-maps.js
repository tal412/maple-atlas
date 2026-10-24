/* Portal names stay in the data; the interface uses readable instructions. */
(function (scope) {
  function instruction(edge, destination) {
    if (!edge) return 'You have arrived.';
    const name = edge.name.toLowerCase();
    const action = /^east/.test(name) ? 'Take the right-hand portal' :
      /^west/.test(name) ? 'Take the left-hand portal' :
      /^top/.test(name) ? 'Take the upper portal' :
      /^bottom/.test(name) ? 'Take the lower portal' :
      /^in\d/.test(name) ? 'Use the entrance' :
      /^out\d/.test(name) ? 'Use the exit' : 'Take the portal';
    return action + (destination ? ' to ' + destination : '') + '.';
  }
  function position(edge, width, height) {
    if (!edge || !Number.isFinite(edge.x) || !Number.isFinite(edge.y) ||
        width <= 0 || height <= 0 || edge.x < 0 || edge.y < 0 || edge.x > width || edge.y > height) return null;
    return {x: edge.x / width, y: edge.y / height};
  }
  function create({root, get}) {
    const $ = selector => root.querySelector(selector);
    const dialog = $('#mc-local-dialog'), image = $('#mc-local-image');
    const viewport = $('#mc-local-viewport'), stage = $('#mc-local-stage');
    const marker = $('#mc-local-exit'), select = $('#mc-local-select');
    let current, edge, zoom = 1, ready = false;
    const loader=MapleMapImages.createLoader({image,timeoutMs:20000,onState:state=>{
      ready=state==='ready';stage.hidden=!ready;$('#mc-local-feedback').hidden=ready;
      $('#mc-local-retry').hidden=state!=='error';
      $('#mc-local-state').textContent=state==='error'?'The map image could not load. Check your connection and try again.':'Loading game map…';
      if(ready){$('#mc-local-fit').disabled=false;layout();}
      else{marker.hidden=true;for(const button of root.querySelectorAll('[data-local-zoom]'))button.disabled=true;}
    }});
    function layout(focus = false) {
      if (!ready || !dialog.open) return;
      const fit = Math.min((viewport.clientWidth - 48) / image.naturalWidth, (viewport.clientHeight - 48) / image.naturalHeight, 1);
      stage.style.width = Math.max(1, image.naturalWidth * fit * zoom) + 'px';
      const point = position(edge, image.naturalWidth, image.naturalHeight);
      marker.hidden = !point;
      if (point) {
        marker.style.left = point.x * 100 + '%';
        marker.style.top = point.y * 100 + '%';
        if (focus) {
          viewport.scrollLeft = stage.offsetLeft + point.x * stage.offsetWidth - viewport.clientWidth / 2;
          viewport.scrollTop = stage.offsetTop + point.y * stage.offsetHeight - viewport.clientHeight / 2;
        }
      }
      $('#mc-local-scale').textContent = Math.round(fit * zoom * 100) + '%';
      $('#mc-local-minus').disabled = zoom <= 1;
      $('#mc-local-plus').disabled = zoom >= 12;
      $('#mc-local-focus').disabled = !point;
    }
    function choose(index) {
      edge = current.portals[index];
      select.value = edge ? String(index) : '';
      const destination = edge ? get(edge.to)?.name : '';
      $('#mc-local-instruction').textContent = edge ? instruction(edge, destination) : 'Explore the original game map. Choose a destination to highlight its portal.';
      marker.setAttribute('aria-label', destination ? 'Portal to ' + destination : 'Portal');
      layout();
    }
    function open(id, next) {
      const map = get(id);
      if (!map?.image) return;
      current = map; zoom = 1; ready = false;
      stage.hidden = true; marker.hidden = true;
      $('#mc-local-title').textContent = map.name;
      $('#mc-local-state').textContent = 'Loading game map…';
      $('#mc-local-feedback').hidden = false;
      $('#mc-local-scale').textContent = 'Fit';
      for (const button of root.querySelectorAll('[data-local-zoom]')) button.disabled = true;
      $('#mc-local-source').href = 'https://osmsdataexplorer.com/?tab=maps&id=' + String(id).padStart(9, '0');
      select.replaceChildren(new Option('Choose an exit…', ''), ...map.portals.map((portal, index) => new Option(get(portal.to)?.name || 'Connected map', String(index))));
      select.disabled = !map.portals.length;
      choose(map.portals.findIndex(portal => String(portal.to) === String(next)));
      if (!dialog.open) dialog.showModal();
      image.alt = map.name + ' — original game map';
      loader.load([map.localImage,map.image]);
      viewport.scrollTo(0, 0);
    }
    $('#mc-local-retry').onclick=()=>loader.retry();
    dialog.addEventListener('close',()=>{loader.cancel();ready=false;stage.hidden=true;});
    select.onchange = () => choose(select.value === '' ? -1 : Number(select.value));
    $('#mc-local-close').onclick = () => dialog.close();
    dialog.onclick = event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } };
    $('#mc-local-plus').onclick = () => { zoom = Math.min(12, zoom * 1.6); layout(Boolean(edge)); };
    $('#mc-local-minus').onclick = () => { zoom = Math.max(1, zoom / 1.6); layout(Boolean(edge)); };
    $('#mc-local-fit').onclick = () => { zoom = 1; layout(); viewport.scrollTo(0, 0); };
    $('#mc-local-focus').onclick = () => { zoom = Math.max(zoom, 4); layout(true); };
    new ResizeObserver(() => layout()).observe(viewport);
    return {open};
  }
  const api = {instruction, position, create};
  scope.MapleLocalMaps = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
