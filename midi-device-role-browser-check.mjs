// Exercise the real MIDI selector with Windows' Send-first loopback enumeration.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const server = process.env.APP_TEST_URL ? null : createServer(async (request, response) => {
  try {
    const name = normalize(decodeURIComponent((request.url ?? "/").split("?")[0]));
    const data = await readFile(join(process.cwd(), "dist", name === "/" || name === "\\" ? "index.html" : name));
    response.writeHead(200, { "content-type": mime[extname(name)] ?? "text/html" }); response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
if (server) await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = process.env.APP_TEST_URL ?? `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const failures = [];
page.on("pageerror", error => failures.push(error.message));
await page.addInitScript(() => {
  localStorage.setItem("jpeditor:workspace-mode:v1", "desktop");
  const access = new EventTarget();
  const ports = new Map([
    ["send", "YuanQin MIDI Send"], ["usb", "USB MIDI Out"],
    ["return", "Studio Return"], ["out", "YuanQin MIDI Out"],
  ].map(([id, name]) => {
    const port = new EventTarget();
    Object.assign(port, { id, name, manufacturer: "Regression", type: "input", state: "connected", connection: "closed", opens: 0,
      async open() { this.opens++; this.connection = "open"; return this; },
      async close() { this.connection = "closed"; return this; },
    });
    return [id, port];
  }));
  access.inputs = new Map(ports);
  window.__roleMidi = { access, ports,
    devices(ids) { access.inputs = new Map(ids.map(id => [id, ports.get(id)])); access.dispatchEvent(new Event("statechange")); },
    note(id, pitch) { for (const data of [[0x90, pitch, 96], [0x80, pitch, 0]]) {
      const event = new Event("midimessage"); Object.defineProperty(event, "data", { value: new Uint8Array(data) }); ports.get(id).dispatchEvent(event);
    } },
  };
  Object.defineProperty(navigator, "requestMIDIAccess", { configurable: true, value: async () => access });
});
const dialog = page.getByRole("dialog", { name: "MIDI 输入设备", exact: true });
const select = dialog.locator('[name="device"]');
async function open() { await page.locator("#btn-midi-input").click(); await dialog.waitFor(); }
async function apply(id) {
  if (id !== undefined) await select.selectOption(id);
  const selected = await select.inputValue();
  await dialog.getByRole("button", { name: "应用", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(id => {
    const state = window.__app.getMidiInputState();
    return state?.status === (id ? "connected" : "ready") && state.selectedDeviceId === (id || null);
  }, selected);
}
async function cancel() { await dialog.getByRole("button", { name: "取消", exact: true }).click(); }
async function devices(ids) {
  await page.evaluate(ids => window.__roleMidi.devices(ids), ids);
  await page.waitForFunction(count => window.__app.getMidiInputState()?.devices.length === count, ids.length);
}
try {
  await page.goto(origin);
  await page.waitForFunction(() => window.__app?.painter.score);
  await page.evaluate(() => {
    const app = window.__app;
    app.documentFormat = "jpw"; app.slashOptions = null;
    app.setText(".Title\nTitle = MIDI 端口识别\nKeyAndMeters = {1=C,4/4}\n.Voice\n0 0 0 0 |]\n");
    app.setCodePaneCollapsed(true);
    app.setInputMode(false);
  });
  await page.waitForFunction(() => window.__app.debounceTimer === undefined);
  await open();
  assert.equal(await select.inputValue(), "out", "Send-first enumeration recommends the receiving endpoint");
  const options = await select.locator("option").evaluateAll(nodes => nodes.map(node => ({ value: node.value, label: node.textContent })));
  assert.equal(options[0].value, "out");
  assert.match(options.find(option => option.value === "out").label, /原琴助手演奏输入/);
  assert.match(options.find(option => option.value === "send").label, /内部发送端/);
  assert.equal(options.find(option => option.value === "usb").label, "USB MIDI Out");
  assert.equal(options.find(option => option.value === "return").label, "Studio Return");
  assert.match(await dialog.textContent(), /Out 接收演奏/);
  assert.equal(await page.evaluate(() => [...window.__roleMidi.ports.values()].some(port => port.opens)), false,
    "recommendation does not connect before Apply");
  await mkdir("artifacts/virtual-midi-20261030", { recursive: true });
  await page.screenshot({ path: "artifacts/virtual-midi-20261030/device-roles.png" });
  await apply();
  await page.waitForFunction(() => window.__app.getMidiInputState()?.status === "connected");
  assert.equal(await page.evaluate(() => window.__app.getMidiInputState().selectedDeviceId), "out");
  assert.match(await page.locator("#btn-midi-input").getAttribute("aria-label"), /原琴助手演奏输入/);
  const before = await page.evaluate(() => window.__app.getText());
  await page.evaluate(() => { window.__app.scorePane.focus(); window.__roleMidi.note("out", 60); });
  await page.waitForFunction(text => window.__app.getText() !== text, before);
  assert.equal(await page.evaluate(() => window.__app.getMidiInputState().receivedNoteOns), 1,
    "recommended endpoint writes real input events through the normal session");
  await open(); await apply("usb");
  await open(); assert.equal(await select.inputValue(), "usb", "existing hardware selection wins over recommendation"); await cancel();
  assert.equal(await page.evaluate(() => window.__app.getMidiInputState().selectedDeviceId), "usb");
  await open(); await apply("send");
  assert.match(await page.locator("#status").textContent(), /内部发送端.*改选 YuanQin MIDI Out/);
  await open(); assert.equal(await select.inputValue(), "send", "an explicit internal endpoint remains user-controlled"); await cancel();
  await open(); await apply("");
  await devices(["send"]);
  await open();
  assert.equal(await select.inputValue(), "", "only Send never becomes a default performance input");
  assert.match(await dialog.textContent(), /仅检测到原琴助手内部发送端/);
  await cancel();
  await devices(["send", "out"]);
  await open();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await select.inputValue(), "out", "refresh after endpoint appearance recommends Out");
  assert.ok(await select.isVisible());
  await page.screenshot({ path: "artifacts/virtual-midi-20261030/device-roles-narrow.png" });
  await cancel();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await devices(["usb", "return"]);
  await open();
  assert.ok(["usb", "return"].includes(await select.inputValue()), "ordinary ports remain selectable defaults");
  assert.doesNotMatch(await dialog.locator("#app-dialog-message").textContent(), /原琴助手|内部发送端/);
  await cancel();
  assert.deepEqual(failures, [], "no browser runtime errors");
  console.log("MIDI device roles browser: recommendation, labels, real input, existing selection, internal-only, hotplug and narrow viewport passed");
} finally { await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); }
