import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = path === "/" ? "/index.html" : path;
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    response.end(await readFile(join(root, normalize(file))));
  } catch { response.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
const z = "\u2063";
const fixtures = [
  { pitch: "V", span: 2, row: "(V"+z+"D"+z+"G)."+z+"A."+z+"N.("+z+"D"+z+"G)./."+z+"A."+z+"N."+z+"A./(B"+z+"D"+z+"G)."+z+"A."+z+"N.("+z+"D"+z+"G)./."+z+"N."+z+"A."+z+"N./" },
  { pitch: "N", span: 4, row: "(N"+z+"D"+z+"G)."+z+"A."+z+"N.("+z+"D"+z+"G)./."+z+"A."+z+"N."+z+"A./("+z+"D"+z+"G)."+z+"A."+z+"N.("+z+"D"+z+"G)./."+z+"A."+z+"N../" },
  { pitch: "B", span: 4, row: "(B"+z+"D"+z+"G)."+z+"A."+z+"N.("+z+"D"+z+"G)./."+z+"A."+z+"N."+z+"A./("+z+"D"+z+"G)."+z+"A."+z+"N.("+z+"D"+z+"G)./."+z+"A."+z+"N../" },
];
const snapshot = () => page.evaluate(() => {
  const app = window.__app;
  return {
    text: app.getText(), diagnostics: document.querySelectorAll("#score-pane .diagnostic-box").length,
    measureCounts: app.painter.score.parts.map((part) => part.measures.length),
    tupletGlyphs: app.painter.score.parts.flatMap((part) => part.measures.flatMap((measure) =>
      measure.entries.filter((entry) => entry.notes?.some((note) => note.tuplet))
        .map((entry) => ({ expected: entry.notes[0].number,
          glyphs: app.painter.noteGroupEls(entry, entry.notes[0]).map((item) => item.element.textContent) })))),
    attacks: app.painter.score.parts.map((part) => part.measures.flatMap((measure) =>
      measure.entries.filter((entry) => entry.notes?.length && !entry.generatedTimingContinuation)
        .flatMap((entry) => entry.notes.filter((note) => !note.rest && !note.tieEnd).sort((a, b) => a.pitch - b.pitch).map((note) =>
          ({ beat: Math.floor(entry.position.toFloat() + 1e-8), pitch: note.pitch }))))),
    rows: app.painter.score.parts.flatMap((part, partIndex) => part.measures.flatMap((measure, measureIndex) =>
      measure.entries.filter((entry) => entry.notes?.length).map((entry) => ({
        part: partIndex, measure: measureIndex, at: entry.position.toFloat(),
        duration: entry.duration?.toFloat(), rest: entry.rest,
        pitches: entry.notes.filter((note) => !note.rest).map((note) => note.pitch),
        tuplet: entry.notes.some((note) => note.tuplet),
      })))),
  };
});
const stable = (state, span) => state.rows.filter((row) => row.part === 0 || row.at >= span);
const assertBeatBrackets = (text, span) => {
  const row = text.split(/\r?\n/).find((line) => line.includes("[") && line.includes("/") && !line.startsWith("//"));
  const groups = row.split("/");
  for (let beat = 0; beat < span; beat++) assert(/^\[.*\]$/.test(groups[beat]), row);
};
try {
  await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "networkidle" });
  for (const fixture of fixtures) for (const showExplicitRests of [true, false]) {
    await page.evaluate(({ row, span, showExplicitRests }) => {
      const app = window.__app;
      app.documentFormat = "keyboard";
      app.slashOptions = {
        kind: "keyboard", voiceCount: 2, instrumentName: "钢琴", title: span+"拍三连音",
        subtitle: "", composer: "", arranger: "", lyricist: "", tempoBpm: 90,
        fifths: 0, beats: 4, beatType: 4, symbolDurations: { ".": 16 }, spaceDivision: null,
        noteDivision: null, braceMode: "arpeggio", bracketMode: "triplet", showExplicitRests,
      };
      app.setText("键盘谱\n4/4拍：\n点=16分音符\n"+row+"\n");
      app.setInputMode(true);
    }, { ...fixture, showExplicitRests });
    await page.waitForTimeout(300);
    const before = await snapshot();
    assert.equal(before.rows.find((row) => row.part === 1 && row.at === 0).duration, fixture.span);
    const point = await page.evaluate((pitch) => {
      const app = window.__app;
      const item = app._sourceNotes.find((source) => app.getText().slice(source.from, source.to) === pitch && source.partIndex === 1);
      const box = app.painter.noteGroupEls(item.chord, item.note)[0].element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }, fixture.pitch);
    await page.mouse.click(point.x, point.y);
    await page.mouse.click(point.x, point.y, { button: "right" });
    await page.getByRole("menuitem", { name: "在光标处创建三连音", exact: true }).click();
    await page.waitForTimeout(300);
    const check = (state) => {
      assert.equal(state.diagnostics, 0, state.text);
      assert.deepEqual(state.measureCounts, [1, 1]);
      assertBeatBrackets(state.text, fixture.span);
      assert.deepEqual(stable(state, fixture.span), stable(before, fixture.span));
      const tuples = state.rows.filter((row) => row.part === 1 && row.tuplet);
      assert.equal(tuples.length, 3, state.text);
      assert.equal(state.tupletGlyphs.length, 3);
      for (const member of state.tupletGlyphs) assert.deepEqual(member.glyphs, [member.expected],
        "a long tuplet member was expanded into extra dashes or rest zeroes");
      tuples.forEach((row, index) => {
        assert(Math.abs(row.at - index * fixture.span / 3) < 1e-8);
        assert(Math.abs(row.duration - fixture.span / 3) < 1e-8);
      });
      assert(!state.rows.some((row) => row.part === 1 && row.at < fixture.span && !row.tuplet));
      return tuples;
    };
    const created = await snapshot();
    check(created);
    if (showExplicitRests) await page.screenshot({ path: join(process.env.TEMP ?? process.cwd(), "long-triplet-created-"+fixture.pitch+".png") });
    if (fixture.pitch === "B") {
      assert.deepEqual(created.tupletGlyphs.map((member) => member.glyphs.join("")), ["5", "0", "0"]);
      if (showExplicitRests) {
        const clip = await page.evaluate(() => {
          const app = window.__app;
          const boxes = app.painter.score.parts.flatMap((part) => part.measures[0].entries
            .filter((entry) => entry.notes?.length).flatMap((entry) => entry.notes.flatMap((note) =>
              app.painter.noteGroupEls(entry, note).map((item) => item.element.getBoundingClientRect()))));
          const left = Math.min(...boxes.map((box) => box.left)) - 35;
          const top = Math.min(...boxes.map((box) => box.top)) - 30;
          return { x: left, y: top, width: Math.max(...boxes.map((box) => box.right)) - left + 45,
            height: Math.max(...boxes.map((box) => box.bottom)) - top + 25 };
        });
        await page.screenshot({ path: join(process.env.TEMP ?? process.cwd(), "long-triplet-5-0-0.png"), clip });
      }
    }
    const guide = await page.evaluate(() => {
      const app = window.__app;
      const svg = document.querySelector("#score-pane svg");
      return app.painter.rhythmInputSpansForPage(0, svg).flatMap((span) => span.tupletGroups)
        .filter((group) => group.partIndex === 1).map((group) => ({
          end: group.endTick, ticks: group.anchors.map((anchor) => anchor.tick),
        }));
    });
    assert.equal(guide.length, 1);
    assert(Math.abs(guide[0].end - fixture.span) < 1e-8);
    assert.equal(guide[0].ticks.length, 3);
    await page.locator(".tuplet-number rect").first().click();
    assert.deepEqual(await page.evaluate(() => window.__app._selectedObjects.map((item) => item.kind)), ["tuplet"],
      "the tight numeral hit area must still select the tuplet");
    for (const [memberIndex, degree] of [[1, "1"], [2, "2"]]) {
      const point = await page.evaluate((targetTick) => {
        const app = window.__app;
        const svg = document.querySelector("#score-pane svg");
        const span = app.painter.rhythmInputSpansForPage(0, svg).find((item) => item.measureIndex === 0 && item.partIndexes.includes(1));
        const group = span.tupletGroups.find((item) => item.partIndex === 1);
        const anchor = group.anchors.find((item) => Math.abs(item.tick - targetTick) < 1e-8);
        const member = app.painter.score.parts[1].measures[0].entries.find((entry) =>
          entry.notes?.some((note) => note.tuplet) && Math.abs(entry.position.toFloat() - targetTick) < 1e-8);
        const box = app.painter.noteGroupEls(member, member.notes[0])[0].element.getBoundingClientRect();
        // The middle member shares x with the bracket numeral. Click the
        // member glyph, since the row's midpoint can hit the numeral's box.
        const point = new DOMPoint(anchor.x, 0).matrixTransform(svg.getScreenCTM());
        return { x: point.x, y: box.y + box.height / 2, target: document.elementFromPoint(point.x, box.y + box.height / 2)?.outerHTML.slice(0, 600), anchors: group.anchors.map((anchor) => ({ x: anchor.x, tick: anchor.tick })) };
      }, fixture.span * memberIndex / 3);
      await page.mouse.click(point.x, point.y);
      const selected = await page.evaluate(() => ({ offset: window.__app._input.cursor?.offset.toFloat(), part: window.__app._input.cursor?.partIndex }));
      assert(Math.abs(selected.offset - fixture.span * memberIndex / 3) < 1e-8 && selected.part === 1,
        JSON.stringify({ fixture, memberIndex, point, selected }));
      await page.keyboard.press(degree);
      await page.waitForTimeout(300);
      const typed = await snapshot();
      assert.equal(check(typed)[memberIndex].rest, false);
    }
    const edited = await snapshot();
    await page.evaluate((text) => window.__app.setText(text), edited.text);
    await page.waitForTimeout(300);
    const reloaded = await snapshot();
    check(reloaded);
    assert.deepEqual(reloaded.rows, edited.rows);
    if (showExplicitRests) await page.screenshot({ path: join(process.env.TEMP ?? process.cwd(), "long-triplet-"+fixture.span+".png") });
    const plain = edited.text.replace(/^\s*\/\/\s*@jpeditor\s+\{[^\r\n]*\}\s*$/gmi, "");
    await page.evaluate((text) => {
      const app = window.__app;
      app.slashOptions.annotations = [];
      app.setText(text);
    }, plain);
    await page.waitForTimeout(300);
    const standalone = await snapshot();
    assert.equal(standalone.diagnostics, 0, standalone.text);
    assert.deepEqual(standalone.measureCounts, [1, 1]);
    assert.deepEqual(standalone.attacks[0], before.attacks[0]);
  }
  assert.deepEqual(errors, []);
  console.log("long-triplet-check: ok (2/4 beats, UI creation and member entry, save/reload, standalone beat brackets)");
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
