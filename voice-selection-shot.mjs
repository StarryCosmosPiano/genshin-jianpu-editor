import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const mime = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
const server = createServer(async (request, response) => {
  try {
    let path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    if (path === "/") path = "/index.html";
    const data = await readFile(join(root, normalize(path)));
    response.writeHead(200, { "content-type": mime[extname(path)] ?? "application/octet-stream" });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
  window.__saveMock = { pickerCalls: 0, writes: [] };
  window.showSaveFilePicker = async () => {
    const id = ++window.__saveMock.pickerCalls;
    return {
      name: `target-${id}.txt`,
      async createWritable() {
        return {
          async write(data) {
            window.__saveMock.writes.push({ id, size: data.byteLength ?? data.size ?? 0 });
          },
          async close() {},
        };
      },
    };
  };
});

const text = `键盘谱
4/4拍：
点=八分音符
Q../A../Z../X../
`;

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  await page.evaluate((source) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", voiceCount: 1, instrumentName: "钢琴",
      title: "多声部快捷键", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, tempoBeatUnit: "quarter", fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 8 }, spaceDivision: null, noteDivision: null,
      braceMode: "grace", bracketMode: "triplet", tempoMarks: [],
    };
    app.setText(source);
  }, text);
  await page.waitForFunction(() => window.__app._sourceNotes.length === 4);
  await page.evaluate(() => {
    const app = window.__app;
    const source = app._sourceNotes[0];
    app.view.focus();
    app.view.dispatch({ selection: { anchor: source.from, head: source.to } });
  });
  await page.keyboard.press("Alt+1");
  await page.waitForFunction(() =>
    window.__app.slashOptions.voiceCount === 2
    && window.__app.painter.score.piano
    && window.__app.getText().includes("\u2063Q"));
  let state = await page.evaluate(() => ({
    parts: window.__app.painter.score.parts.length,
    selected: window.__app._selectedNotes.length,
    vc: window.__app.slashOptions.voiceCount,
    voiceColors: document.querySelectorAll(".cm-slash-voice").length,
    palette: window.__app.slashVoiceColors.slice(0, 5),
  }));
  if (state.parts !== 2 || state.selected !== 1 || state.vc !== 2 || state.voiceColors !== 1
    || state.palette.join(",") !== "#dc2626,#eab308,#16a34a,#9333ea,") {
    throw new Error(`Alt+1 did not create and retain a paired selection: ${JSON.stringify(state)}`);
  }

  await page.keyboard.press("Alt+1");
  await page.waitForFunction(() =>
    window.__app.slashOptions.voiceCount === 2
    && !window.__app.getText().includes("\u2063Q")
    && document.querySelectorAll(".cm-slash-voice").length === 0);
  await page.evaluate(() => {
    const app = window.__app;
    app.setSlashVoiceSettings(3, app.slashVoiceColors, false, false);
  });
  await page.waitForFunction(() =>
    window.__app.slashOptions.voiceCount === 3
    && window.__app.painter.score.ensemble
    && !window.__app.getText().includes("\u2063")
    && window.__app._sourceNotes.every((source) => source.voiceIndex === 3)
    && document.querySelectorAll(".cm-slash-voice").length === 0);
  state = await page.evaluate(() => ({
    parts: window.__app.painter.score.parts.length,
    vc: window.__app.slashOptions.voiceCount,
    defaultMovedToV3: window.__app._sourceNotes.every((source) => source.voiceIndex === 3),
    hiddenWebTools: ["btn-mixed", "btn-recognize", "sel-recog-view", "btn-phrase"]
      .every((id) => document.getElementById(id)?.hidden),
  }));
  if (state.parts !== 3 || state.vc !== 3 || !state.defaultMovedToV3 || !state.hiddenWebTools) {
    throw new Error(`voice-count migration or web toolbar hiding failed: ${JSON.stringify(state)}`);
  }
  await page.evaluate(() => {
    const app = window.__app;
    const source = app._sourceNotes[0];
    app.view.focus();
    app.view.dispatch({ selection: { anchor: source.from, head: source.to } });
  });
  await page.keyboard.press("Alt+2");
  await page.waitForFunction(() =>
    window.__app._sourceNotes[0]?.voiceIndex === 2
    && document.querySelectorAll(".cm-slash-voice-2").length === 1
    && document.querySelectorAll(".cm-slash-voice-3").length === 0);
  await page.evaluate(() => {
    const app = window.__app;
    app.setSlashVoiceSettings(6, app.slashVoiceColors, false, false);
  });
  await page.waitForFunction(() =>
    window.__app.slashOptions.voiceCount === 6
    && window.__app._sourceNotes.some((source) => source.voiceIndex === 6));
  await page.evaluate(() => {
    const app = window.__app;
    const source = app._sourceNotes.find((item) => item.voiceIndex === 6);
    app.view.focus();
    app.view.dispatch({ selection: { anchor: source.from, head: source.to } });
  });
  await page.keyboard.press("Alt+5");
  await page.waitForFunction(() =>
    window.__app._sourceNotes.some((source) => source.voiceIndex === 5)
    && document.querySelectorAll(".cm-slash-voice-5").length === 0);
  await page.evaluate(() => {
    const app = window.__app;
    const colors = [...app.slashVoiceColors];
    colors[4] = "#f97316";
    app.setSlashVoiceSettings(6, colors, false, false);
  });
  await page.waitForFunction(() =>
    document.querySelectorAll(".cm-slash-voice-5").length === 1);
  await page.evaluate(() => {
    const app = window.__app;
    app.setSlashVoiceSettings(3, app.slashVoiceColors, false, false);
  });
  await page.waitForFunction(() =>
    window.__app.slashOptions.voiceCount === 3
    && window.__app._sourceNotes.some((source) => source.voiceIndex === 2)
    && window.__app._sourceNotes.some((source) => source.voiceIndex === 3)
    && document.querySelectorAll(".cm-slash-voice-5").length === 0);
  const saveState = await page.evaluate(async () => {
    const app = window.__app;
    await app.saveFile();
    await app.saveFile();
    await app.saveFileAs();
    await app.saveFile();
    return window.__saveMock;
  });
  if (saveState.pickerCalls !== 2
    || saveState.writes.map((item) => item.id).join(",") !== "1,1,2,1") {
    throw new Error(`Save As replaced the normal Save target: ${JSON.stringify(saveState)}`);
  }
  const conversion = await page.evaluate(async () => {
    const app = window.__app;
    await app.changeDocumentFormat("number");
    const number = {
      format: app.documentFormat,
      parts: app.painter.score.parts.length,
      vc: app.slashOptions?.voiceCount,
      markers: (app.getText().match(/\u2063/g) ?? []).length,
    };
    await app.changeDocumentFormat("jpw");
    return {
      number,
      jpw: app.documentFormat,
      voiceSections: (app.getText().match(/^\.Voice\./gm) ?? []).length,
    };
  });
  if (conversion.number.format !== "number" || conversion.number.parts !== 3
    || conversion.number.vc !== 3 || conversion.number.markers !== 2
    || conversion.jpw !== "jpw" || conversion.voiceSections !== 3) {
    throw new Error(`current recognition format conversion failed: ${JSON.stringify(conversion)}`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  if (process.argv[2]) await page.screenshot({ path: process.argv[2], fullPage: false });
  console.log(JSON.stringify({
    ...state,
    altToggle: true,
    voiceColors: true,
    saveTargetStable: true,
    formatConversion: true,
  }, null, 2));
} finally {
  await browser.close();
  server.close();
}
