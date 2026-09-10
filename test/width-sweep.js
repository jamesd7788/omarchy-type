/* Caret geometry and layout across viewport widths.
 *
 * The type is a fixed size at every width, so these proportions must hold
 * everywhere: the line box is 1.5x the font, the bar caret's rise above
 * the ink is a constant fraction of the font, the underscore spans exactly
 * one character cell, and three lines stay visible.
 *
 *   node test/width-sweep.js            (needs the app running on 8421 and
 *                                        chromium on 9222 -- see test/run)
 */
const { connect, sleep, results } = require("./cdp");

const WIDTHS = [1400, 1100, 900, 760, 680, 560, 480, 400, 360];

(async () => {
  const page = await connect({ match: "8421" });
  const r = results();
  const rows = [];

  for (const w of WIDTHS) {
    await page.setViewport(w);
    await sleep(350);
    await page.evaluate(
      `setZen(false); caret='bar'; paintModes(); setMaster(false); setMode('time',30); again();`);
    await sleep(300);
    await page.evaluate(`words.splice(0,2,'apply','gypsy'); render(); moveCaret();`);
    await sleep(150);
    await page.typeString("app", 25);
    await sleep(350);

    const g = JSON.parse(await page.evaluate(`(()=>{
      const cs = getComputedStyle(document.documentElement);
      const c = document.getElementById('caret').getBoundingClientRect();
      const spans = [...document.querySelectorAll('.word')[0].children];
      const next = spans[3].getBoundingClientRect();
      const words = document.getElementById('words');
      const wrap = document.getElementById('wrap').getBoundingClientRect();
      const wcs = getComputedStyle(words);
      const tops = [...new Set([...document.querySelectorAll('.word')]
        .map(w => Math.round(w.getBoundingClientRect().top)))].sort((a,b)=>a-b);
      return JSON.stringify({
        fontSize: parseFloat(wcs.fontSize),
        line: parseFloat(wcs.lineHeight),
        capTop: parseFloat(cs.getPropertyValue('--cap-top')),
        ink: parseFloat(cs.getPropertyValue('--ink')),
        charW: parseFloat(cs.getPropertyValue('--char-w')),
        caretH: c.height, caretW: c.width,
        cellW: next.width,
        dLeft: c.left - next.left,
        overTop: parseFloat(cs.getPropertyValue('--cap-top')) - (c.top - next.top),
        visible: tops.filter(y => y >= wrap.top - 2 && y < wrap.bottom - 4).length,
      });
    })()`));
    rows.push({ w, ...g });
  }
  await page.clearViewport();

  console.log("width  font  line  ratio ink   caretH cellW  charW  dLeft  rise/em lines");
  for (const x of rows) {
    console.log(
      String(x.w).padEnd(6),
      String(x.fontSize).padEnd(5),
      String(x.line).padEnd(5),
      (x.line / x.fontSize).toFixed(2).padEnd(5),
      x.ink.toFixed(1).padEnd(5),
      x.caretH.toFixed(1).padEnd(6),
      x.cellW.toFixed(2).padEnd(6),
      x.charW.toFixed(2).padEnd(6),
      x.dLeft.toFixed(2).padEnd(6),
      (x.overTop / x.fontSize).toFixed(3).padEnd(7),
      String(x.visible));
  }
  console.log();

  // The font must not shrink: a narrow window rewraps instead.
  const sizes = [...new Set(rows.map((x) => x.fontSize))];
  r.ok("font size is fixed at every width", sizes.length === 1,
    `sizes: ${sizes.join(", ")}`);

  const ratioBad = rows.filter((x) => Math.abs(x.line / x.fontSize - 1.5) > 0.02);
  r.ok("line box is always 1.5x the font", ratioBad.length === 0,
    ratioBad.map((x) => `${x.w}px:${(x.line / x.fontSize).toFixed(2)}`).join(" "));

  const cellBad = rows.filter((x) => Math.abs(x.charW - x.cellW) > 0.6);
  r.ok("--char-w matches the real character cell", cellBad.length === 0,
    cellBad.map((x) => `${x.w}px`).join(" "));

  const offBad = rows.filter((x) => Math.abs(x.dLeft + x.caretW / 2) > 0.8);
  r.ok("bar caret straddles the character boundary", offBad.length === 0,
    offBad.map((x) => `${x.w}px:${x.dLeft.toFixed(2)}`).join(" "));

  const riseBad = rows.filter((x) => {
    const f = x.overTop / x.fontSize;
    return f < 0.15 || f > 0.45;
  });
  r.ok("bar caret rise scales with the type", riseBad.length === 0,
    riseBad.map((x) => `${x.w}px:${(x.overTop / x.fontSize).toFixed(3)}`).join(" "));

  const lineBad = rows.filter((x) => x.visible !== 3);
  r.ok("three lines visible at every width", lineBad.length === 0,
    lineBad.map((x) => `${x.w}px:${x.visible}`).join(" "));

  const good = r.report();
  page.close();
  process.exit(good ? 0 : 1);
})().catch((e) => { console.error("ERROR " + e.message); process.exit(1); });
