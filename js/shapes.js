// Shape model + rendering. Shapes are stored in normalized video coordinates
// (0..1 of the video frame) so they stick to the picture when zooming/panning.
//
// shape = { type, pts: [[x,y], ...], color }
//   line   : [a, b]        – shows its angle vs. horizontal
//   plane  : [a, b]        – line extended across the whole frame (swing plane)
//   arrow  : [a, b]
//   angle  : [a, vertex, c]
//   circle : [center, edge]
//   rect   : [a, b]
//   free   : [p0, p1, ...]

export const TOOLS = ['pan', 'line', 'plane', 'angle', 'circle', 'rect', 'arrow', 'free', 'erase'];
export const COLORS = ['#ffd60a', '#ff453a', '#32d74b', '#0a84ff', '#ffffff', '#bf5af2'];

const deg = r => (r * 180) / Math.PI;

/** Angle at vertex v between rays v→a and v→c, in degrees (0..180). */
export function angleAt(a, v, c) {
  const a1 = Math.atan2(a[1] - v[1], a[0] - v[0]);
  const a2 = Math.atan2(c[1] - v[1], c[0] - v[0]);
  let d = Math.abs(deg(a2 - a1));
  if (d > 180) d = 360 - d;
  return d;
}

/** Angle of segment vs. horizontal in degrees (0..90). */
export function lineTilt(a, b) {
  let d = Math.abs(deg(Math.atan2(b[1] - a[1], b[0] - a[0])));
  if (d > 90) d = 180 - d;
  return d;
}

function label(ctx, text, x, y, color, s) {
  ctx.save();
  ctx.font = `600 ${13 * s}px -apple-system, system-ui, sans-serif`;
  const w = ctx.measureText(text).width;
  const pad = 4 * s, h = 18 * s;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  roundRect(ctx, x - w / 2 - pad, y - h / 2, w + pad * 2, h, 4 * s);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5 * s);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draw a shape.
 * @param ctx   canvas 2d context
 * @param shape the shape
 * @param map   ([nx,ny]) => [px,py] normalized → canvas pixels
 * @param s     scale factor for line widths / fonts (device pixel ratio etc.)
 * @param aspect video width/height, so angles are measured in real pixels
 * @param bounds {w,h} canvas size, used for the extended "plane" line
 */
export function drawShape(ctx, shape, map, s, aspect, bounds, showHandles = false) {
  const P = shape.pts.map(map);
  const real = p => [p[0] * aspect, p[1]]; // undo non-square normalisation
  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = 3 * s;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 3 * s;

  switch (shape.type) {
    case 'line':
    case 'arrow': {
      const [a, b] = P;
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
      if (shape.type === 'arrow') {
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const L = 16 * s;
        ctx.beginPath();
        ctx.moveTo(...b);
        ctx.lineTo(b[0] - L * Math.cos(ang - 0.45), b[1] - L * Math.sin(ang - 0.45));
        ctx.lineTo(b[0] - L * Math.cos(ang + 0.45), b[1] - L * Math.sin(ang + 0.45));
        ctx.closePath(); ctx.fill();
      } else if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 40 * s) {
        const t = lineTilt(real(shape.pts[0]), real(shape.pts[1]));
        label(ctx, `${t.toFixed(1)}°`, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 16 * s, shape.color, s);
      }
      break;
    }
    case 'plane': {
      const [a, b] = P;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      const ext = (bounds.w + bounds.h) * 2 / len;
      ctx.setLineDash([10 * s, 7 * s]);
      ctx.beginPath();
      ctx.moveTo(a[0] - dx * ext, a[1] - dy * ext);
      ctx.lineTo(b[0] + dx * ext, b[1] + dy * ext);
      ctx.stroke();
      ctx.setLineDash([]);
      const t = lineTilt(real(shape.pts[0]), real(shape.pts[1]));
      label(ctx, `${t.toFixed(1)}°`, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 16 * s, shape.color, s);
      break;
    }
    case 'angle': {
      const [a, v, c] = P;
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...v);
      if (c) ctx.lineTo(...c);
      ctx.stroke();
      if (c) {
        const r = Math.min(34 * s, Math.hypot(a[0] - v[0], a[1] - v[1]) * 0.6, Math.hypot(c[0] - v[0], c[1] - v[1]) * 0.6);
        let a1 = Math.atan2(a[1] - v[1], a[0] - v[0]);
        let a2 = Math.atan2(c[1] - v[1], c[0] - v[0]);
        let diff = a2 - a1;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        ctx.globalAlpha = 0.25;
        ctx.beginPath(); ctx.moveTo(...v); ctx.arc(v[0], v[1], r, a1, a1 + diff, diff < 0); ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 1;
        const mid = a1 + diff / 2;
        const sp = shape.pts;
        const value = angleAt(real(sp[0]), real(sp[1]), real(sp[2]));
        label(ctx, `${value.toFixed(1)}°`, v[0] + Math.cos(mid) * (r + 22 * s), v[1] + Math.sin(mid) * (r + 22 * s), shape.color, s);
      }
      break;
    }
    case 'circle': {
      const [c, e] = P;
      ctx.beginPath(); ctx.arc(c[0], c[1], Math.hypot(e[0] - c[0], e[1] - c[1]), 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(c[0], c[1], 2.5 * s, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case 'rect': {
      const [a, b] = P;
      ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      break;
    }
    case 'free': {
      ctx.beginPath();
      P.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
      ctx.stroke();
      break;
    }
  }

  if (showHandles && shape.type !== 'free') {
    ctx.shadowBlur = 0;
    for (const p of P) {
      ctx.beginPath(); ctx.arc(p[0], p[1], 7 * s, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill();
      ctx.lineWidth = 2 * s; ctx.strokeStyle = shape.color; ctx.stroke();
    }
  }
  ctx.restore();
}

function distToSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Distance in screen pixels from point p to the shape outline. */
export function hitDistance(shape, p, map) {
  const P = shape.pts.map(map);
  switch (shape.type) {
    case 'circle': {
      const r = Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]);
      return Math.abs(Math.hypot(p[0] - P[0][0], p[1] - P[0][1]) - r);
    }
    case 'rect': {
      const [a, b] = P;
      const c = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
      return Math.min(...c.map((q, i) => distToSeg(p, q, c[(i + 1) % 4])));
    }
    case 'plane': {
      const [a, b] = P;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
    }
    default: {
      let d = Infinity;
      for (let i = 0; i < P.length - 1; i++) d = Math.min(d, distToSeg(p, P[i], P[i + 1]));
      return P.length === 1 ? Math.hypot(p[0] - P[0][0], p[1] - P[0][1]) : d;
    }
  }
}
