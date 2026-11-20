import { drawShape, hitDistance } from './shapes.js';

const COMMON_FPS = [24, 25, 30, 50, 60, 120, 240];

/**
 * One video viewport: <video> + canvas overlay with zoom/pan and drawing tools.
 * A record looks like { id, name, blob, fps, markers: {address, top, impact, finish}, shapes: [] }.
 */
export class Pane {
  constructor(record, { onChange, onActivate, onTime }) {
    this.record = record;
    record.shapes ||= [];
    record.markers ||= {};
    this.onChange = onChange;
    this.onActivate = onActivate;
    this.onTime = onTime;

    this.tool = 'pan';
    this.color = '#ffd60a';
    this.grid = false;
    this.mirror = false;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.pointers = new Map();
    this.drag = null;       // current gesture
    this.pendingAngle = null;
    this.undoStack = [];
    this.pendingSeek = null;

    this.el = document.createElement('div');
    this.el.className = 'pane';
    this.el.innerHTML = `
      <video playsinline muted preload="auto" disablepictureinpicture></video>
      <canvas></canvas>
      <div class="pane-label"></div>
      <div class="pane-hint" hidden></div>`;
    this.video = this.el.querySelector('video');
    this.canvas = this.el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.labelEl = this.el.querySelector('.pane-label');
    this.hintEl = this.el.querySelector('.pane-hint');
    this.labelEl.textContent = record.name;

    this.url = URL.createObjectURL(record.blob);
    this.video.src = this.url;

    this.video.addEventListener('loadedmetadata', () => { this.layout(); this.seek(0.0001); });
    this.video.addEventListener('loadeddata', () => this.render());
    this.video.addEventListener('seeked', () => {
      if (this.pendingSeek != null) {
        const t = this.pendingSeek; this.pendingSeek = null; this.video.currentTime = t;
      }
      this.render();
      this.onTime?.(this);
    });
    this.video.addEventListener('timeupdate', () => this.onTime?.(this));
    this.video.addEventListener('play', () => this.detectFps());

    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(this.el);

    this.canvas.addEventListener('pointerdown', e => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', e => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', e => this.onPointerUp(e));
    this.canvas.addEventListener('pointercancel', e => this.onPointerUp(e, true));
    this.canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('dblclick', () => this.resetView());
  }

  destroy() {
    this.video.pause();
    this.resizeObs.disconnect();
    this.video.removeAttribute('src');
    this.video.load();
    URL.revokeObjectURL(this.url);
    this.el.remove();
  }

  // ---------- geometry ----------
  get fps() { return this.record.fps || 30; }
  get duration() { return this.video.duration || 0; }
  get time() { return this.video.currentTime || 0; }
  get frame() { return Math.floor(this.time * this.fps + 1e-6); }
  get aspect() { return (this.video.videoWidth || 16) / (this.video.videoHeight || 9); }

  layout() {
    const r = this.el.getBoundingClientRect();
    this.cssW = r.width; this.cssH = r.height;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    // fit (contain) rect at zoom 1
    const a = this.aspect;
    let w = r.width, h = r.width / a;
    if (h > r.height) { h = r.height; w = h * a; }
    this.fit = { x: (r.width - w) / 2, y: (r.height - h) / 2, w, h };
    this.clampPan();
    this.applyView();
  }

  /** Displayed video rect in CSS px. */
  get rect() {
    const f = this.fit || { x: 0, y: 0, w: 1, h: 1 };
    const w = f.w * this.zoom, h = f.h * this.zoom;
    const cx = this.cssW / 2 + this.panX, cy = this.cssH / 2 + this.panY;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  applyView() {
    const r = this.rect;
    Object.assign(this.video.style, {
      left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`,
      transform: this.mirror ? 'scaleX(-1)' : '',
    });
    this.render();
  }

  clampPan() {
    if (!this.fit) return;
    const maxX = Math.max(0, (this.fit.w * this.zoom - this.cssW) / 2 + this.cssW * 0.25);
    const maxY = Math.max(0, (this.fit.h * this.zoom - this.cssH) / 2 + this.cssH * 0.25);
    if (this.zoom <= 1) { this.panX = 0; this.panY = 0; return; }
    this.panX = Math.max(-maxX, Math.min(maxX, this.panX));
    this.panY = Math.max(-maxY, Math.min(maxY, this.panY));
  }

  resetView() { this.zoom = 1; this.panX = 0; this.panY = 0; this.applyView(); }

  /** normalized → CSS px */
  toScreen = ([nx, ny]) => {
    const r = this.rect;
    if (this.mirror) nx = 1 - nx;
    return [r.x + nx * r.w, r.y + ny * r.h];
  };

  /** CSS px → normalized */
  toNorm(x, y) {
    const r = this.rect;
    let nx = (x - r.x) / r.w;
    if (this.mirror) nx = 1 - nx;
    return [nx, (y - r.y) / r.h];
  }

  zoomAt(factor, x, y) {
    const old = this.zoom;
    const z = Math.max(1, Math.min(12, old * factor));
    // keep point (x,y) fixed
    const cx = this.cssW / 2 + this.panX, cy = this.cssH / 2 + this.panY;
    this.panX += (x - cx) * (1 - z / old);
    this.panY += (y - cy) * (1 - z / old);
    this.zoom = z;
    this.clampPan();
    this.applyView();
  }

  // ---------- playback ----------
  play() { return this.video.play().catch(() => {}); }
  pause() { this.video.pause(); }
  get paused() { return this.video.paused; }

  seek(t) {
    t = Math.max(0, Math.min(this.duration || 0, t));
    if (this.video.seeking) this.pendingSeek = t;
    else this.video.currentTime = t;
  }

  /** Step n frames (negative = back). Seeks into the middle of the target frame. */
  step(n) {
    this.pause();
    const target = this.frame + n;
    const maxFrame = Math.max(0, Math.floor(this.duration * this.fps) - 1);
    const f = Math.max(0, Math.min(maxFrame, target));
    this.seek((f + 0.5) / this.fps);
  }

  setFps(fps, manual = true) {
    this.record.fps = fps;
    this.record.fpsManual = manual;
    this.onChange?.(this);
  }

  /** Estimate fps from presented frames while playing at 1x (if supported). */
  detectFps() {
    if (this.record.fpsManual || this._detecting || !('requestVideoFrameCallback' in this.video)) return;
    this._detecting = true;
    const deltas = [];
    let last = null;
    const cb = (now, meta) => {
      if (last != null && this.video.playbackRate === 1) {
        const d = meta.mediaTime - last;
        if (d > 0 && d < 0.2) deltas.push(d);
      }
      last = meta.mediaTime;
      if (deltas.length < 20 && !this.video.paused) this.video.requestVideoFrameCallback(cb);
      else {
        this._detecting = false;
        if (deltas.length >= 8) {
          deltas.sort((a, b) => a - b);
          const est = 1 / deltas[Math.floor(deltas.length / 2)];
          const best = COMMON_FPS.reduce((p, c) => (Math.abs(c - est) < Math.abs(p - est) ? c : p));
          if (best !== this.record.fps) this.setFps(best, false);
        }
      }
    };
    this.video.requestVideoFrameCallback(cb);
  }

  // ---------- drawing ----------
  setTool(t) {
    this.tool = t;
    this.cancelPendingAngle();
    this.render();
  }

  cancelPendingAngle() {
    if (this.pendingAngle) {
      this.record.shapes = this.record.shapes.filter(s => s !== this.pendingAngle);
      this.pendingAngle = null;
      this.hint(null);
    }
  }

  hint(text) {
    this.hintEl.hidden = !text;
    if (text) this.hintEl.textContent = text;
  }

  pushUndo() {
    this.undoStack.push(JSON.stringify(this.record.shapes));
    if (this.undoStack.length > 50) this.undoStack.shift();
  }

  undo() {
    this.pendingAngle = null; this.hint(null);
    if (!this.undoStack.length) return;
    this.record.shapes = JSON.parse(this.undoStack.pop());
    this.commit();
  }

  clear() {
    if (!this.record.shapes.length) return;
    this.pushUndo();
    this.pendingAngle = null; this.hint(null);
    this.record.shapes = [];
    this.commit();
  }

  commit() { this.render(); this.onChange?.(this); }

  render() {
    const { ctx, dpr } = this;
    if (!ctx || !dpr) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.grid) this.drawGrid(ctx);
    const editing = this.tool !== 'erase' && this.tool !== 'free';
    for (const s of this.record.shapes) {
      drawShape(ctx, s, this.toScreen, 1, this.aspect, { w: this.cssW, h: this.cssH }, editing);
    }
  }

  drawGrid(ctx) {
    const r = this.rect;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    const n = 6;
    for (let i = 1; i < n; i++) {
      const x = r.x + (r.w * i) / n, y = r.y + (r.h * i) / n;
      ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); ctx.stroke();
    }
    ctx.restore();
  }

  localPoint(e) {
    const b = this.canvas.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top];
  }

  findHandle(p) {
    let best = null, bestD = 24;
    for (const s of this.record.shapes) {
      if (s.type === 'free') continue;
      s.pts.forEach((q, i) => {
        const sq = this.toScreen(q);
        const d = Math.hypot(sq[0] - p[0], sq[1] - p[1]);
        if (d < bestD) { bestD = d; best = { shape: s, index: i }; }
      });
    }
    return best;
  }

  onPointerDown(e) {
    this.onActivate?.(this);
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.localPoint(e);
    this.pointers.set(e.pointerId, p);

    if (this.pointers.size === 2) {
      // second finger → pinch; abandon whatever single-finger gesture was going on
      if (this.drag?.creating) {
        this.record.shapes = this.record.shapes.filter(s => s !== this.drag.shape);
        if (this.drag.shape === this.pendingAngle) this.pendingAngle = null;
        this.undoStack.pop();
        this.render();
      }
      const [a, b] = [...this.pointers.values()];
      this.drag = { type: 'pinch', dist: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
      return;
    }
    if (this.pointers.size > 2) return;

    const n = this.toNorm(...p);

    // Third point of a pending angle
    if (this.tool === 'angle' && this.pendingAngle) {
      const s = this.pendingAngle;
      s.pts[2] = n;
      this.drag = { type: 'handle', shape: s, index: 2, creating: true };
      this.render();
      return;
    }

    if (this.tool === 'erase') {
      let best = null, bestD = 22;
      for (const s of this.record.shapes) {
        const d = hitDistance(s, p, this.toScreen);
        if (d < bestD) { bestD = d; best = s; }
      }
      if (best) {
        this.pushUndo();
        this.record.shapes = this.record.shapes.filter(s => s !== best);
        this.commit();
      }
      this.drag = null;
      return;
    }

    if (this.tool !== 'free') {
      const h = this.findHandle(p);
      if (h) {
        this.pushUndo();
        this.drag = { type: 'handle', ...h, moved: false };
        return;
      }
    }

    if (this.tool === 'pan') {
      this.drag = { type: 'pan', start: p, panX: this.panX, panY: this.panY };
      return;
    }

    // start a new shape
    this.pushUndo();
    const shape = { type: this.tool, color: this.color, pts: this.tool === 'free' ? [n] : [n, n] };
    this.record.shapes.push(shape);
    this.drag = { type: this.tool === 'free' ? 'free' : 'handle', shape, index: 1, creating: true, start: p };
    this.render();
  }

  onPointerMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.localPoint(e);
    this.pointers.set(e.pointerId, p);
    const d = this.drag;
    if (!d) return;

    if (d.type === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      this.panX += mid[0] - d.mid[0];
      this.panY += mid[1] - d.mid[1];
      this.zoomAt(dist / d.dist, mid[0], mid[1]);
      d.dist = dist; d.mid = mid;
    } else if (d.type === 'pan') {
      this.panX = d.panX + p[0] - d.start[0];
      this.panY = d.panY + p[1] - d.start[1];
      this.clampPan();
      this.applyView();
    } else if (d.type === 'handle') {
      d.shape.pts[d.index] = this.toNorm(...p);
      d.moved = true;
      this.render();
    } else if (d.type === 'free') {
      d.shape.pts.push(this.toNorm(...p));
      this.render();
    }
  }

  onPointerUp(e, cancelled = false) {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.localPoint(e);
    this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (d?.type === 'pinch') {
      if (this.pointers.size === 0) this.drag = null;
      return;
    }
    this.drag = null;
    if (!d) return;

    if (d.type === 'handle' && d.creating) {
      const s = d.shape;
      const tooSmall = d.start && Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) < 8;
      if (cancelled || (tooSmall && !(s === this.pendingAngle))) {
        this.record.shapes = this.record.shapes.filter(x => x !== s);
        this.undoStack.pop();
        if (s === this.pendingAngle) { this.pendingAngle = null; this.hint(null); }
        this.render();
        return;
      }
      if (s.type === 'angle' && s.pts.length === 2) {
        this.pendingAngle = s;
        this.hint('Tap to place the third point of the angle');
        this.render();
        return;
      }
      if (s === this.pendingAngle) { this.pendingAngle = null; this.hint(null); }
      this.commit();
    } else if (d.type === 'handle') {
      if (d.moved) this.commit(); else this.undoStack.pop();
    } else if (d.type === 'free') {
      if (d.shape.pts.length < 3) {
        this.record.shapes = this.record.shapes.filter(x => x !== d.shape);
        this.undoStack.pop();
        this.render();
      } else this.commit();
    }
  }

  onWheel(e) {
    e.preventDefault();
    const p = this.localPoint(e);
    this.zoomAt(Math.exp(-e.deltaY * 0.0015), p[0], p[1]);
  }

  // ---------- export ----------
  /** Render current frame + drawings at native resolution. */
  snapshot() {
    const v = this.video;
    const W = v.videoWidth, H = v.videoHeight;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    if (this.mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(v, 0, 0, W, H);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const map = ([x, y]) => [(this.mirror ? 1 - x : x) * W, y * H];
    const s = Math.max(1, W / Math.max(1, this.rect.w));
    for (const sh of this.record.shapes) drawShape(ctx, sh, map, s, this.aspect, { w: W, h: H });
    return new Promise(res => c.toBlob(res, 'image/png'));
  }
}
