import "./styles.css";
import { MetaData } from "./smufl/smufl";
import { ensureFontsReady } from "./common/measure";
import { asset } from "./common/asset";
import { App } from "./editor/app";
import { MixedPainter } from "./mixed/painter";
import { loadBuiltInSample } from "./bootstrap/sample";
import { wireWorkspace } from "./bootstrap/workspace";
import { initializeTheme } from "./ui/theme";
import { wireStaffPreview } from "./staff-preview/controller";
import { initializeWorkspaceMode, isTouchWorkspace } from "./bootstrap/device-mode";
import { wireMobileWorkspace } from "./bootstrap/mobile-workspace";
import { initializeMobileFiles } from "./bootstrap/mobile-files";

// Use the same Bravura font for measurement and drawing.
async function registerBravura(): Promise<void> {
  if (typeof FontFace === "undefined") return;
  const face = new FontFace("Bravura", `url(${asset("redist/Bravura.woff2")}) format("woff2")`);
  await face.load();
  (document.fonts as FontFaceSet).add(face);
}

async function boot(): Promise<void> {
  initializeTheme();
  initializeWorkspaceMode();
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
    __staffPreviewTest: () => Promise<unknown>;
  };
  win.__app = app;
  win.__mixedPainter = new MixedPainter();
  win.__omr = import("./omr");
  win.__abc2musicxml = import("./abc/abc2xml");
  win.__staffPreviewTest = () => import("./staff-preview/renderer-test-support").then(module => module.staffPreviewTestApi);

  await wireWorkspace(app, scorePane);
  wireStaffPreview(app);
  wireMobileWorkspace(app);
  initializeMobileFiles(app);
  document.addEventListener("editor:update-ready", () => {
    app.reportFileStatus("新版本已就绪。当前编辑会保留，请保存后手动刷新。");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && (isTouchWorkspace() || navigator.maxTouchPoints > 0)) app.stopPlayback();
  });
  window.addEventListener("pagehide", () => app.stopPlayback());
  // Desktop keeps its catalog ready for settings; touch devices fetch it only
  // when the user opens audio settings or plays with an SF2 selected.
  if (!isTouchWorkspace()) void app.ensureSoundfonts().catch(error => console.warn("读取 SF2 音源失败", error));
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
