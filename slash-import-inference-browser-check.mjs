// Build first, or set APP_TEST_URL to an existing development server.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

let server;
let url = process.env.APP_TEST_URL;
if (!url) {
  const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm" };
  server = createServer(async (request, response) => {
    try {
      const path = normalize(decodeURIComponent((request.url ?? "/").split("?")[0]));
      const data = await readFile(join(process.cwd(), "dist", path === "/" || path === "\\" ? "index.html" : path));
      response.writeHead(200, { "content-type": mime[extname(path)] ?? "text/html" }); response.end(data);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
}
const browser = await chromium.launch({ channel: "msedge", headless: true });
const results = [];
const check = (label, condition) => { assert.ok(condition, label); results.push(label); };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.addInitScript(() => localStorage.setItem("jpeditor:workspace-mode:v1", "desktop"));
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__app?.painter.score);
  const dialog = page.locator(".slash-import-box");
  const field = name => dialog.locator(`[data-slash-import="${name}"]`);
  const footer = dialog.locator(".modal-footer");
  const open = async (text, name = "导入识别回归.txt") => {
    await page.evaluate(({ text, name }) => { void window.__app.importBytes(new TextEncoder().encode(text), name); }, { text, name });
    await dialog.waitFor();
  };
  const cancel = async () => { await footer.getByRole("button", { name: "取消", exact: true }).click(); await dialog.waitFor({ state: "detached" }); };
  const confirm = async () => {
    const dirty = await page.evaluate(() => window.__app.hasUnsavedChanges());
    await footer.getByRole("button", { name: /^导入为/ }).click();
    if (dirty) await page.getByRole("button", { name: "不保存", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => window.__app.documentFormat === "keyboard");
  };
  const fragment = "    /    /H   /Q   /\n(VW)   /E H /    /    /\n(BW)   /E H /    /T   /\n(NE) W /  E /    /T   /\n\nH   /    /H   /Q  [DHQ(VW)]/\n";
  const raw = process.env.SLASH_IMPORT_FIXTURE
    ? await readFile(process.env.SLASH_IMPORT_FIXTURE, "utf8")
    : fragment.repeat(8);
  const before = await page.evaluate(() => window.__app.getText());
  await open(raw, "城南花开.txt");
  check("space timing defaults to sixteenth notes", await dialog.locator('[name="spaceDivision"]').inputValue() === "16");
  check("intrinsic note timing defaults to sixteenth notes", await dialog.locator('[name="noteDivision"]').inputValue() === "16");
  check("four beat rows prefer common 4/4", await field("beats").inputValue() === "4" && await field("beat-type").inputValue() === "4");
  check("absent duration symbols remain empty", await dialog.locator('.slash-symbol-row input').evaluateAll(inputs => inputs.every(input => input.value === "")));
  for (const name of ["brace", "bracket", "bar", "angle"]) check(`${name} has no implicit special meaning`, await field(name).inputValue() === "none");
  check("ordinary parentheses default to chords", await field("paren").inputValue() === "chord");
  check("observed brackets prompt review", await field("bracket-warning").isVisible()
    && (await field("bracket-warning").textContent()).includes("方括号 []")
    && (await field("bracket-warning").textContent()).includes("圆括号 ()"));
  await dialog.locator('[data-preview-view="text"]').click();
  const source = dialog.locator(".slash-score-preview-text");
  const gutter = dialog.locator(".slash-score-preview-line-numbers");
  const normalized = raw.replace(/\r\n?/g, "\n");
  check("text preview retains every original character", await source.inputValue() === normalized);
  const lineCount = normalized.split("\n").length;
  check("line numbers include empty and final rows", await gutter.getAttribute("data-line-count") === String(lineCount)
    && await gutter.locator("pre").textContent() === Array.from({ length: lineCount }, (_, index) => index + 1).join("\n"));
  await source.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  await mkdir("artifacts/slash-import-inference-20261020", { recursive: true });
  await page.screenshot({ path: "artifacts/slash-import-inference-20261020/import-text.png" });
  await source.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event("scroll")); });
  const scrolling = await page.evaluate(() => {
    const source = document.querySelector(".slash-score-preview-text");
    const gutter = document.querySelector(".slash-score-preview-line-numbers");
    return { scroll: source.scrollTop, transform: gutter.querySelector("pre").style.transform,
      left: gutter.getBoundingClientRect().left };
  });
  check("line gutter follows vertical scrolling", scrolling.scroll > 0 && scrolling.transform === `translateY(${-scrolling.scroll}px)`);
  await source.evaluate(element => { element.scrollLeft = 200; element.dispatchEvent(new Event("scroll")); });
  check("horizontal scrolling keeps gutter in place", await gutter.evaluate(element => element.getBoundingClientRect().left) === scrolling.left);
  await dialog.locator('[data-preview-view="score"]').click();
  await dialog.locator(".slash-score-preview svg").waitFor();
  check("bare square brackets no longer create a triplet error", !(await dialog.locator(".slash-score-preview-status").textContent()).includes("三连音"));
  check("draft leaves current document untouched", await page.evaluate(() => window.__app.getText()) === before);
  await mkdir("artifacts/slash-import-inference-20261020", { recursive: true });
  await page.screenshot({ path: "artifacts/slash-import-inference-20261020/import.png" });
  await field("beats").fill("");
  check("empty meter cannot silently import with fallback defaults", await footer.getByRole("button", { name: /^导入为/ }).isDisabled()
    && (await field("error").textContent()).includes("请手动填写有效拍号"));
  await field("beats").fill("4");
  check("manual meter enables import again", await footer.getByRole("button", { name: /^导入为/ }).isEnabled());
  await confirm();
  check("confirmed import preserves the complete source body", await page.evaluate(raw => window.__app.getText().startsWith(raw.trimEnd()), normalized));
  check("confirmed import retains empty symbols and unassigned brackets", await page.evaluate(() =>
    Object.keys(window.__app.slashOptions.symbolDurations).length === 0 && window.__app.slashOptions.bracketMode === "none"));

  await open("A/B/C/D/E/F/G/\n");
  check("uncertain meter remains blank for manual entry", await field("beats").inputValue() === ""
    && (await field("meter-hint").textContent()).includes("手动填写拍号")
    && await footer.getByRole("button", { name: /^导入为/ }).isDisabled());
  await field("beats").fill("7");
  check("explicitly entered uncommon meter is accepted", await footer.getByRole("button", { name: /^导入为/ }).isEnabled());
  await cancel();

  await open("A /B /C /D /\n");
  check("ambiguous intrinsic and space durations still require manual meter", await field("beats").inputValue() === ""
    && await footer.getByRole("button", { name: /^导入为/ }).isDisabled());
  await cancel();

  await open("A...B=/C...D=/E...F=/G...H=/\n");
  check("ambiguous symbol timing cannot be confirmed automatically", await field("beats").inputValue() === "");
  await field("beats").fill("4");
  check("entering a meter cannot discard unresolved duration symbols", await footer.getByRole("button", { name: /^导入为/ }).isDisabled()
    && (await field("error").textContent()).includes("请为时值符号"));
  await field("multiple-symbols").check();
  for (const symbol of [".", "="]) {
    // The symbol is a DOM value rather than a reflected HTML attribute.
    const index = await dialog.locator('.slash-symbol-row input').evaluateAll((inputs, symbol) =>
      inputs.findIndex(input => input.value === symbol), symbol);
    assert(index >= 0, `missing detected symbol ${symbol}`);
    await dialog.locator('.slash-symbol-row select').nth(index).selectOption("16");
  }
  check("explicit symbol values enable the reviewed interpretation", await footer.getByRole("button", { name: /^导入为/ }).isEnabled());
  await confirm();
  check("reviewed symbol timings preserve both attacks per beat", await page.evaluate(() =>
    window.__app.painter.score.parts[0].measures[0].entries.filter(chord => !chord.rest && !chord.transparentContinuation).length === 8));

  // No extra whitespace here: unknown leading spaces would add a second,
  // genuinely different timing interpretation to this symbol-only control.
  await open("A../B=/C../D=/\n".repeat(3));
  const symbolValues = await dialog.locator(".slash-symbol-row").evaluateAll(rows => Object.fromEntries(rows.map(row =>
    [row.querySelector("input").value, row.querySelector("select").value])));
  const multipleSymbolsEnabled = await field("multiple-symbols").isChecked();
  check(`observed multiple symbols start enabled with inferred durations (${JSON.stringify(symbolValues)}, enabled=${multipleSymbolsEnabled})`, multipleSymbolsEnabled
    && symbolValues["."] === "8" && symbolValues["="] === "4");
  await cancel();

  await open("    /    /H   /Q   /\n[CDE]   /H   /Q   /W   /\n");
  await field("bracket").selectOption("chord");
  await page.waitForFunction(() => !document.querySelector('.slash-score-preview[aria-busy="true"]'));
  check("manually assigned bracket yields a valid score", !await dialog.locator(".slash-score-preview-status.has-error").isVisible());
  await confirm();
  const savedText = await page.evaluate(() => window.__app.getText());
  check("manual bracket meaning is stored with the document", await page.evaluate(() => window.__app.slashOptions.bracketMode === "chord")
    && savedText.includes("@jpeditor"));
  await open(savedText);
  check("reopening retains manual bracket meaning", await field("bracket").inputValue() === "chord");
  await cancel();

  const stored = '键盘谱\n[ABC]~/~/~/\n// @jpeditor {"k":"k","m":[3,4],"s":{"~":8},"sp":null,"nd":16,"b":"a","q":"t","x":"g","p":"c"}\n';
  await open(stored);
  check("saved meter remains authoritative", await field("beats").inputValue() === "3" && await field("beat-type").inputValue() === "4");
  check("saved symbol mapping remains authoritative", await dialog.locator('.slash-symbol-row input').first().inputValue() === "~"
    && await dialog.locator('.slash-symbol-row select').first().inputValue() === "8");
  check("saved bracket modes remain authoritative", await field("brace").inputValue() === "arpeggio"
    && await field("bracket").inputValue() === "triplet" && await field("angle").inputValue() === "grace");
  await cancel();

  check("browser has no unhandled errors", errors.length === 0);
  console.log(`PASS ${results.length} import inference checks:\n${results.join("\n")}`);
} finally { await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); }
