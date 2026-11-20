// End-to-end smoke test. Usage: node tests/smoke.cjs <video1> <video2> [outDir]
// Expects the app to be served at http://localhost:8123/
const { chromium, devices } = require('playwright');
const [v1, v2, out = '.'] = process.argv.slice(2);
const assert = (c, m) => { if (!c) throw new Error('Assertion failed: ' + m); console.log('ok -', m); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await page.goto('http://localhost:8123/');
  assert(await page.isVisible('#lib-empty'), 'empty library shown');

  await page.setInputFiles('#inp-import', v1);
  await page.waitForSelector('#view-analyze.active');
  await page.waitForFunction(() => document.querySelector('.pane video').readyState >= 2);
  assert(true, 'single import opens analyzer');

  // fps detection by playing a bit
  await page.click('#btn-play');
  await page.waitForTimeout(1200);
  await page.click('#btn-play');
  const fps = await page.textContent('#btn-fps');
  console.log('   detected', fps);

  // frame stepping
  await page.click('.phase[data-k="address"]'); // unset => sets
  await page.evaluate(() => { document.querySelector('#scrub').value = 0; document.querySelector('#scrub').dispatchEvent(new Event('input')); });
  await page.waitForTimeout(300);
  await page.click('#btn-fwd1'); await page.waitForTimeout(150);
  await page.click('#btn-fwd1'); await page.waitForTimeout(150);
  await page.click('#btn-fwd1'); await page.waitForTimeout(250);
  const f = await page.textContent('#frame');
  assert(f === 'F3', `stepped 3 frames (got ${f})`);
  await page.click('.phase[data-k="address"]');  // jump? address set earlier (at ~1.2s) -> jumps
  // set address here via long press emulation
  await page.click('#btn-back1'); await page.waitForTimeout(200);

  const setPhaseAt = async (k, t) => {
    await page.evaluate(t => { const s = document.querySelector('#scrub'); s.value = Math.round(t / 3 * 1000); s.dispatchEvent(new Event('input')); }, t);
    await page.waitForTimeout(300);
    const box = await page.locator(`.phase[data-k="${k}"]`).boundingBox();
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.down(); await page.waitForTimeout(600); await page.mouse.up();
  };
  await setPhaseAt('address', 0.3);
  await setPhaseAt('top', 1.5);
  await setPhaseAt('impact', 1.9);
  await setPhaseAt('finish', 2.6);
  const tempo = await page.textContent('#tempo');
  assert(/Tempo [\d.]+ : 1/.test(tempo), `tempo shown: "${tempo}"`);

  // draw: line, angle
  const pane = await page.locator('.pane canvas').boundingBox();
  const P = (fx, fy) => [pane.x + pane.width * fx, pane.y + pane.height * fy];
  const drag = async (a, b) => { await page.mouse.move(...a); await page.mouse.down(); await page.mouse.move(...b, { steps: 5 }); await page.mouse.up(); };
  await page.click('.tool[data-tool="line"]');
  await drag(P(0.3, 0.3), P(0.7, 0.5));
  await page.click('.tool[data-tool="angle"]');
  await drag(P(0.4, 0.2), P(0.45, 0.5));
  assert(await page.isVisible('.pane-hint'), 'angle asks for third point');
  await page.mouse.click(...P(0.6, 0.7));
  await page.click('.tool[data-tool="circle"]');
  await drag(P(0.5, 0.15), P(0.55, 0.2));
  await page.click('.tool[data-tool="plane"]');
  await drag(P(0.2, 0.8), P(0.6, 0.4));
  let n = await page.evaluate(() => new Promise(r => setTimeout(async () => {
    const req = indexedDB.open('swinglab'); req.onsuccess = () => {
      const g = req.result.transaction('videos').objectStore('videos').getAll(); g.onsuccess = () => r(g.result[0].shapes.length);
    };
  }, 700)));
  assert(n === 4, `4 shapes persisted (got ${n})`);
  await page.click('#btn-undo');
  await page.click('#btn-color');
  await page.click('.tool[data-tool="pan"]');
  await page.screenshot({ path: `${out}/analyze.png` });

  // pinch-ish zoom via wheel
  await page.mouse.move(...P(0.5, 0.5));
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(100);

  // compare
  await page.click('#btn-back');
  await page.setInputFiles('#inp-import', v2);
  await page.waitForSelector('#view-analyze.active');
  await page.click('#btn-compare');
  await page.click('#pick-list .lib-item');
  await page.waitForFunction(() => document.querySelectorAll('.pane').length === 2);
  await page.waitForTimeout(500);
  await page.click('#btn-link');
  await page.click('#btn-fwd1'); await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/compare.png` });
  await page.click('#btn-overlay'); await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/overlay.png` });
  assert(await page.isVisible('#opacity-wrap'), 'overlay opacity slider');

  await page.click('#btn-back');
  await page.waitForSelector('#view-library.active');
  assert(await page.locator('#lib-list .lib-item').count() === 2, 'library lists 2 swings');
  await page.screenshot({ path: `${out}/library.png` });

  // landscape
  await page.setViewportSize({ width: 844, height: 390 });
  await page.click('#lib-list .lib-item >> nth=1');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/landscape.png` });

  assert(errors.length === 0, `no JS errors ${errors.join(' | ')}`);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
