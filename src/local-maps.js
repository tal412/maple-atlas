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
    const marker = $('#mc-local-exit'), select = $('#mc-local-select'), you = $('#mc-local-you');
    let current, edge, zoom = 1, ready = false, player = null, userZoomed = false, lastFollow = null;
    // Navigation arrow (Google Maps style): a moving dashed line from your dot to the next
    // portal and a heading chevron next to you. Built here so the template stays unchanged.
    const path = document.createElement('div'); path.className = 'mc-local-path'; path.hidden = true; path.setAttribute('aria-hidden', 'true');
    const heading = document.createElement('div'); heading.className = 'mc-local-heading'; heading.hidden = true; heading.setAttribute('aria-hidden', 'true');
    heading.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 12 21 3l-5 9 5 9z"/></svg>';
    stage.prepend(path); stage.append(heading);
    const loader=MapleMapImages.createLoader({image,timeoutMs:20000,onState:state=>{
      ready=state==='ready';stage.hidden=!ready;$('#mc-local-feedback').hidden=ready;
      $('#mc-local-retry').hidden=state!=='error';
      $('#mc-local-state').textContent=state==='error'?'The map image could not load. Check your connection and try again.':'Loading game map…';
      if(ready){$('#mc-local-fit').disabled=false;layout();}
      else{marker.hidden=true;you.hidden=true;for(const button of root.querySelectorAll('[data-local-zoom]'))button.disabled=true;}
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
      // Live position from the companion, in the same pixel coordinates as the portals.
      const here = current && player?.id === String(current.id) ? position(player, image.naturalWidth, image.naturalHeight) : null;
      you.hidden = !here;
      if (here) { you.style.left = here.x * 100 + '%'; you.style.top = here.y * 100 + '%'; }
      // Arrow from you to the portal, in stage pixels.
      const W = stage.offsetWidth, H = stage.offsetHeight, show = Boolean(here && point);
      path.hidden = heading.hidden = !show;
      if (show) {
        const sx = here.x * W, sy = here.y * H, ex = point.x * W, ey = point.y * H, dx = ex - sx, dy = ey - sy;
        const length = Math.hypot(dx, dy), angle = Math.atan2(dy, dx) * 180 / Math.PI, gap = Math.min(18, length / 3);
        path.hidden = length < 30;
        Object.assign(path.style, {left: sx + 'px', top: sy + 'px', width: Math.max(0, length - gap - 16) + 'px', transform: 'translateY(-50%) rotate(' + angle + 'deg) translateX(' + gap + 'px)'});
        Object.assign(heading.style, {left: sx + 'px', top: sy + 'px', transform: 'translate(-50%,-50%) rotate(' + angle + 'deg) translateX(26px) rotate(180deg)'});
        if (!userZoomed) follow(sx, sy, ex, ey);
      }
      $('#mc-local-scale').textContent = Math.round(fit * zoom * 100) + '%';
      $('#mc-local-minus').disabled = zoom <= 1;
      $('#mc-local-plus').disabled = zoom >= 12;
      $('#mc-local-focus').disabled = !point;
    }
    // Navigation view: zoom so you and the portal both fit (up to 6x), and scroll only when
    // either would leave the middle of the view, so the map does not jitter at 5 readings a second.
    function follow(sx, sy, ex, ey) {
      const fit = Math.min((viewport.clientWidth - 48) / image.naturalWidth, (viewport.clientHeight - 48) / image.naturalHeight, 1);
      const spanX = Math.abs(ex - sx) / zoom + 160, spanY = Math.abs(ey - sy) / zoom + 160;
      // Both in view when possible, but never smaller than readable (about one game screen
      // across the view, like a car-navigation zoom); then the line leads off-screen to the portal.
      const both = (viewport.clientWidth - 48) / spanX, readable = .4 / fit;
      const want = Math.max(1, Math.min(6, Math.max(Math.min(both, (viewport.clientHeight - 48) / spanY), readable)));
      if (Math.abs(want - zoom) / zoom > .25) { zoom = want; stage.style.width = Math.max(1, image.naturalWidth * fit * zoom) + 'px'; return layout(); }
      const fits = Math.abs(ex - sx) < viewport.clientWidth * .7 && Math.abs(ey - sy) < viewport.clientHeight * .7;
      // Centre between you and the portal, or on you leaning toward the portal when it is far.
      const t = fits ? .5 : .3, lean = (d, size) => Math.max(-size * .28, Math.min(size * .28, d * t));
      const fx = sx + (fits ? (ex - sx) / 2 : lean(ex - sx, viewport.clientWidth)), fy = sy + (fits ? (ey - sy) / 2 : lean(ey - sy, viewport.clientHeight));
      const cx = stage.offsetLeft + fx - viewport.clientWidth / 2, cy = stage.offsetTop + fy - viewport.clientHeight / 2;
      const inView = (x, y, m) => { const vx = stage.offsetLeft + x - viewport.scrollLeft, vy = stage.offsetTop + y - viewport.scrollTop; return vx > viewport.clientWidth * m && vx < viewport.clientWidth * (1 - m) && vy > viewport.clientHeight * m && vy < viewport.clientHeight * (1 - m); };
      if (!lastFollow || !inView(sx, sy, .2) || (fits && !inView(ex, ey, .1))) { viewport.scrollTo({left: cx, top: cy, behavior: lastFollow ? 'smooth' : 'auto'}); lastFollow = {cx, cy}; }
    }
    // The portal instruction, plus live guidance from your dot toward the selected portal.
    function describe() {
      const destination = edge ? get(edge.to)?.name : '';
      const live = edge && player?.id === String(current.id) && scope.MapleMinimapPosition ? scope.MapleMinimapPosition.guidance(player, {x: Number(edge.x), y: Number(edge.y)}) : null;
      $('#mc-local-instruction').textContent = edge ? instruction(edge, destination) + (live ? ' Live: ' + live.text + '.' : '') : current.portals.length ? 'Explore the original game map. Choose a destination to highlight its portal.' : 'This reference has no verified portal overlays. Pan or zoom to explore the original game map.';
    }
    function choose(index) {
      edge = current.portals[index];
      select.value = edge ? String(index) : '';
      const destination = edge ? get(edge.to)?.name : '';
      describe();
      marker.setAttribute('aria-label', destination ? 'Portal to ' + destination : 'Portal');
      layout();
    }
    function open(id, next) {
      const map = get(id);
      if (!map?.image) return;
      current = map; zoom = 1; ready = false; userZoomed = false; lastFollow = null;
      stage.hidden = true; marker.hidden = true; you.hidden = true;
      $('#mc-local-title').textContent = map.name;
      $('#mc-local-state').textContent = 'Loading game map…';
      $('#mc-local-feedback').hidden = false;
      $('#mc-local-scale').textContent = 'Fit';
      for (const button of root.querySelectorAll('[data-local-zoom]')) button.disabled = true;
      $('#mc-local-source').href = 'https://osmsdataexplorer.com/?tab=maps&id=' + String(id).padStart(9, '0');
      select.replaceChildren(new Option('Choose an exit…', ''), ...map.portals.map((portal, index) => new Option(get(portal.to)?.name || 'Connected map', String(index))));
      select.disabled = !map.portals.length;
      $('.mc-local-controls').hidden = !map.portals.length;
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
    // Zooming by hand pauses the automatic follow until the next map opens.
    $('#mc-local-plus').onclick = () => { userZoomed = true; zoom = Math.min(12, zoom * 1.6); layout(Boolean(edge)); };
    $('#mc-local-minus').onclick = () => { userZoomed = true; zoom = Math.max(1, zoom / 1.6); layout(Boolean(edge)); };
    $('#mc-local-fit').onclick = () => { userZoomed = true; zoom = 1; layout(); viewport.scrollTo(0, 0); };
    $('#mc-local-focus').onclick = () => { userZoomed = true; zoom = Math.max(zoom, 4); layout(true); };
    viewport.addEventListener('wheel', () => { userZoomed = true; }, {passive: true});
    new ResizeObserver(() => layout()).observe(viewport);
    // value: {id, x, y} or null. Shown when it is for the map on screen.
    function setPlayer(value) { player = value ? {id: String(value.id), x: value.x, y: value.y} : null; if (current) describe(); layout(); }
    return {open, setPlayer, get openId() { return dialog.open && current ? String(current.id) : null; }};
  }
  const api = {instruction, position, create};
  scope.MapleLocalMaps = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
