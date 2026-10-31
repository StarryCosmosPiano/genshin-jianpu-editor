// Current source by default; APP_TEST_URL can target the production build.
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";
import { acceptFixtureImport } from "./browser-test-helpers.mjs";

const server = process.env.APP_TEST_URL ? null : await createServer({
  server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false }, clearScreen: false,
});
if (server) await server.listen();
const url = process.env.APP_TEST_URL || server.resolvedUrls.local[0];
const browser = await chromium.launch(process.env.BROWSER_EXECUTABLE_PATH
  ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH, headless: true }
  : { channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1450, height: 960 } });
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => localStorage.setItem("jpeditor:workspace-mode:v1", "desktop"));

const text = () => page.evaluate(() => window.__app.getText());
const footer = () => page.evaluate(() => {
  const match = /\/\/ @jpeditor (\{[^\r\n]+\})/.exec(window.__app.getText());
  return match ? JSON.parse(match[1]) : null;
});
const snapshot = () => page.evaluate(() => {
  const app = window.__app;
  return {
    timeline: app.painter.score.parts.map(part => part.measures.map(measure =>
      measure.entries.filter(entry => Array.isArray(entry.notes)).map(chord => [
        chord.position.toString(), chord.duration?.toString(), chord.rest,
        chord.notes.map(note => [note.pitch, note.tuplet?.scope ?? null]),
      ]))),
    triplets: app.painter.score.parts.flatMap(part => part.measures.flatMap(measure =>
      measure.entries.flatMap(chord => chord.notes?.filter(note => note.tuplet).map(note => note.tuplet.scope) ?? []))),
    arpeggios: app.painter.score.crossPartArpeggios.map(mark => ({
      measure: mark.measure, offset: mark.offset.toString(), pitches: mark.pitches,
    })),
    diagnostics: app._slashTimingDiagnostics.map(item => item.message),
  };
});
const waitReload = () => page.waitForTimeout(450);

async function importFixture(source, bracketMode = "triplet") {
  await page.evaluate(source => { void window.__app.importBytes(new TextEncoder().encode(source), "文本自动同步.txt"); }, source);
  const dialog = page.locator(".slash-import-box");
  await dialog.waitFor();
  await dialog.locator('[data-slash-import="bracket"]').selectOption(bracketMode, { force: true });
  await dialog.locator('[data-slash-import="brace"]').selectOption("arpeggio", { force: true });
  await acceptFixtureImport(page, dialog.locator(".modal-footer").getByRole("button", { name: /^导入为/ }));
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => window.__app.documentFormat === "keyboard");
  await page.evaluate(() => { window.__app.setCodePaneCollapsed(false); window.__app.view.focus(); });
  await waitReload();
}

async function select(search, start = 0, length = search.length) {
  await page.evaluate(({ search, start, length }) => {
    const app = window.__app;
    const found = app.getText().indexOf(search);
    if (found < 0) throw new Error(`Missing source: ${search}`);
    const from = found + start;
    app.view.dispatch({ selection: { anchor: from, head: from + length }, scrollIntoView: true });
    app.view.focus();
  }, { search, start, length });
}

async function typeAt(search, offset, value) {
  await select(search, offset, 0);
  await page.keyboard.type(value);
}

const source = "键盘谱\n4/4拍：\n点=16分音符\n方括号=三连音\n花括号=琶音\nA.B.C./D.../E.../F.../\n";
try {
  await page.goto(url);
  await page.waitForFunction(() => window.__app?.painter.score && document.querySelector("#score-pane svg"));
  await importFixture(source);
  const original = await snapshot();
  assert.equal(original.triplets.length, 0);

  // Explicitly remove the existing footer, then prove a completed pair adds
  // it back through actual keyboard input and the App's installed extension.
  const savedFooter = /\/\/ @jpeditor [^\n]+\n?/.exec(await text())[0];
  await select(savedFooter);
  await page.keyboard.press("Delete");
  await waitReload();
  assert.equal(await footer(), null);
  const noFooter = await text();
  await page.evaluate(() => { window.__metadataLastScore = window.__app.painter.score; });
  await typeAt("A.B.C.", 0, "[");
  await waitReload();
  const partial = await text();
  assert.equal(await footer(), null, "half-entered bracket must not create metadata");
  assert(await page.evaluate(() => window.__metadataLastScore === window.__app.painter.score),
    "half-entered bracket must retain the last usable Score");
  assert.deepEqual((await snapshot()).timeline, original.timeline);
  await page.waitForTimeout(600); // Separate physical keystrokes in undo history.
  await typeAt("C.", 2, "]");
  await page.waitForFunction(() => window.__app.painter.score.parts.some(part => part.measures.some(measure =>
    measure.entries.some(chord => chord.notes?.some(note => note.tuplet)))));
  const complete = await text();
  const completed = await snapshot();
  const stored = await footer();
  assert.equal(stored.q, "t");
  assert.equal(stored.s["."], 16);
  assert.equal(stored.an, undefined, "ordinary visible tuplets must not acquire a second timing override");
  assert(completed.triplets.length >= 3);
  assert.notDeepEqual(completed.timeline, original.timeline, "completed bracket must change real triplet timing");
  assert.equal(await page.evaluate(() => window.__app.view.state.selection.main.head), complete.indexOf("C.]") + 3,
    "footer insertion must not move the typing caret away from the bracket");

  await page.keyboard.press("Control+z");
  await waitReload();
  assert.equal(await text(), partial, "undo closing bracket also undoes its generated footer");
  await page.keyboard.press("Control+z");
  await waitReload();
  assert.equal(await text(), noFooter);
  assert.deepEqual((await snapshot()).timeline, original.timeline);
  await page.keyboard.press("Control+y");
  await page.keyboard.press("Control+y");
  await waitReload();
  assert.equal(await text(), complete);
  assert.deepEqual((await snapshot()).timeline, completed.timeline);

  // A textual heading/comment edit cannot re-encode the music or its timing.
  const headingFooter = await footer();
  await typeAt("键盘谱", 0, "// heading draft\n");
  await waitReload();
  assert.deepEqual(await footer(), headingFooter);
  assert.deepEqual((await snapshot()).timeline, completed.timeline);

  // Real two-key arpeggio editing changes the source and compact metadata
  // together; replacing the brace with chord parentheses removes its mark.
  const z = "\u2063";
  await importFixture(source.replace("A.B.C.", `(${z}A B)...`));
  assert.equal(await page.evaluate(() => window.__app.slashOptions.voiceCount), 2);
  await select(`(${z}A B)`, 0, 1);
  await page.keyboard.type("{");
  await waitReload();
  assert.equal((await snapshot()).arpeggios.length, 0);
  await select(`{${z}A B)`, 5, 1);
  await page.keyboard.type("}");
  await waitReload();
  assert.equal((await snapshot()).arpeggios.length, 1);
  assert((await footer()).an.some(annotation => annotation.type === "cross-arpeggio"));
  await select(`{${z}A B}`, 0, 1);
  await page.keyboard.type("(");
  await waitReload();
  assert.equal((await snapshot()).arpeggios.length, 1, "first replacement key retains last complete score");
  await select(`(${z}A B}`, 5, 1);
  await page.keyboard.type(")");
  await waitReload();
  assert.equal((await snapshot()).arpeggios.length, 0);
  assert(!(await footer()).an?.some(annotation => annotation.type === "cross-arpeggio"));

  await importFixture(source, "none");
  await typeAt("A.B.C.", 0, "[");
  await typeAt("C.", 2, "]");
  await waitReload();
  assert.equal((await footer()).q, "n");
  assert.equal((await snapshot()).triplets.length, 0);
  assert((await snapshot()).diagnostics.some(message => /用途|未指定|未设置|配置/.test(message)));
  assert.deepEqual(errors, []);
  console.log("slash-metadata-sync-browser-check: passed (real TXT import, keyboard edits, metadata, partial pairs, undo/redo, timing, arpeggio cleanup, unassigned diagnostics)");
} finally {
  await browser.close();
  if (server) await server.close();
}
