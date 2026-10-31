import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const server = process.env.APP_TEST_URL ? null : await createServer({
  server: { host: "127.0.0.1", port: 0, hmr: false }, clearScreen: false,
});
if (server) await server.listen();
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const output = resolve("artifacts/workspace-followup-20261022");
await mkdir(output, { recursive: true });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.addInitScript(() => localStorage.setItem("jpeditor:workspace-mode:v1", "desktop"));
try {
  await page.goto(process.env.APP_TEST_URL ?? server.resolvedUrls.local[0], { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.__app && !!document.querySelector("#score-pane svg"));
  for (const width of [1920, 1440, 1280, 1024, 760]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(80);
    const geometry = await page.evaluate(() => {
      const box = id => {
        const node = document.getElementById(id), rect = node.getBoundingClientRect();
        return { id, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width,
          header: !!node.closest("#app-header"), visible: !!rect.height };
      };
      const toolbar = document.getElementById("toolbar");
      return { menus: ["btn-midi-input", "btn-score-settings", "btn-layout-style", "staff-view-toolbar"].map(box),
        toolbar: box("toolbar"), controls: ["btn-chord-mode", "btn-undo", "btn-redo", "btn-play"].map(box),
        bodyOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        toolOverflow: toolbar.scrollWidth > toolbar.clientWidth + 1 };
    });
    assert.equal(geometry.bodyOverflow, false, `${width}: page overflow`);
    assert.equal(geometry.toolOverflow, false, `${width}: crowded toolbar`);
    for (const item of geometry.menus) {
      assert.ok(item.header && item.visible && item.bottom <= geometry.toolbar.y + 1, `${width}: ${item.id} belongs above editing tools`);
      assert.ok(item.x >= 0 && item.right <= width + 1, `${width}: ${item.id} clipped`);
    }
    for (let i = 1; i < geometry.controls.length; i++)
      assert.ok(geometry.controls[i - 1].right <= geometry.controls[i].x + 1, `${width}: edit controls overlap`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#btn-workspace-mode").click();
  const sheet = page.getByRole("dialog", { name: "工作区", exact: true });
  await sheet.waitFor();
  const bounds = await sheet.boundingBox();
  assert.ok(Math.abs(bounds.y + bounds.height / 2 - 500) < 3, "desktop workspace dialog is vertically centered");
  await page.screenshot({ path: resolve(output, "desktop-workspace-menu.png") });
  await page.keyboard.press("Escape");
  await page.locator("#btn-score-settings").click();
  await page.waitForFunction(() => document.getElementById("btn-score-settings").getAttribute("aria-expanded") === "true");
  await page.locator("#inspector-pane .inspector-close").click();
  await page.locator("#btn-layout-style").click();
  await page.waitForFunction(() => document.getElementById("btn-layout-style").getAttribute("aria-expanded") === "true");
  await page.locator("#inspector-pane .inspector-close").click();
  await page.screenshot({ path: resolve(output, "desktop-toolbar.png") });
  assert.deepEqual(errors, []);
  console.log("workspace-menu-layout-check: ok (five desktop widths, relocated controls, centered workspace dialog, inspectors)");
} finally {
  await browser.close();
  await server?.close();
}
