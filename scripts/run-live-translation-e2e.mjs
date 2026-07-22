import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const root = process.cwd();
const extensionPath = path.join(root, "dist", "extension");
const audioPath = path.join(root, "e2e", "speech.wav");
const browserPath = process.env.BROWSER_BIN;

if (!browserPath || !fs.existsSync(browserPath)) {
  throw new Error(`BROWSER_BIN is invalid: ${browserPath ?? "missing"}`);
}
if (!fs.existsSync(path.join(extensionPath, "manifest.json"))) {
  throw new Error("Built extension is missing. Run npm run build first.");
}
if (!fs.existsSync(audioPath)) {
  throw new Error("e2e/speech.wav is missing.");
}

const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Local Speech Test</title></head>
<body style="font-family:sans-serif;background:#10131a;color:white;padding:40px">
  <h1>Local Speech Test</h1>
  <p>This page has no caption track. The extension must use tab audio.</p>
  <audio id="audio" src="/speech.wav" controls loop autoplay></audio>
  <script>
    const audio = document.querySelector('#audio');
    window.__playStarted = false;
    async function start() {
      try {
        audio.volume = 1;
        await audio.play();
        window.__playStarted = true;
      } catch (error) {
        window.__playError = error.message;
      }
    }
    start();
    setInterval(start, 1500);
  </script>
</body>
</html>`;

const server = http.createServer((request, response) => {
  if (request.url === "/speech.wav") {
    response.writeHead(200, {
      "content-type": "audio/wav",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    fs.createReadStream(audioPath).pipe(response);
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const testUrl = `http://127.0.0.1:${address.port}/`;

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: false,
  userDataDir: path.join(root, ".e2e-profile"),
  ignoreDefaultArgs: ["--disable-extensions", "--mute-audio"],
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});

async function extensionWorker() {
  const target = browser
    .targets()
    .find(
      (candidate) =>
        candidate.type() === "service_worker" &&
        candidate.url().startsWith("chrome-extension://"),
    );
  return target ? target.worker() : null;
}

async function waitForWorker(timeout = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const worker = await extensionWorker();
    if (worker) return worker;
    await delay(500);
  }
  throw new Error("Extension service worker did not start.");
}

async function currentState() {
  const worker = await waitForWorker();
  return worker.evaluate(async () => {
    const result = await chrome.storage.session.get("runtimeState");
    return result.runtimeState ?? null;
  });
}

async function waitForState(predicate, timeout, label) {
  const startedAt = Date.now();
  let previous = "";
  while (Date.now() - startedAt < timeout) {
    const state = await currentState();
    const serialized = JSON.stringify(state);
    if (serialized !== previous) {
      console.log(`[state] ${serialized}`);
      previous = serialized;
    }
    if (predicate(state)) return state;
    if (state?.status === "error") {
      throw new Error(`Extension entered error state: ${state.lastError}`);
    }
    await delay(2_000);
  }
  throw new Error(`Timed out waiting for ${label}. Last state: ${previous}`);
}

async function pressShortcut() {
  const windows = execSync(
    "xdotool search --onlyvisible --name '.*' getwindowname %@ 2>/dev/null || true",
    { encoding: "utf8" },
  );
  console.log(`[windows]\n${windows}`);
  execSync(
    "wid=$(xdotool search --onlyvisible --name 'Local Speech Test' | head -n1); test -n \"$wid\"; xdotool windowactivate --sync \"$wid\"; sleep 1; xdotool key --clearmodifiers alt+shift+l",
    { stdio: "inherit", shell: "/bin/bash" },
  );
}

async function captionsSent() {
  const worker = await waitForWorker();
  return worker.evaluate(() => globalThis.__e2eSentCaptions ?? []);
}

let testPage;
try {
  testPage = (await browser.pages())[0];
  await testPage.goto(testUrl, { waitUntil: "networkidle0" });
  await testPage.bringToFront();
  await testPage.evaluate(async () => {
    const audio = document.querySelector("#audio");
    audio.volume = 1;
    await audio.play();
  });
  await delay(1_500);

  const playback = await testPage.evaluate(() => ({
    started: window.__playStarted,
    error: window.__playError ?? "",
    paused: document.querySelector("#audio").paused,
    currentTime: document.querySelector("#audio").currentTime,
  }));
  console.log(`[playback] ${JSON.stringify(playback)}`);
  if (playback.paused || playback.currentTime <= 0) {
    throw new Error(`Test audio did not start: ${JSON.stringify(playback)}`);
  }

  const extensionsPage = await browser.newPage();
  await extensionsPage.goto("chrome://extensions/", {
    waitUntil: "domcontentloaded",
  });
  await delay(1_500);
  const worker = await waitForWorker();
  const extensionId = worker.url().split("/")[2];
  console.log(`[extension] ${extensionId}`);

  await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({
      settings: {
        ...(stored.settings ?? {}),
        sourceLanguage: "en",
        targetLanguage: "ja",
        modelSize: "tiny",
        performanceMode: "wasm",
        segmentSeconds: 4,
        overlapMilliseconds: 500,
        silenceGate: false,
        showOriginal: true,
        translationEnabled: true,
        captionLifetimeSeconds: 30,
      },
    });

    globalThis.__e2eSentCaptions = [];
    if (!globalThis.__e2eSendWrapped) {
      const originalSend = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = async (...args) => {
        const message = args[1];
        if (message?.type === "content:caption") {
          globalThis.__e2eSentCaptions.push(message.caption);
        }
        return originalSend(...args);
      };
      globalThis.__e2eSendWrapped = true;
    }
  });

  const commands = await worker.evaluate(() => chrome.commands.getAll());
  console.log(`[commands] ${JSON.stringify(commands)}`);
  if (!commands.some((command) => command.name === "toggle-translation")) {
    throw new Error("toggle-translation command is not registered.");
  }

  await extensionsPage.close();
  await testPage.bringToFront();
  await pressShortcut();

  await waitForState(
    (state) => state?.status === "starting" || state?.status === "running",
    20_000,
    "capture startup",
  );

  const running = await waitForState(
    (state) => state?.status === "running",
    12 * 60_000,
    "local model readiness",
  );
  console.log(`[running] ${JSON.stringify(running)}`);

  const captioned = await waitForState(
    (state) => Number(state?.captionCount ?? 0) > 0,
    4 * 60_000,
    "first translated caption",
  );
  console.log(`[captioned] ${JSON.stringify(captioned)}`);

  const sent = await captionsSent();
  console.log(`[captions] ${JSON.stringify(sent)}`);
  if (!sent.length) {
    throw new Error("captionCount increased but no content:caption message was observed.");
  }

  const first = sent[0];
  if (!first.original?.trim()) {
    throw new Error(`Original transcript is empty: ${JSON.stringify(first)}`);
  }
  if (!first.translated?.trim()) {
    throw new Error(`Translated caption is empty: ${JSON.stringify(first)}`);
  }
  if (!/[\u3040-\u30ff\u3400-\u9fff]/u.test(first.translated)) {
    throw new Error(
      `Translated caption does not appear to contain Japanese: ${first.translated}`,
    );
  }

  const overlay = await testPage.evaluate(() => ({
    exists: Boolean(document.querySelector("#helium-live-translator-root")),
    marker: document
      .querySelector("#helium-live-translator-root")
      ?.getAttribute("data-helium-live-translator"),
  }));
  console.log(`[overlay] ${JSON.stringify(overlay)}`);
  if (!overlay.exists || overlay.marker !== "true") {
    throw new Error("Subtitle overlay host was not inserted into the test page.");
  }

  await testPage.screenshot({ path: "e2e-success.png", fullPage: true });

  await testPage.bringToFront();
  await pressShortcut();
  const stopped = await waitForState(
    (state) => state?.status === "idle",
    30_000,
    "clean stop",
  );
  console.log(`[stopped] ${JSON.stringify(stopped)}`);

  console.log("E2E_RESULT=PASS");
} catch (error) {
  console.error(error?.stack ?? error);
  try {
    if (testPage) {
      await testPage.screenshot({ path: "e2e-failure.png", fullPage: true });
    }
  } catch {
    // Preserve the original test error when screenshot capture also fails.
  }
  console.error("E2E_RESULT=FAIL");
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {
    // Browser may already be closed after a fatal launch/runtime error.
  });
  await new Promise((resolve) => server.close(resolve));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
