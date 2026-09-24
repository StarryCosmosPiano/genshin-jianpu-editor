import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";

const source = `
import { JinpuPainter } from "./src/layout/painter";
import { Font } from "./src/layout/font";
import { Group, GraphicLine, NoteEntry, TextFrame } from "./src/layout/layout";

const assert = (condition, message) => { if (!condition) throw new Error(message); };
function model(text, color = 0xff000000, extra = false) {
  const root = new Group();
  // Keep this focused on renderer reconciliation; the layout is supplied as
  // if resize() had just produced a fresh PageItem tree.
  root.update = () => {};
  const entry = new NoteEntry();
  const note = { pitch: Number(text), rest: false };
  const chord = { notes: [note] };
  entry.chord = chord;
  const label = new TextFrame();
  label.font = new Font("Arial", 16);
  label.text = text;
  label.color = color;
  entry.numbers.push(label);
  entry.group.add(label);
  root.add(entry.group);
  const line = new GraphicLine();
  line.p1.x = 20;
  line.strokeColor = 0xff333333;
  root.add(line);
  if (extra) {
    const second = new GraphicLine();
    second.p1.x = 30;
    second.y = 10;
    root.add(second);
  }
  return { root, entry, label, chord, note, line };
}

window.runPainterCacheCheck = () => {
  const painter = new JinpuPainter(16);
  let pages = [];
  painter.layout.fromScore = () => { painter.layout.pages = pages.map((page) => page.root); };
  const first = model("1");
  pages = [first];
  painter.resize(400, 600, null);
  const svg = painter.renderCachedPage(0);
  document.body.appendChild(svg);
  const firstEntryGroup = painter.chordGroupEl(first.chord);
  const firstNumberGroup = painter.noteGroupEl(first.chord, first.note);
  const firstLineGroup = painter.nodeMap.get(first.line);
  assert(firstEntryGroup && firstNumberGroup && firstLineGroup, "initial interaction maps");
  firstNumberGroup.classList.add("selected", "playing", "input-focused", "soft-deleted", "score-voice-colored");
  firstNumberGroup.style.setProperty("--score-voice-color", "#123456");
  firstNumberGroup.querySelector("text").setAttribute("fill", "#123456");

  const same = model("1");
  pages = [same];
  painter.resize(400, 600, null);
  assert(painter.renderCachedPage(0) === svg && svg.isConnected, "same SVG stays mounted");
  assert(painter.chordGroupEl(same.chord) === firstEntryGroup, "new chord binds reused entry");
  assert(painter.noteGroupEl(same.chord, same.note) === firstNumberGroup, "new note binds reused number");
  assert(painter.nodeMap.get(same.line) === firstLineGroup, "unchanged sibling reused");
  assert(painter.pageItemForTarget(firstNumberGroup.querySelector("text")) === same.label,
    "reused DOM targets new PageItem");
  assert(!firstNumberGroup.classList.contains("selected")
    && !firstNumberGroup.classList.contains("playing")
    && !firstNumberGroup.classList.contains("input-focused")
    && !firstNumberGroup.classList.contains("soft-deleted")
    && !firstNumberGroup.classList.contains("score-voice-colored")
    && !firstNumberGroup.style.getPropertyValue("--score-voice-color"),
    "runtime state cleared");
  assert(firstNumberGroup.querySelector("text").getAttribute("fill") !== "#123456",
    "voice-color paint restored");
  assert(!painter.chordGroupEl(first.chord), "old chord lookup removed");

  const changedPitch = model("2");
  pages = [changedPitch];
  painter.resize(400, 600, null);
  painter.renderCachedPage(0);
  assert(painter.noteGroupEl(changedPitch.chord, changedPitch.note) === firstNumberGroup,
    "pitch edit keeps the group");
  assert(firstNumberGroup.querySelector("text").textContent === "2", "pitch glyph changed");
  assert(painter.nodeMap.get(changedPitch.line) === firstLineGroup, "sibling survives pitch edit");

  const changedStyle = model("2", 0xffff0000, true);
  pages = [changedStyle];
  painter.resize(500, 600, null);
  painter.renderCachedPage(0);
  assert(firstNumberGroup.querySelector("text").getAttribute("fill") === "rgb(255,0,0)",
    "changed score style paints anew");
  assert(svg.getAttribute("viewBox") === "0 0 500 600", "page size refreshes");
  assert(svg.querySelectorAll("line").length === 2, "inserted structure rendered");
  assert(painter.nodeMap.get(changedStyle.line) === firstLineGroup,
    "existing child reused across insertion");

  const secondPage = model("3");
  pages = [changedStyle, secondPage];
  painter.resize(500, 600, null);
  const svg2 = painter.renderCachedPage(1);
  document.body.appendChild(svg2);
  assert(svg2 !== svg, "second page gets its own SVG");
  pages = [model("4")];
  painter.resize(500, 600, null);
  assert(painter.pageCache.length === 1, "removed page cache pruned");
  painter.renderCachedPage(0);
  const exportSvg = painter.renderPage(0);
  assert(exportSvg !== svg && exportSvg.querySelector("text").textContent === "4",
    "standalone renderPage remains independent");
  return { reusedPage: true, reboundChord: true, changedPitch: true,
    changedStyle: true, changedStructure: true, prunedPage: true };
};
`;

const built = await build({
  stdin: { contents: source, resolveDir: process.cwd(), sourcefile: "painter-cache-browser.ts" },
  bundle: true, platform: "browser", format: "iife", write: false,
  define: { "import.meta.env.BASE_URL": JSON.stringify("/") },
});
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage();
  await page.goto("about:blank");
  await page.addScriptTag({ content: built.outputFiles[0].text });
  const result = await page.evaluate(() => window.runPainterCacheCheck());
  assert(result.reusedPage && result.reboundChord && result.changedPitch
    && result.changedStyle && result.changedStructure && result.prunedPage);
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
