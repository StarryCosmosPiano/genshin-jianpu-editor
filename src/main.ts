import "./styles.css";
import { MetaData } from "./smufl/smufl";
import { ensureFontsReady } from "./common/measure";
import { asset } from "./common/asset";
import { App } from "./editor/app";
import { MixedPainter } from "./mixed/painter";
import { loadBuiltInSample } from "./bootstrap/sample";
import { wireWorkspace } from "./bootstrap/workspace";
import { initializeTheme } from "./ui/theme";

// Use the same Bravura font for measurement and drawing.
async function registerBravura(): Promise<void> {
  if (typeof FontFace === "undefined") return;
  const face = new FontFace("Bravura", `url(${asset("redist/Bravura.woff2")}) format("woff2")`);
  await face.load();
  (document.fonts as FontFaceSet).add(face);
}

async function boot(): Promise<void> {
  initializeTheme();
  await registerBravura();
  await ensureFontsReady([
    { family: "Bravura", size: 40 },
    { family: "PingFang SC", size: 28 },
  ]);
  const meta = await MetaData.load();
  const codePane = document.getElementById("code-pane")!;
  const scorePane = document.getElementById("score-pane")!;
  const app = new App(meta, scorePane);
  app.loadSettings();
  try {
    await app.refreshSoundfonts();
  } catch (error) {
    console.warn("启动时读取 SF2 音源失败", error);
  }
  const sample = await loadBuiltInSample();
  app.documentFormat = "keyboard";
  app.slashOptions = sample.options;
  app.codePaneCollapsed = !app.showTextOnStartup;
  app.mountEditor(codePane, sample.text);

  // Keep browser-facing diagnostics for the existing rendering and import checks.
  const win = window as unknown as {
    __app: App;
    __mixedPainter: MixedPainter;
    __omr: unknown;
    __abc2musicxml: unknown;
  };
  win.__app = app;
  win.__mixedPainter = new MixedPainter();
  win.__omr = import("./omr");
  win.__abc2musicxml = import("./abc/abc2xml");

  await wireWorkspace(app, scorePane);
  if (app.restoreLastFileOnStartup) await app.tryRestoreLastFile();
}

window.addEventListener("DOMContentLoaded", () => {
  boot().catch((error) => {
    console.error(error);
    const message = document.createElement("pre");
    message.style.cssText = "color:red;white-space:pre-wrap";
    message.textContent = String(error?.stack ?? error);
    document.body.append(message);
  });
});
