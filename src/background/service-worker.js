import {
  MESSAGE_TYPES,
  OFFSCREEN_DOCUMENT_PATH,
  SESSION_STATUS,
  STORAGE_KEYS,
  TARGETS,
} from "../shared/constants.js";
import {
  loadSettings,
  normalizeSettings,
  publicSettings,
  saveSettings,
} from "../shared/settings.js";
import { createSessionId, isRestrictedUrl } from "../shared/text.js";

const IDLE_STATE = Object.freeze({
  status: SESSION_STATUS.IDLE,
  sessionId: null,
  tabId: null,
  tabTitle: "",
  tabOrigin: "",
  startedAt: null,
  captionCount: 0,
  modelStatus: "",
  lastError: "",
});

let runtimeState = { ...IDLE_STATE };
let stopPromise = null;

bootstrap().catch(() => undefined);

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await loadSettings();
  await saveSettings(settings);
  await setRuntimeState(IDLE_STATE);
});

chrome.runtime.onStartup.addListener(async () => {
  await setRuntimeState(IDLE_STATE);
  await updateActionBadge();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target && message.target !== TARGETS.SERVICE_WORKER) {
    return false;
  }

  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch(async (error) => {
      const messageText = error?.message ?? String(error);
      if (message?.type === MESSAGE_TYPES.START) {
        await failSession(messageText);
      }
      sendResponse({ ok: false, error: messageText });
    });

  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-translation") return;

  try {
    if (
      runtimeState.status === SESSION_STATUS.RUNNING ||
      runtimeState.status === SESSION_STATUS.STARTING
    ) {
      await stopTranslation("キーボードショートカットで停止しました。");
      return;
    }

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) throw new Error("アクティブなタブを取得できませんでした。");
    await startTranslation({ tabId: tab.id });
  } catch (error) {
    await failSession(error?.message ?? String(error));
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (runtimeState.tabId === tabId) {
    await stopTranslation("対象タブが閉じられました。");
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (
    runtimeState.tabId !== tabId ||
    ![SESSION_STATUS.STARTING, SESSION_STATUS.RUNNING].includes(
      runtimeState.status,
    )
  ) {
    return;
  }

  if (changeInfo.url) {
    try {
      if (new URL(changeInfo.url).origin !== runtimeState.tabOrigin) {
        await stopTranslation("別のサイトへ移動したため翻訳を停止しました。");
        return;
      }
    } catch {
      await stopTranslation(
        "対応していないページへ移動したため翻訳を停止しました。",
      );
      return;
    }
  }

  if (changeInfo.status === "complete") {
    const settings = await loadSettings();
    await ensureContentScript(tabId).catch(() => undefined);
    await sendToContent(tabId, {
      type: MESSAGE_TYPES.CONTENT_CONFIGURE,
      settings: publicSettings(settings),
    });
    await sendToContent(tabId, {
      type: MESSAGE_TYPES.CONTENT_STATUS,
      status:
        runtimeState.status === SESSION_STATUS.RUNNING ? "running" : "starting",
      message: runtimeState.modelStatus || "ローカル字幕を準備しています…",
    });
  }
});

chrome.tabCapture.onStatusChanged.addListener(async (info) => {
  if (
    runtimeState.tabId === info.tabId &&
    info.status === "stopped" &&
    [SESSION_STATUS.STARTING, SESSION_STATUS.RUNNING].includes(
      runtimeState.status,
    )
  ) {
    await stopTranslation("タブの音声キャプチャが終了しました。");
  }
});

async function bootstrap() {
  const stored = await chrome.storage.session.get(STORAGE_KEYS.RUNTIME_STATE);
  runtimeState = {
    ...IDLE_STATE,
    ...(stored[STORAGE_KEYS.RUNTIME_STATE] ?? {}),
  };

  if (runtimeState.status !== SESSION_STATUS.IDLE) {
    await setRuntimeState(IDLE_STATE);
  }
  await updateActionBadge();
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case MESSAGE_TYPES.GET_STATE: {
      const settings = await loadSettings();
      return { state: runtimeState, settings: publicSettings(settings) };
    }

    case MESSAGE_TYPES.SAVE_SETTINGS: {
      const current = await loadSettings();
      const settings = await saveSettings(
        normalizeSettings({ ...current, ...message.settings }),
      );

      if (
        runtimeState.tabId &&
        [SESSION_STATUS.STARTING, SESSION_STATUS.RUNNING].includes(
          runtimeState.status,
        )
      ) {
        await sendToContent(runtimeState.tabId, {
          type: MESSAGE_TYPES.CONTENT_CONFIGURE,
          settings: publicSettings(settings),
        });
      }
      return { settings: publicSettings(settings) };
    }

    case MESSAGE_TYPES.START:
      return startTranslation({
        tabId: message.tabId,
        requestedSettings: message.settings,
      });

    case MESSAGE_TYPES.STOP:
      await stopTranslation("ユーザーが停止しました。");
      return { state: runtimeState };

    case MESSAGE_TYPES.OFFSCREEN_CAPTION:
      return handleCaption(message.payload);

    case MESSAGE_TYPES.OFFSCREEN_PROGRESS:
      return handleProgress(message.payload);

    case MESSAGE_TYPES.OFFSCREEN_ERROR:
      await failSession(
        message.error ?? "字幕処理で不明なエラーが発生しました。",
      );
      return {};

    case MESSAGE_TYPES.OFFSCREEN_STOPPED:
      if (runtimeState.status !== SESSION_STATUS.IDLE) {
        await finishStop(message.reason ?? "音声処理が停止しました。");
      }
      return {};

    default:
      if (sender?.tab?.id && message?.type === MESSAGE_TYPES.CONTENT_PING) {
        return { alive: true };
      }
      return {};
  }
}

async function startTranslation({ tabId, requestedSettings = null }) {
  if (!Number.isInteger(tabId)) {
    throw new Error("対象タブの情報が不足しています。");
  }

  if (
    runtimeState.status === SESSION_STATUS.RUNNING ||
    runtimeState.status === SESSION_STATUS.STARTING
  ) {
    throw new Error("すでに別のタブを翻訳しています。先に停止してください。");
  }

  const streamIdPromise = chrome.tabCapture.getMediaStreamId({
    targetTabId: tabId,
  });
  const offscreenPromise = ensureOffscreenDocument();
  const [tab, currentSettings, streamId] = await Promise.all([
    chrome.tabs.get(tabId),
    loadSettings(),
    streamIdPromise,
    offscreenPromise,
  ]);

  if (!tab?.url || isRestrictedUrl(tab.url)) {
    throw new Error(
      "このページでは実行できません。YouTubeなどの通常ページで使用してください。",
    );
  }

  const settings = requestedSettings
    ? await saveSettings({ ...currentSettings, ...requestedSettings })
    : currentSettings;

  if (runtimeState.status === SESSION_STATUS.ERROR) {
    await setRuntimeState(IDLE_STATE);
  }

  const sessionId = createSessionId();
  await setRuntimeState({
    ...IDLE_STATE,
    status: SESSION_STATUS.STARTING,
    sessionId,
    tabId,
    tabTitle: tab.title ?? "",
    tabOrigin: new URL(tab.url).origin,
    startedAt: Date.now(),
    modelStatus: "タブ音声を接続しています…",
  });

  await ensureContentScript(tabId);
  await sendToContent(tabId, {
    type: MESSAGE_TYPES.CONTENT_CONFIGURE,
    settings: publicSettings(settings),
  });
  await sendToContent(tabId, {
    type: MESSAGE_TYPES.CONTENT_STATUS,
    status: "starting",
    message: "タブ音声を接続しています…",
  });

  const response = await chrome.runtime.sendMessage({
    target: TARGETS.OFFSCREEN,
    type: MESSAGE_TYPES.OFFSCREEN_START,
    payload: { sessionId, tabId, streamId, settings },
  });

  if (!response?.ok) {
    throw new Error(
      response?.error ?? "ローカル音声処理を開始できませんでした。",
    );
  }

  await updateActionBadge();
  return { state: runtimeState };
}

async function stopTranslation(reason) {
  if (runtimeState.status === SESSION_STATUS.IDLE) return;
  if (stopPromise) return stopPromise;

  stopPromise = (async () => {
    const tabId = runtimeState.tabId;
    await setRuntimeState({ ...runtimeState, status: SESSION_STATUS.STOPPING });

    try {
      if (await hasOffscreenDocument()) {
        await chrome.runtime.sendMessage({
          target: TARGETS.OFFSCREEN,
          type: MESSAGE_TYPES.OFFSCREEN_STOP,
          reason,
        });
      }
    } catch {
      // The offscreen document may already have been destroyed by the browser.
    }

    await finishStop(reason, tabId);
  })().finally(() => {
    stopPromise = null;
  });

  return stopPromise;
}

async function finishStop(reason, tabId = runtimeState.tabId) {
  if (tabId) {
    await sendToContent(tabId, {
      type: MESSAGE_TYPES.CONTENT_STATUS,
      status: "stopped",
      message: reason,
    });
    await sendToContent(tabId, { type: MESSAGE_TYPES.CONTENT_CLEAR });
  }
  await setRuntimeState(IDLE_STATE);
  await updateActionBadge();
}

async function failSession(errorMessage) {
  const tabId = runtimeState.tabId;
  await setRuntimeState({
    ...runtimeState,
    status: SESSION_STATUS.ERROR,
    lastError: errorMessage,
    modelStatus: "",
  });
  await updateActionBadge();

  if (tabId) {
    await sendToContent(tabId, {
      type: MESSAGE_TYPES.CONTENT_STATUS,
      status: "error",
      message: errorMessage,
    });
  }

  try {
    if (await hasOffscreenDocument()) {
      await chrome.runtime.sendMessage({
        target: TARGETS.OFFSCREEN,
        type: MESSAGE_TYPES.OFFSCREEN_STOP,
        reason: errorMessage,
      });
    }
  } catch {
    // Best-effort cleanup.
  }
}

async function handleProgress(payload) {
  if (
    !payload ||
    payload.sessionId !== runtimeState.sessionId ||
    payload.tabId !== runtimeState.tabId
  ) {
    return {};
  }

  const nextStatus = payload.ready
    ? SESSION_STATUS.RUNNING
    : SESSION_STATUS.STARTING;
  await setRuntimeState({
    ...runtimeState,
    status: nextStatus,
    modelStatus: payload.message ?? "",
    lastError: "",
  });
  await updateActionBadge();

  await sendToContent(payload.tabId, {
    type: MESSAGE_TYPES.CONTENT_STATUS,
    status: payload.ready ? "running" : "starting",
    message: payload.message,
  });
  return {};
}

async function handleCaption(payload) {
  if (
    !payload ||
    payload.sessionId !== runtimeState.sessionId ||
    payload.tabId !== runtimeState.tabId ||
    runtimeState.status !== SESSION_STATUS.RUNNING
  ) {
    return {};
  }

  await sendToContent(payload.tabId, {
    type: MESSAGE_TYPES.CONTENT_CAPTION,
    caption: payload,
  });

  await setRuntimeState({
    ...runtimeState,
    captionCount: runtimeState.captionCount + 1,
  });
  return {};
}

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE_TYPES.CONTENT_PING,
    });
    if (response?.alive) return;
  } catch {
    // Inject below for tabs that were open before installation/update.
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/content/content.js"],
  });
}

async function sendToContent(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return undefined;
  }
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["USER_MEDIA"],
    justification:
      "Capture the user-selected tab audio and run local speech recognition and translation.",
  });
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });
  return contexts.length > 0;
}

async function setRuntimeState(nextState) {
  runtimeState = { ...IDLE_STATE, ...nextState };
  await chrome.storage.session.set({
    [STORAGE_KEYS.RUNTIME_STATE]: runtimeState,
  });
}

async function updateActionBadge() {
  const running = runtimeState.status === SESSION_STATUS.RUNNING;
  const starting = runtimeState.status === SESSION_STATUS.STARTING;
  const error = runtimeState.status === SESSION_STATUS.ERROR;
  await chrome.action.setBadgeText({
    text: running ? "ON" : starting ? "…" : error ? "!" : "",
  });
  await chrome.action.setBadgeBackgroundColor({
    color: error ? "#ef4444" : "#6d5dfc",
  });
  await chrome.action.setTitle({
    title: running
      ? "Helium Live Translator — ローカル翻訳中"
      : starting
        ? `Helium Live Translator — ${runtimeState.modelStatus || "準備中"}`
        : error
          ? `Helium Live Translator — ${runtimeState.lastError}`
          : "Helium Live Translator",
  });
}
