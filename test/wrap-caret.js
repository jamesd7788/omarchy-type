/* The caret must track the active word wherever it wraps to.
 *
 * Because the type is a fixed size, a narrow window rewraps rather than
 * shrinking -- so the caret has to land correctly on the second and third
 * lines, and follow a resize that reflows the text mid-test.
 *
 *   node test/wrap-caret.js             (via test/run, which starts both
 *                                        the app and the browser for you)
 */
const { connect, sleep, results } = require("./cdp");

const WIDTHS = [1400, 700, 520, 420];
const WORDS = 26;          // enough to wrap onto lines 2 and 3 at any width

/* Where the caret sits, relative to the character it marks. */
const PROBE = `(()=>{
  const w = document.querySelectorAll('.word')[wi];
  const wr = w.getBoundingClientRect();
  const c = document.getElementById('caret').getBoundingClientRect();
  const wrap = document.getElementById('wrap').getBoundingClientRect();
  const got = (typed[wi] || '').length;
  const spans = w.children;
  const want = got === 0
    ? spans[0].getBoundingClientRect().left
    : spans[Math.min(got, spans.length) - 1].getBoundingClientRect().right;
  return JSON.stringify({
    dx: (c.left + c.width / 2) - want,
    sameLine: Math.abs((c.top + c.height / 2) - (wr.top + wr.height / 2)) < 28,
    inView: c.top >= wrap.top - 6 && c.bottom <= wrap.bottom + 6,
    wordInView: wr.top >= wrap.top - 6 && wr.bottom <= wrap.bottom + 6,
  });
})()`;

const sane = (g) => Math.abs(g.dx) <= 2 && g.sameLine && g.inView && g.wordInView;

(async () => {
  const page = await connect();
  const r = results();

  for (const w of WIDTHS) {
    await page.setViewport(w);
    await sleep(400);
    await page.evaluate(
      `setZen(false); caret='bar'; paintModes(); setMaster(false); setMode('time',60); again();`);
    await sleep(350);

    let bad = 0, worst = 0;
    for (let n = 0; n < WORDS; n++) {
      await page.typeString(await page.evaluate("words[wi]"));
      // The caret glides over ~0.1s; let it settle before measuring.
      await sleep(180);
      const g = JSON.parse(await page.evaluate(PROBE));
      worst = Math.max(worst, Math.abs(g.dx));
      if (!sane(g)) bad++;
      await page.type(" ");
      await sleep(8);
    }

    const lines = await page.evaluate(`(()=>{
      const wrap = document.getElementById('wrap').getBoundingClientRect();
      const tops = [...new Set([...document.querySelectorAll('.word')]
        .map(w => Math.round(w.getBoundingClientRect().top)))].sort((a,b)=>a-b);
      return tops.filter(y => y >= wrap.top - 2 && y < wrap.bottom - 4).length;
    })()`);

    r.ok(`@${w}px caret tracks the word across wrapped lines`, bad === 0,
      `${WORDS - bad}/${WORDS} ok, worst dx ${worst.toFixed(2)}px, ${lines} lines`);
  }

  // Reflow mid-test: the caret must follow, not strand itself.
  await page.setViewport(1400);
  await sleep(350);
  await page.evaluate(`setMode('time',60); again();`);
  await sleep(300);
  for (let n = 0; n < 14; n++) {
    await page.typeString(await page.evaluate("words[wi]"));
    await page.type(" ");
    await sleep(8);
  }
  await page.typeString("ab", 20);
  await sleep(250);

  await page.setViewport(520);
  await sleep(700);
  const after = JSON.parse(await page.evaluate(PROBE));
  r.ok("caret follows a mid-test resize", sane(after),
    `dx ${after.dx.toFixed(2)}, inView=${after.inView}, wordInView=${after.wordInView}`);

  await page.clearViewport();
  const good = r.report();
  page.close();
  process.exit(good ? 0 : 1);
})().catch((e) => { console.error("ERROR " + e.message); process.exit(1); });
