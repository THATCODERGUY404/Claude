import { db } from './db.js';
import { Pane } from './pane.js';
import { COLORS } from './shapes.js';
import { $, $$, uid, fmtTime, fmtBytes, debounce, toast, probeVideo } from './util.js';

const PHASES = [
  ['address', 'Address'],
  ['top', 'Top'],
  ['impact', 'Impact'],
  ['finish', 'Finish'],
];
const SPEEDS = [1, 0.5, 0.25, 0.1];
const FPS_CHOICES = [24, 25, 30, 50, 60, 120, 240];

const state = {
  panes: [],
  active: null,
  linked: false,
  linkOffset: 0,   // pane[1].time - pane[0].time when linked
  overlay: false,
  speedIdx: 0,
  loop: false,
  tool: 'pan',
  colorIdx: 0,
};

// ---------------------------------------------------------------- persistence
const savers = new Map();
function saveRecord(rec) {
  if (!savers.has(rec.id)) savers.set(rec.id, debounce(r => db.put(r).catch(err => console.error(err)), 400));
  savers.get(rec.id)(rec);
}

// ---------------------------------------------------------------- views
function show(view) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
}

// ---------------------------------------------------------------- library
async function renderLibrary() {
  const list = $('#lib-list');
  const items = await db.list();
  $('#lib-empty').hidden = items.length > 0;
  list.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'lib-item';
    const marks = PHASES.filter(([k]) => it.markers?.[k] != null).length;
    li.innerHTML = `
      <div class="thumb">${it.thumb ? `<img alt="" src="${it.thumb}">` : ''}<span class="dur">${fmtTime(it.duration || 0)}</span></div>
      <div class="meta">
        <div class="name"></div>
        <div class="sub">${new Date(it.created).toLocaleDateString()} · ${fmtBytes(it.size)}${marks ? ` · ${marks}/4 phases` : ''}${it.shapes?.length ? ` · ${it.shapes.length} drawings` : ''}</div>
      </div>
      <button class="icon-btn del" aria-label="Delete">${ICONS.trash}</button>`;
    $('.name', li).textContent = it.name;
    li.addEventListener('click', e => {
      if (e.target.closest('.del')) return;
      openAnalyzer(it.id);
    });
    $('.del', li).addEventListener('click', async () => {
      if (!confirm(`Delete "${it.name}"?`)) return;
      await db.delete(it.id);
      renderLibrary();
    });
    list.appendChild(li);
  }
}

async function importFiles(files) {
  if (!files.length) return;
  navigator.storage?.persist?.();
  let lastId;
  for (const file of files) {
    toast(`Importing ${file.name || 'video'}…`);
    const { duration, thumb } = await probeVideo(file);
    const base = (file.name || '').replace(/\.[^.]+$/, '');
    const rec = {
      id: uid(),
      name: base && !/^(IMG|VID|MOV|PXL)_?\d/i.test(base) ? base : `Swing ${new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`,
      blob: new Blob([file], { type: file.type || 'video/mp4' }),
      created: Date.now(),
      duration, thumb,
      fps: null, markers: {}, shapes: [],
    };
    try {
      await db.put(rec);
      lastId = rec.id;
    } catch (err) {
      console.error(err);
      toast('Could not save video (storage full?)');
    }
  }
  await renderLibrary();
  if (files.length === 1 && lastId) openAnalyzer(lastId);
}

// ---------------------------------------------------------------- analyzer
async function openAnalyzer(id) {
  closePanes();
  const rec = await db.get(id);
  if (!rec) return;
  addPane(rec);
  $('#an-title').textContent = rec.name;
  show('analyze');
  updateLayout();
}

function closePanes() {
  state.panes.forEach(p => p.destroy());
  state.panes = [];
  state.active = null;
  state.linked = false;
  state.overlay = false;
}

function addPane(rec) {
  const pane = new Pane(rec, {
    onChange: p => { saveRecord(p.record); if (p === state.active) updateTransport(); },
    onActivate: p => setActive(p),
    onTime: p => { if (p === state.active) updateTransport(); },
  });
  pane.setTool(state.tool);
  pane.color = COLORS[state.colorIdx];
  pane.video.playbackRate = SPEEDS[state.speedIdx];
  pane.video.addEventListener('loadedmetadata', () => { updateTransport(); if (state.panes.length > 1) updateLayout(); });
  pane.video.addEventListener('play', () => updatePlayButton());
  pane.video.addEventListener('pause', () => updatePlayButton());
  pane.video.addEventListener('ended', () => {
    if (state.loop && (!state.linked || pane === state.panes[0])) loopRestart();
  });
  $('#panes').appendChild(pane.el);
  state.panes.push(pane);
  setActive(pane);
  return pane;
}

function setActive(p) {
  if (state.active === p) return;
  state.active = p;
  state.panes.forEach(x => x.el.classList.toggle('active', x === p));
  $('#an-title').textContent = p.record.name;
  updateTransport();
  updateToolbar();
}

function updateLayout() {
  const dual = state.panes.length > 1;
  const panes = $('#panes');
  panes.classList.toggle('dual', dual);
  panes.classList.toggle('overlay', dual && state.overlay);
  panes.classList.toggle('cols', dual && preferColumns());
  $('#btn-compare').classList.toggle('on', dual);
  $$('.dual-only').forEach(el => (el.hidden = !dual));
  $('#btn-link').classList.toggle('on', state.linked);
  $('#btn-overlay').classList.toggle('on', state.overlay);
  $('#opacity-wrap').hidden = !(dual && state.overlay);
  if (state.panes[1]) state.panes[1].video.style.opacity = dual && state.overlay ? $('#opacity').value / 100 : '';
  requestAnimationFrame(() => state.panes.forEach(p => p.layout()));
}

/** Side-by-side if that shows more video than stacking (e.g. portrait videos). */
function preferColumns() {
  const r = $('#panes').getBoundingClientRect();
  const a = state.panes.reduce((s, p) => s + p.aspect, 0) / state.panes.length;
  const area = (w, h) => (w / h > a ? h * h * a : (w * w) / a);
  return area(r.width / 2, r.height) > area(r.width, r.height / 2);
}

/** Panes that transport actions apply to. */
const targets = () => (state.linked ? state.panes : [state.active]).filter(Boolean);

function togglePlay() {
  const a = state.active;
  if (!a) return;
  if (a.paused) {
    if (state.linked) syncFollower();
    targets().forEach(p => p.play());
  } else targets().forEach(p => p.pause());
}

function step(n) {
  targets().forEach(p => p.step(n));
}

function seekActive(t) {
  const a = state.active;
  a.seek(t);
  if (state.linked && state.panes.length > 1) {
    const [p0, p1] = state.panes;
    if (a === p0) p1.seek(t + state.linkOffset);
    else p0.seek(t - state.linkOffset);
  }
}

function syncFollower() {
  if (state.panes.length < 2) return;
  const [p0, p1] = state.panes;
  const want = p0.time + state.linkOffset;
  if (Math.abs(p1.time - want) > 0.04) p1.seek(want);
}

function loopRange(p) {
  const m = p.record.markers;
  const start = m.address ?? 0;
  let end = m.finish ?? p.duration;
  if (end <= start) end = p.duration;
  return [start, end];
}

function loopRestart() {
  const lead = state.linked ? state.panes[0] : state.active;
  const [start] = loopRange(lead);
  seekActiveFor(lead, start);
  targets().forEach(p => p.play());
}

function seekActiveFor(p, t) {
  const prev = state.active;
  state.active = p; seekActive(t); state.active = prev;
}

// Animation loop: update UI while playing, handle looping + linked drift.
function tick() {
  const a = state.active;
  if (a && !a.paused) {
    updateTransport();
    if (state.loop) {
      const lead = state.linked ? state.panes[0] : a;
      const [, end] = loopRange(lead);
      if (lead.time >= end - 0.01 && end < lead.duration - 0.05) loopRestart();
    }
    if (state.linked && state.panes.length > 1) {
      const [p0, p1] = state.panes;
      const want = p0.time + state.linkOffset;
      if (!p0.paused && Math.abs(p1.time - want) > 0.08 && want >= 0 && want < p1.duration) p1.seek(want);
    }
  }
  requestAnimationFrame(tick);
}

function updatePlayButton() {
  const playing = state.active && !state.active.paused;
  $('#btn-play').innerHTML = playing ? ICONS.pause : ICONS.play;
}

function updateTransport() {
  const p = state.active;
  if (!p) return;
  const d = p.duration || 0;
  const t = p.time;
  const scrub = $('#scrub');
  if (!scrub.matches(':active')) scrub.value = d ? Math.round((t / d) * 1000) : 0;
  $('#time').textContent = `${fmtTime(t)}`;
  $('#frame').textContent = `F${p.frame}`;
  $('#btn-fps').textContent = `${p.fps}fps`;
  updatePlayButton();

  // marker ticks on the timeline
  const ticks = $('#ticks');
  ticks.innerHTML = '';
  const m = p.record.markers;
  for (const [k, label] of PHASES) {
    const chip = $(`.phase[data-k="${k}"]`);
    const set = m[k] != null;
    chip.classList.toggle('set', set);
    chip.classList.toggle('here', set && Math.abs(m[k] - t) < 0.5 / p.fps);
    $('.pt', chip).textContent = set ? fmtTime(m[k]).replace(/^0:/, '') : 'set';
    if (set && d) {
      const tk = document.createElement('i');
      tk.className = `tick tick-${k}`;
      tk.style.left = `${(m[k] / d) * 100}%`;
      tk.title = label;
      ticks.appendChild(tk);
    }
  }
  if (m.address != null && m.top != null && m.impact != null && m.top > m.address && m.impact > m.top) {
    const back = m.top - m.address, down = m.impact - m.top;
    $('#tempo').innerHTML = `Tempo <b>${(back / down).toFixed(1)} : 1</b> · back ${back.toFixed(2)}s · down ${down.toFixed(2)}s`;
  } else {
    $('#tempo').textContent = 'Mark Address, Top & Impact to see tempo (long-press a phase to set it)';
  }
}

function updateToolbar() {
  $$('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === state.tool));
  $('#btn-color').style.setProperty('--c', COLORS[state.colorIdx]);
  const p = state.active;
  $('#btn-grid').classList.toggle('on', !!p?.grid);
  $('#btn-mirror').classList.toggle('on', !!p?.mirror);
  $('#btn-speed').textContent = `${SPEEDS[state.speedIdx]}×`;
  $('#btn-loop').classList.toggle('on', state.loop);
}

// ---------------------------------------------------------------- phases
function setPhase(k) {
  const p = state.active;
  const m = p.record.markers;
  if (m[k] != null && Math.abs(m[k] - p.time) < 0.5 / p.fps) {
    delete m[k];
    toast(`${k[0].toUpperCase() + k.slice(1)} cleared`);
  } else {
    m[k] = p.time;
    toast(`${k[0].toUpperCase() + k.slice(1)} set at ${fmtTime(p.time)}`);
  }
  navigator.vibrate?.(15);
  p.commit();
}

function bindPhaseChip(chip) {
  const k = chip.dataset.k;
  let timer, long = false;
  chip.addEventListener('pointerdown', () => {
    long = false;
    timer = setTimeout(() => { long = true; setPhase(k); }, 450);
  });
  const cancel = () => clearTimeout(timer);
  chip.addEventListener('pointerup', cancel);
  chip.addEventListener('pointerleave', cancel);
  chip.addEventListener('pointercancel', cancel);
  chip.addEventListener('contextmenu', e => e.preventDefault());
  chip.addEventListener('click', () => {
    if (long) return;
    const p = state.active;
    if (!p) return;
    const m = p.record.markers;
    if (m[k] == null) { setPhase(k); return; }
    targets().forEach(x => x.pause());
    if (state.linked && state.panes.length > 1) {
      // jump each linked pane to its own marker if it has one
      state.panes.forEach(x => x.seek(x.record.markers[k] ?? m[k]));
      if (state.panes.every(x => x.record.markers[k] != null)) {
        state.linkOffset = state.panes[1].record.markers[k] - state.panes[0].record.markers[k];
      }
    } else p.seek(m[k]);
  });
}

// ---------------------------------------------------------------- compare
async function openComparePicker() {
  if (state.panes.length > 1) {
    // close second pane
    const second = state.panes.pop();
    second.destroy();
    state.linked = false; state.overlay = false;
    setActive(state.panes[0]);
    updateLayout();
    return;
  }
  const items = (await db.list()).filter(i => i.id !== state.active.record.id);
  const list = $('#pick-list');
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<li class="empty">Import another swing to compare.</li>';
  }
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'lib-item';
    li.innerHTML = `<div class="thumb">${it.thumb ? `<img alt="" src="${it.thumb}">` : ''}</div><div class="meta"><div class="name"></div><div class="sub">${new Date(it.created).toLocaleDateString()}</div></div>`;
    $('.name', li).textContent = it.name;
    li.addEventListener('click', async () => {
      closeSheet();
      const rec = await db.get(it.id);
      addPane(rec);
      updateLayout();
    });
    list.appendChild(li);
  }
  $('#sheet').hidden = false;
}

function closeSheet() { $('#sheet').hidden = true; }

function toggleLink() {
  if (state.panes.length < 2) return;
  state.linked = !state.linked;
  if (state.linked) {
    const [p0, p1] = state.panes;
    // Prefer aligning on a shared phase marker; otherwise keep current offset.
    const k = ['impact', 'top', 'address'].find(k => p0.record.markers[k] != null && p1.record.markers[k] != null);
    if (k) {
      state.linkOffset = p1.record.markers[k] - p0.record.markers[k];
      p0.pause(); p1.pause();
      p0.seek(p0.record.markers[k]); p1.seek(p1.record.markers[k]);
      toast(`Linked · aligned at ${k}`);
    } else {
      state.linkOffset = p1.time - p0.time;
      toast('Linked at current frames');
    }
  } else toast('Unlinked');
  updateLayout();
}

// ---------------------------------------------------------------- snapshot
async function snapshot() {
  const p = state.active;
  if (!p || !p.video.videoWidth) return;
  const blob = await p.snapshot();
  const name = `${p.record.name.replace(/[^\w-]+/g, '_')}_f${p.frame}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: p.record.name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Snapshot saved');
}

// ---------------------------------------------------------------- wiring
const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" fill="currentColor"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
};

function bindJog() {
  const jog = $('#jog');
  let last = null, acc = 0, offset = 0;
  const STEP_PX = 12;
  jog.addEventListener('pointerdown', e => {
    jog.setPointerCapture(e.pointerId);
    last = e.clientX; acc = 0;
    targets().forEach(p => p.pause());
  });
  jog.addEventListener('pointermove', e => {
    if (last == null) return;
    const dx = e.clientX - last;
    last = e.clientX;
    acc += dx; offset += dx;
    jog.style.backgroundPositionX = `${offset}px`;
    while (Math.abs(acc) >= STEP_PX) {
      const n = acc > 0 ? 1 : -1;
      step(n);
      acc -= n * STEP_PX;
    }
  });
  const end = () => { last = null; };
  jog.addEventListener('pointerup', end);
  jog.addEventListener('pointercancel', end);
}

function init() {
  // Library
  $('#inp-import').addEventListener('change', e => { importFiles([...e.target.files]); e.target.value = ''; });
  $('#inp-record').addEventListener('change', e => { importFiles([...e.target.files]); e.target.value = ''; });

  // Analyzer top bar
  $('#btn-back').addEventListener('click', () => { closePanes(); show('library'); renderLibrary(); });
  $('#an-title').addEventListener('click', () => {
    const p = state.active;
    const name = prompt('Rename swing', p.record.name);
    if (name && name.trim()) {
      p.record.name = name.trim();
      p.labelEl.textContent = p.record.name;
      $('#an-title').textContent = p.record.name;
      saveRecord(p.record);
    }
  });
  $('#btn-compare').addEventListener('click', openComparePicker);
  $('#btn-snap').addEventListener('click', snapshot);
  $('#btn-link').addEventListener('click', toggleLink);
  $('#btn-overlay').addEventListener('click', () => { state.overlay = !state.overlay; updateLayout(); });
  $('#opacity').addEventListener('input', e => {
    if (state.panes[1]) state.panes[1].video.style.opacity = e.target.value / 100;
  });
  $('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet' || e.target.closest('.sheet-close')) closeSheet(); });

  // Tools
  $$('.tool').forEach(b => b.addEventListener('click', () => {
    state.tool = b.dataset.tool;
    state.panes.forEach(p => p.setTool(state.tool));
    updateToolbar();
  }));
  $('#btn-color').addEventListener('click', () => {
    state.colorIdx = (state.colorIdx + 1) % COLORS.length;
    state.panes.forEach(p => (p.color = COLORS[state.colorIdx]));
    updateToolbar();
  });
  $('#btn-undo').addEventListener('click', () => state.active?.undo());
  $('#btn-clear').addEventListener('click', () => { if (state.active?.record.shapes.length && confirm('Remove all drawings on this swing?')) state.active.clear(); });
  $('#btn-grid').addEventListener('click', () => { const p = state.active; p.grid = !p.grid; p.render(); updateToolbar(); });
  $('#btn-mirror').addEventListener('click', () => { const p = state.active; p.mirror = !p.mirror; p.applyView(); updateToolbar(); });
  $('#btn-fit').addEventListener('click', () => state.active?.resetView());

  // Transport
  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-back1').addEventListener('click', () => step(-1));
  $('#btn-fwd1').addEventListener('click', () => step(1));
  $('#btn-speed').addEventListener('click', () => {
    state.speedIdx = (state.speedIdx + 1) % SPEEDS.length;
    state.panes.forEach(p => (p.video.playbackRate = SPEEDS[state.speedIdx]));
    updateToolbar();
  });
  $('#btn-loop').addEventListener('click', () => { state.loop = !state.loop; updateToolbar(); });
  $('#btn-fps').addEventListener('click', () => {
    const p = state.active;
    const i = FPS_CHOICES.indexOf(p.fps);
    p.setFps(FPS_CHOICES[(i + 1) % FPS_CHOICES.length]);
    toast(`Frame rate set to ${p.fps} fps`);
  });
  $('#scrub').addEventListener('input', e => {
    const p = state.active;
    targets().forEach(x => x.pause());
    seekActive((e.target.value / 1000) * p.duration);
  });
  $$('.phase').forEach(bindPhaseChip);
  bindJog();

  // Keyboard (desktop / bluetooth keyboards)
  document.addEventListener('keydown', e => {
    if (!$('#view-analyze').classList.contains('active') || e.target.matches('input, textarea')) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight') step(e.shiftKey ? 10 : 1);
    else if (e.key === 'ArrowLeft') step(e.shiftKey ? -10 : -1);
    else if (e.key === 'z' && (e.metaKey || e.ctrlKey)) state.active?.undo();
  });

  window.addEventListener('resize', debounce(() => { if (state.panes.length > 1) updateLayout(); }, 150));

  updateToolbar();
  renderLibrary();
  requestAnimationFrame(tick);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
