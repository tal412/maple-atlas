/* Keep labels attached to their markers throughout each camera gesture. */
(() => {
  function create() {
    let previous = new Map();
    let initialized = false;
    const intersects = (a, b, padding = 4) => a.x < b.x + b.w + padding && a.x + a.w > b.x - padding && a.y < b.y + b.h + padding && a.y + a.h > b.y - padding;
    function layout({ points, bounds, blocked = [], route = [], moving = false }) {
      if (moving && initialized) return previous;
      const next = new Map(), placed = [];
      const markers = points.map(p => ({ x: p.x - p.r, y: p.y - p.r, w: p.r * 2, h: p.r * 2 }));
      const labels = points.filter(p => p.label).sort((a, b) => Number(b.selected) - Number(a.selected));
      for (const point of labels) {
        const { x, y, w, h, id } = point;
        next.set(id, { visible: false });
        if (x < bounds.left - 44 || x > bounds.right + 44 || y < bounds.top - 44 || y > bounds.bottom + 44) continue;
        const within = r => r.x >= bounds.left && r.y >= bounds.top && r.x + w <= bounds.right && r.y + h <= bounds.bottom;
        const collisions = r => markers.filter(q => intersects(r, q)).length + placed.filter(q => intersects(r, q, 5)).length + blocked.filter(q => intersects(r, q, 3)).length;
        const old = previous.get(id);
        let best = old?.visible ? { x: x + old.dx, y: y + old.dy, w, h } : null;
        // Keep a valid placement even when another candidate scores slightly better.
        if (!best || !within(best) || collisions(best)) {
          const candidates = [];
          const add = (cx, cy) => {
            const r = { x: Math.max(bounds.left, Math.min(bounds.right - w, cx)), y: Math.max(bounds.top, Math.min(bounds.bottom - h, cy)), w, h };
            if (!within(r)) return;
            r.collisions = collisions(r);
            r.score = r.collisions * 100000 + route.filter(q => intersects(r, q, 5)).length * 100 + Math.hypot(r.x + w / 2 - x, r.y + h / 2 - y);
            candidates.push(r);
          };
          for (const gap of [24, 40, 60, 84]) {
            add(x - w / 2, y + gap); add(x - w / 2, y - gap - h);
            add(x + gap, y - h / 2); add(x - gap - w, y - h / 2);
          }
          if (point.selected && !candidates.some(r => !r.collisions)) {
            for (let cy = bounds.top; cy <= bounds.bottom - h; cy += 20) {
              for (let cx = bounds.left; cx <= bounds.right - w; cx += 24) add(cx, cy);
            }
          }
          candidates.sort((a, b) => a.score - b.score);
          best = candidates[0];
          if (!best || (!point.selected && best.collisions)) continue;
        }
        placed.push(best);
        next.set(id, { visible: true, dx: best.x - x, dy: best.y - y, w, h });
      }
      initialized = true;
      previous = next;
      return next;
    }
    return { layout };
  }
  globalThis.MapleLabelLayout = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})();
