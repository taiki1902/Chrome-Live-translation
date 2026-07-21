(() => {
  if (globalThis.__HELIUM_LIVE_TRANSLATOR_LOADED__) return;
  globalThis.__HELIUM_LIVE_TRANSLATOR_LOADED__ = true;

  const MESSAGE_TYPES = {
    CONTENT_PING: "content:ping",
    CONTENT_CONFIGURE: "content:configure",
    CONTENT_STATUS: "content:status",
    CONTENT_CAPTION: "content:caption",
    CONTENT_CLEAR: "content:clear",
  };

  const DEFAULT_VIEW_SETTINGS = {
    showOriginal: true,
    fontSize: 27,
    backgroundOpacity: 0.76,
    position: "bottom",
    maxCaptionRows: 3,
    captionLifetimeSeconds: 12,
  };

  let settings = { ...DEFAULT_VIEW_SETTINGS };
  let host;
  let shadow;
  let captionList;
  let statusElement;
  let statusTimer;
  const captionTimers = new Map();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case MESSAGE_TYPES.CONTENT_PING:
        sendResponse({ alive: true });
        return false;

      case MESSAGE_TYPES.CONTENT_CONFIGURE:
        configure(message.settings ?? {});
        sendResponse({ ok: true });
        return false;

      case MESSAGE_TYPES.CONTENT_STATUS:
        showStatus(message.status, message.message);
        sendResponse({ ok: true });
        return false;

      case MESSAGE_TYPES.CONTENT_CAPTION:
        appendCaption(message.caption);
        sendResponse({ ok: true });
        return false;

      case MESSAGE_TYPES.CONTENT_CLEAR:
        clearCaptions();
        sendResponse({ ok: true });
        return false;

      default:
        return false;
    }
  });

  document.addEventListener("fullscreenchange", relocateForFullscreen);

  function ensureOverlay() {
    if (host?.isConnected) return;

    host = document.createElement("div");
    host.id = "helium-live-translator-root";
    host.setAttribute("data-helium-live-translator", "true");
    shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      :host {
        --hlt-font-size: 27px;
        --hlt-background-opacity: 0.76;
        all: initial;
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        pointer-events: none;
        font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont,
          "Segoe UI", "Noto Sans JP", sans-serif;
        color: #fff;
        contain: layout style;
      }

      .stage {
        position: absolute;
        left: 50%;
        width: min(92vw, 1100px);
        transform: translateX(-50%);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        transition: top 180ms ease, bottom 180ms ease;
      }

      .stage[data-position="bottom"] {
        bottom: max(6vh, 40px);
      }

      .stage[data-position="top"] {
        top: max(6vh, 40px);
      }

      .captions {
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 7px;
      }

      .caption {
        box-sizing: border-box;
        max-width: 100%;
        padding: 10px 17px 11px;
        border: 1px solid rgba(255, 255, 255, 0.13);
        border-radius: 13px;
        background: rgba(8, 10, 18, var(--hlt-background-opacity));
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.32);
        backdrop-filter: blur(10px) saturate(1.15);
        -webkit-backdrop-filter: blur(10px) saturate(1.15);
        text-align: center;
        animation: hlt-enter 180ms ease-out both;
      }

      .caption[data-removing="true"] {
        animation: hlt-exit 170ms ease-in both;
      }

      .translation {
        font-size: var(--hlt-font-size);
        line-height: 1.45;
        font-weight: 720;
        letter-spacing: 0.015em;
        overflow-wrap: anywhere;
        text-wrap: balance;
        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.78);
      }

      .original {
        margin-top: 4px;
        font-size: max(13px, calc(var(--hlt-font-size) * 0.58));
        line-height: 1.35;
        font-weight: 520;
        color: rgba(255, 255, 255, 0.78);
        overflow-wrap: anywhere;
        text-wrap: balance;
      }

      .status {
        max-width: min(88vw, 680px);
        padding: 8px 13px;
        border-radius: 999px;
        background: rgba(18, 22, 35, 0.86);
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
        color: rgba(255, 255, 255, 0.92);
        font-size: 13px;
        font-weight: 650;
        line-height: 1.35;
        opacity: 0;
        transform: translateY(4px);
        transition: opacity 160ms ease, transform 160ms ease;
      }

      .status[data-visible="true"] {
        opacity: 1;
        transform: translateY(0);
      }

      .status[data-status="error"] {
        background: rgba(90, 18, 26, 0.92);
        border-color: rgba(255, 120, 130, 0.32);
      }

      .status[data-status="running"] {
        background: rgba(24, 57, 50, 0.92);
        border-color: rgba(111, 255, 210, 0.24);
      }

      @keyframes hlt-enter {
        from { opacity: 0; transform: translateY(8px) scale(0.985); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      @keyframes hlt-exit {
        from { opacity: 1; transform: translateY(0) scale(1); }
        to { opacity: 0; transform: translateY(-5px) scale(0.985); }
      }

      @media (max-width: 640px) {
        .stage { width: 94vw; }
        .caption { padding: 8px 12px 9px; border-radius: 10px; }
      }

      @media (prefers-reduced-motion: reduce) {
        .caption, .caption[data-removing="true"] { animation: none; }
        .status, .stage { transition: none; }
      }
    `;

    const stage = document.createElement("div");
    stage.className = "stage";
    stage.dataset.position = settings.position;

    captionList = document.createElement("div");
    captionList.className = "captions";
    captionList.setAttribute("role", "log");
    captionList.setAttribute("aria-live", "polite");
    captionList.setAttribute("aria-relevant", "additions");

    statusElement = document.createElement("div");
    statusElement.className = "status";
    statusElement.setAttribute("role", "status");

    stage.append(captionList, statusElement);
    shadow.append(style, stage);
    document.documentElement.append(host);
    applySettings();
    relocateForFullscreen();
  }

  function configure(nextSettings) {
    settings = {
      ...settings,
      ...pickViewSettings(nextSettings),
    };
    ensureOverlay();
    applySettings();
  }

  function applySettings() {
    if (!host || !shadow) return;
    host.style.setProperty("--hlt-font-size", `${settings.fontSize}px`);
    host.style.setProperty(
      "--hlt-background-opacity",
      String(settings.backgroundOpacity),
    );
    const stage = shadow.querySelector(".stage");
    if (stage) stage.dataset.position = settings.position;
    enforceCaptionLimit();
  }

  function appendCaption(caption) {
    if (!caption?.translated && !caption?.original) return;
    ensureOverlay();

    const entry = document.createElement("div");
    entry.className = "caption";
    entry.dataset.sequence = String(caption.sequence ?? Date.now());

    const translated = document.createElement("div");
    translated.className = "translation";
    translated.textContent = caption.translated || caption.original;
    entry.append(translated);

    if (
      settings.showOriginal &&
      caption.original &&
      caption.original !== caption.translated
    ) {
      const original = document.createElement("div");
      original.className = "original";
      original.textContent = caption.original;
      entry.append(original);
    }

    captionList.append(entry);
    enforceCaptionLimit();

    const timer = setTimeout(
      () => removeCaption(entry),
      settings.captionLifetimeSeconds * 1_000,
    );
    captionTimers.set(entry, timer);
  }

  function enforceCaptionLimit() {
    if (!captionList) return;
    while (captionList.children.length > settings.maxCaptionRows) {
      removeCaption(captionList.firstElementChild, true);
    }
  }

  function removeCaption(element, immediate = false) {
    if (!element) return;
    const timer = captionTimers.get(element);
    if (timer) clearTimeout(timer);
    captionTimers.delete(element);

    if (immediate) {
      element.remove();
      return;
    }

    element.dataset.removing = "true";
    setTimeout(() => element.remove(), 180);
  }

  function clearCaptions() {
    if (!captionList) return;
    for (const timer of captionTimers.values()) clearTimeout(timer);
    captionTimers.clear();
    captionList.replaceChildren();
  }

  function showStatus(status, message) {
    ensureOverlay();
    clearTimeout(statusTimer);

    statusElement.textContent = message || status || "";
    statusElement.dataset.status = status || "info";
    statusElement.dataset.visible = "true";

    const duration = status === "error" ? 9_000 : 2_600;
    statusTimer = setTimeout(() => {
      statusElement.dataset.visible = "false";
    }, duration);
  }

  function relocateForFullscreen() {
    if (!host) return;
    const fullscreenElement = document.fullscreenElement;
    const target =
      fullscreenElement && !(fullscreenElement instanceof HTMLVideoElement)
        ? fullscreenElement
        : document.documentElement;

    if (host.parentNode !== target) target.append(host);
  }

  function pickViewSettings(value) {
    return {
      showOriginal:
        typeof value.showOriginal === "boolean"
          ? value.showOriginal
          : settings.showOriginal,
      fontSize: clamp(value.fontSize, 18, 48, settings.fontSize),
      backgroundOpacity: clamp(
        value.backgroundOpacity,
        0.2,
        0.95,
        settings.backgroundOpacity,
      ),
      position: value.position === "top" ? "top" : "bottom",
      maxCaptionRows: clamp(
        value.maxCaptionRows,
        1,
        6,
        settings.maxCaptionRows,
      ),
      captionLifetimeSeconds: clamp(
        value.captionLifetimeSeconds,
        4,
        30,
        settings.captionLifetimeSeconds,
      ),
    };
  }

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }
})();
