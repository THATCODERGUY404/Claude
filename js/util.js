export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function fmtTime(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export function fmtBytes(n) {
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.round(n / 1e3)} kB`;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

let toastTimer;
export function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/** Read duration + a JPEG thumbnail from a video blob. Never rejects. */
export function probeVideo(blob) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    const url = URL.createObjectURL(blob);
    let done = false;
    const finish = (thumb = null) => {
      if (done) return;
      done = true;
      const duration = isFinite(v.duration) ? v.duration : 0;
      URL.revokeObjectURL(url);
      v.removeAttribute('src'); v.load();
      resolve({ duration, thumb });
    };
    const timer = setTimeout(() => finish(), 8000);
    v.addEventListener('loadedmetadata', () => {
      v.currentTime = Math.min(v.duration * 0.4 || 0, 2);
    });
    v.addEventListener('seeked', () => {
      try {
        const w = 240, h = Math.round((w * v.videoHeight) / v.videoWidth) || 135;
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(v, 0, 0, w, h);
        clearTimeout(timer);
        finish(c.toDataURL('image/jpeg', 0.7));
      } catch { finish(); }
    });
    v.addEventListener('error', () => { clearTimeout(timer); finish(); });
    v.src = url;
  });
}
