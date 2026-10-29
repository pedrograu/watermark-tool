// Draw, move, resize and delete rectangles on top of the preview canvas.
// Regions are stored as fractions (0–1) of the page and mutated in place;
// onChange() is called on every change so the preview can redraw.

const MIN_SIZE = 0.01;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * @param {HTMLElement} overlay element covering the preview canvas exactly
 * @param {{getRegions: (create: boolean) => object[], onChange: () => void}} hooks
 */
export function createRegionEditor(overlay, { getRegions, onChange }) {
  let drawMode = false;
  let active = null; // the drag in progress: {end, abort}

  const point = (e) => {
    const box = overlay.getBoundingClientRect();
    return {
      x: clamp((e.clientX - box.left) / box.width, 0, 1),
      y: clamp((e.clientY - box.top) / box.height, 0, 1),
    };
  };

  const place = (el, r) => {
    el.style.left = `${r.x * 100}%`;
    el.style.top = `${r.y * 100}%`;
    el.style.width = `${r.w * 100}%`;
    el.style.height = `${r.h * 100}%`;
  };

  // Follow one pointer until it is released. `abort` undoes it if a pinch
  // (second finger) interrupts.
  function drag(e, update, done, abort) {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev) => {
      update(point(ev));
      onChange();
    };
    const end = () => {
      active = null;
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      done?.();
      onChange();
    };
    active = { end, abort };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }

  function remove(r) {
    const regions = getRegions(false);
    regions.splice(regions.indexOf(r), 1);
    render();
    onChange();
  }

  function regionElement(r) {
    const el = document.createElement('div');
    el.className = 'region';
    place(el, r);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'region-delete';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Remove hidden area');
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', () => remove(r));

    const handle = document.createElement('span');
    handle.className = 'region-handle';
    handle.addEventListener('pointerdown', (e) => drag(e, (p) => {
      r.w = clamp(p.x - r.x, MIN_SIZE, 1 - r.x);
      r.h = clamp(p.y - r.y, MIN_SIZE, 1 - r.y);
      place(el, r);
    }));

    el.addEventListener('pointerdown', (e) => {
      const start = point(e);
      const { x: ox, y: oy } = r;
      drag(e, (p) => {
        r.x = clamp(ox + p.x - start.x, 0, 1 - r.w);
        r.y = clamp(oy + p.y - start.y, 0, 1 - r.h);
        place(el, r);
      });
    });

    el.append(del, handle);
    return el;
  }

  overlay.addEventListener('pointerdown', (e) => {
    if (!drawMode || e.target !== overlay) return;
    const start = point(e);
    const r = { x: start.x, y: start.y, w: 0, h: 0 };
    const regions = getRegions(true);
    regions.push(r);
    const el = regionElement(r);
    overlay.append(el);
    const discard = () => {
      if (!regions.includes(r)) return;
      regions.splice(regions.indexOf(r), 1);
      el.remove();
    };
    drag(e, (p) => {
      r.x = Math.min(start.x, p.x);
      r.y = Math.min(start.y, p.y);
      r.w = Math.abs(p.x - start.x);
      r.h = Math.abs(p.y - start.y);
      place(el, r);
    }, () => {
      if (r.w < MIN_SIZE || r.h < MIN_SIZE) discard();
    }, discard);
  });

  function render() {
    overlay.replaceChildren(...getRegions(false).map(regionElement));
  }

  function setDrawMode(on) {
    drawMode = on;
    overlay.classList.toggle('drawing', on);
  }

  /** Stop the current drag; a half-drawn area is discarded. */
  function cancel() {
    if (!active) return;
    const { end, abort } = active;
    abort?.();
    end();
  }

  return { render, setDrawMode, cancel, isDrawing: () => drawMode };
}
