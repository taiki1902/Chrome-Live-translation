import { chromium } from "playwright";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const endpoint = process.env.CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const outputDirectory = process.env.E2E_OUTPUT_DIR ?? "/tmp/hlt-cdp-e2e";
const log = (...values) => console.log(new Date().toISOString(), ...values);

const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0];
if (!context) throw new Error("Default Chromium context was not available");

context.on("weberror", (event) => {
  const error = event.error();
  log("WEBERROR", error?.stack || error?.message || String(error));
});

let worker = context
  .serviceWorkers()
  .find((entry) => entry.url().startsWith("chrome-extension://"));
if (!worker) {
  worker = await context.waitForEvent("serviceworker", {
    predicate: (entry) => entry.url().startsWith("chrome-extension://"),
    timeout: 30_000,
  });
}
worker.on("console", (message) =>
  log("SW_CONSOLE", message.type(), message.text()),
);

const extensionId = new URL(worker.url()).host;
const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
const commands = await worker.evaluate(() => chrome.commands.getAll());
const command = commands.find((entry) => entry.name === "toggle-translation");
log(
  "EXTENSION",
  extensionId,
  JSON.stringify({ name: manifest.name, version: manifest.version }),
);
log("COMMAND", JSON.stringify(command));
if (command?.shortcut !== "Alt+Shift+L") {
  throw new Error("Extension shortcut was not registered");
}

let page = context
  .pages()
  .find((entry) => entry.url().includes("127.0.0.1:8123/test.html"));
if (!page) {
  page = await context.newPage();
  await page.goto("http://127.0.0.1:8123/test.html");
}
page.on("console", (message) =>
  log("PAGE_CONSOLE", message.type(), message.text()),
);
page.on("pageerror", (error) =>
  log("PAGE_ERROR", error.stack || error.message),
);
await page.bringToFront();
await page.locator("#audio").evaluate((audio) => audio.play());
const audioState = await page.locator("#audio").evaluate((audio) => ({
  paused: audio.paused,
  readyState: audio.readyState,
  duration: audio.duration,
}));
log("AUDIO_STATE", JSON.stringify(audioState));
if (audioState.paused || audioState.readyState < 2) {
  throw new Error("Fixture audio did not play");
}

const settings = {
  sourceLanguage: "en",
  targetLanguage: "ja",
  modelSize: "tiny",
  performanceMode: "wasm",
  segmentSeconds: 4,
  overlapMilliseconds: 700,
  showOriginal: true,
  translationEnabled: true,
  fontSize: 27,
  backgroundOpacity: 0.76,
  position: "bottom",
  maxCaptionRows: 3,
  captionLifetimeSeconds: 30,
  silenceGate: false,
  silenceThreshold: 0.003,
  customVocabulary: "",
};
await worker.evaluate(
  async (value) => chrome.storage.local.set({ settings: value }),
  settings,
);

const readState = () =>
  worker.evaluate(async () => {
    const result = await chrome.storage.session.get("runtimeState");
    return result.runtimeState || null;
  });

const windows = execFileSync(
  "xdotool",
  ["search", "--onlyvisible", "--name", "Subtitle-less audio test"],
  { encoding: "utf8" },
)
  .trim()
  .split(/\s+/)
  .filter(Boolean);
if (!windows.length) throw new Error("Chromium X11 window was not found");
const windowId = windows.at(-1);
log(
  "X11_WINDOW",
  windowId,
  execFileSync("xdotool", ["getwindowname", windowId], {
    encoding: "utf8",
  }).trim(),
);

const sendShortcut = () => {
  execFileSync("xdotool", ["windowfocus", "--sync", windowId]);
  execFileSync("xdotool", [
    "key",
    "--window",
    windowId,
    "--clearmodifiers",
    "alt+shift+l",
  ]);
};

sendShortcut();
log("START_SHORTCUT_SENT");

let state = null;
let lastState = "";
const deadline = Date.now() + 18 * 60_000;
while (Date.now() < deadline) {
  state = await readState();
  const serialized = JSON.stringify(state);
  if (serialized !== lastState) {
    log("STATE", serialized);
    lastState = serialized;
  }
  if (state?.status === "error") {
    throw new Error(`Runtime error: ${state.lastError}`);
  }
  if (state?.captionCount > 0) break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
if (!state?.captionCount) {
  throw new Error(`No caption produced: ${JSON.stringify(state)}`);
}

const overlayCount = await page.locator("#helium-live-translator-root").count();
log("OVERLAY_COUNT", overlayCount);
if (overlayCount !== 1) throw new Error("Subtitle overlay was not injected");

await page.screenshot({
  path: `${outputDirectory}/e2e-result.png`,
  fullPage: true,
});
log("SCREENSHOT_SIZE", fs.statSync(`${outputDirectory}/e2e-result.png`).size);
log("E2E_PASS", JSON.stringify(state));

sendShortcut();
const stopDeadline = Date.now() + 15_000;
let stopped = await readState();
while (Date.now() < stopDeadline && stopped?.status !== "idle") {
  await new Promise((resolve) => setTimeout(resolve, 500));
  stopped = await readState();
}
log("STOP_STATE", JSON.stringify(stopped));
if (stopped?.status !== "idle") {
  throw new Error("Extension did not stop cleanly");
}

await browser.close();
