// Zoom for the preview, without buttons:
// - mouse wheel (and trackpad pinch) over the preview zooms at the pointer
// - two-finger pinch on touch screens
// - double-click / double-tap toggles between fit and 2.5×
// - when zoomed, drag with the mouse (or one finger) to move around
// The canvas is enlarged with CSS; the stage becomes a scrollable viewport.

const MIN = 1;
const MAX = 6;
const clamp = (v) => Math.min(MAX, Math.max(MIN, v));

/**
 * @param {{stage: HTMLElement, canvas: HTMLCanvasElement, badge: HTMLElement,
 *          canPan: (e: Event) => boolean, onPinchStart: () => void,
 *          onChange: (level: number) => void}} opts
 */
export function createZoom({ stage, canvas, badge, canPan, onPinchStart, onChange }) {
  let level = 1;
  let fitWidth = 0;
  let badgeTimer = 0;

  function showBadge() {
    badge.textContent = `${Math.round(level * 100)}%`;
    badge.hidden = false;
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => { badge.hidden = true; }, 900);
  }

  /** Zoom to `next`, keeping the document point under `anchor` still. */
  function zoomTo(next, anchor) {
    next = clamp(next);
    if (Math.abs(next - level) < 0.001 || canvas.hidden) return;
    if (level === 1) {
      // Freeze the fitted sizes so zooming in never makes the stage jump.
      fitWidth = canvas.getBoundingClientRect().width;
      stage.style.height = `${stage.getBoundingClientRect().height}px`;
    }
    const box = stage.getBoundingClientRect();
    const ax = anchor?.x ?? box.left + box.width / 2;
    const ay = anchor?.y ?? box.top + box.height / 2;
    const before = canvas.getBoundingClientRect();
    const fx = (ax - before.left) / before.width;
    const fy = (ay - before.top) / before.height;

    level = next < 1.02 ? 1 : next;
    if (level === 1) {
      reset();
    } else {
      canvas.style.width = `${fitWidth * level}px`;
      stage.classList.add('zoomed');
      const after = canvas.getBoundingClientRect();
      stage.scrollLeft += after.left + fx * after.width - ax;
      stage.scrollTop += after.top + fy * after.height - ay;
    }
    showBadge();
    onChange(level);
  }

  /** Back to "fit" (also used, without notifying, when the page changes). */
  function reset() {
    level = 1;
    canvas.style.width = '';
    stage.style.height = '';
    stage.classList.remove('zoomed');
  }

  // Mouse wheel / trackpad. At "fit", scrolling down still scrolls the page.
  stage.addEventListener('wheel', (e) => {
    if (level === 1 && e.deltaY > 0 && !e.ctrlKey) return;
    e.preventDefault();
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : 1); // Firefox may report lines
    const speed = e.ctrlKey ? 0.01 : 0.002; // ctrl = trackpad pinch: small deltas
    zoomTo(level * Math.exp(-delta * speed), { x: e.clientX, y: e.clientY });
  }, { passive: false });

  // Safari sends gesture events for trackpad / iOS pinch.
  let gestureStart = 1;
  stage.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    gestureStart = level;
  });
  stage.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    zoomTo(gestureStart * e.scale, { x: e.clientX, y: e.clientY });
  });

  // Two-finger pinch on touch screens (also pans by moving both fingers).
  let pinch = null;
  const touchInfo = (e) => {
    const [a, b] = e.touches;
    return {
      dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      x: (a.clientX + b.clientX) / 2,
      y: (a.clientY + b.clientY) / 2,
    };
  };
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    e.preventDefault();
    onPinchStart();
    pinch = { ...touchInfo(e), level };
  }, { passive: false });
  stage.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const now = touchInfo(e);
    zoomTo(pinch.level * (now.dist / pinch.dist), now);
    stage.scrollLeft -= now.x - pinch.x;
    stage.scrollTop -= now.y - pinch.y;
    pinch.x = now.x;
    pinch.y = now.y;
  }, { passive: false });
  const endPinch = (e) => {
    if (e.touches.length < 2) pinch = null;
  };
  stage.addEventListener('touchend', endPinch);
  stage.addEventListener('touchcancel', endPinch);

  // Double-click / double-tap: zoom in at that point, or back to fit.
  stage.addEventListener('dblclick', (e) => {
    if (!canPan(e)) return;
    zoomTo(level > 1 ? 1 : 2.5, { x: e.clientX, y: e.clientY });
  });

  // Drag with the mouse to move around a zoomed page (touch scrolls natively).
  stage.addEventListener('pointerdown', (e) => {
    if (level === 1 || e.pointerType !== 'mouse' || !canPan(e)) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('panning');
    const move = (ev) => {
      stage.scrollLeft = start.left - (ev.clientX - start.x);
      stage.scrollTop = start.top - (ev.clientY - start.y);
    };
    const end = () => {
      stage.classList.remove('panning');
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', end);
      stage.removeEventListener('pointercancel', end);
    };
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
  });

  return { reset, level: () => level };
}
