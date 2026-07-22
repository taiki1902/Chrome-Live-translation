import { MESSAGE_TYPES, SESSION_STATUS } from "../shared/constants.js";
import { LANGUAGES } from "../shared/languages.js";

const elements = {};
let activeTab = null;
let state = { status: SESSION_STATUS.IDLE };

await initialize();

async function initialize() {
  cacheElements();
  populateLanguages();
  bindEvents();

  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await refreshState();
}

function cacheElements() {
  const ids = [
    "statusPill",
    "statusLabel",
    "sourceLanguage",
    "targetLanguage",
    "swapLanguages",
    "modelSize",
    "performanceMode",
    "segmentSeconds",
    "segmentSecondsValue",
    "position",
    "fontSize",
    "showOriginal",
    "silenceGate",
    "customVocabulary",
    "message",
    "saveButton",
    "toggleButton",
    "toggleButtonLabel",
    "toggleIconPath",
  ];

  for (const id of ids) elements[id] = document.getElementById(id);
}

function populateLanguages() {
  for (const language of LANGUAGES) {
    const sourceOption = document.createElement("option");
    sourceOption.value = language.code;
    sourceOption.textContent = language.label;
    elements.sourceLanguage.append(sourceOption);
  }

  for (const language of LANGUAGES.filter(({ code }) =>
    ["ja", "en"].includes(code),
  )) {
    const targetOption = document.createElement("option");
    targetOption.value = language.code;
    targetOption.textContent = language.label;
    elements.targetLanguage.append(targetOption);
  }
}

function bindEvents() {
  elements.saveButton.addEventListener("click", saveFromForm);
  elements.toggleButton.addEventListener("click", toggleTranslation);
  elements.swapLanguages.addEventListener("click", swapLanguages);
  elements.segmentSeconds.addEventListener("input", updateSegmentLabel);
}

async function refreshState() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.GET_STATE,
    });
    if (!response?.ok)
      throw new Error(response?.error ?? "状態を取得できませんでした。");

    state = response.state;
    applySettings(response.settings);
    renderState();
  } catch (error) {
    showMessage(error.message, "error");
  }
}

function applySettings(settings) {
  elements.sourceLanguage.value = settings.sourceLanguage;
  elements.targetLanguage.value = settings.targetLanguage;
  elements.modelSize.value = settings.modelSize;
  elements.performanceMode.value = settings.performanceMode;
  elements.segmentSeconds.value = settings.segmentSeconds;
  elements.position.value = settings.position;
  elements.fontSize.value = settings.fontSize;
  elements.showOriginal.checked = settings.showOriginal;
  elements.silenceGate.checked = settings.silenceGate;
  elements.customVocabulary.value = settings.customVocabulary;
  updateSegmentLabel();
}

function collectSettings() {
  return {
    sourceLanguage: elements.sourceLanguage.value,
    targetLanguage: elements.targetLanguage.value,
    modelSize: elements.modelSize.value,
    performanceMode: elements.performanceMode.value,
    segmentSeconds: Number(elements.segmentSeconds.value),
    position: elements.position.value,
    fontSize: Number(elements.fontSize.value),
    showOriginal: elements.showOriginal.checked,
    silenceGate: elements.silenceGate.checked,
    customVocabulary: elements.customVocabulary.value.trim(),
  };
}

async function saveFromForm() {
  setBusy(true);
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.SAVE_SETTINGS,
      settings: collectSettings(),
    });
    if (!response?.ok)
      throw new Error(response?.error ?? "設定を保存できませんでした。");
    showMessage("設定を保存しました。", "success");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function toggleTranslation() {
  if (
    state.status === SESSION_STATUS.RUNNING ||
    state.status === SESSION_STATUS.STARTING
  ) {
    await stopTranslation();
    return;
  }

  await startTranslation();
}

async function startTranslation() {
  if (!activeTab?.id) {
    showMessage("アクティブなタブを取得できませんでした。", "error");
    return;
  }

  setBusy(true);
  showMessage("タブ音声を接続しています…");

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.START,
      tabId: activeTab.id,
      settings: collectSettings(),
    });
    if (!response?.ok)
      throw new Error(response?.error ?? "翻訳を開始できませんでした。");

    state = response.state;
    showMessage(
      response.state.modelStatus ||
        "初回はローカルモデルの取得に時間がかかる場合があります。",
      "success",
    );
    renderState();
  } catch (error) {
    showMessage(humanizeCaptureError(error), "error");
    await refreshState();
  } finally {
    setBusy(false);
  }
}

async function stopTranslation() {
  setBusy(true);
  showMessage("停止しています…");

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.STOP,
    });
    if (!response?.ok)
      throw new Error(response?.error ?? "停止できませんでした。");
    state = response.state;
    showMessage("ローカル翻訳字幕を停止しました。", "success");
    renderState();
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(false);
  }
}

function renderState() {
  const status = state.status ?? SESSION_STATUS.IDLE;
  elements.statusPill.dataset.status = status;

  const labels = {
    [SESSION_STATUS.IDLE]: "停止中",
    [SESSION_STATUS.STARTING]: "準備中",
    [SESSION_STATUS.RUNNING]: "翻訳中",
    [SESSION_STATUS.STOPPING]: "停止中",
    [SESSION_STATUS.ERROR]: "エラー",
  };
  elements.statusLabel.textContent = labels[status] ?? status;

  const running =
    status === SESSION_STATUS.RUNNING || status === SESSION_STATUS.STARTING;
  elements.toggleButton.dataset.mode = running ? "stop" : "start";
  elements.toggleButtonLabel.textContent = running
    ? "翻訳を停止"
    : "翻訳を開始";
  elements.toggleIconPath.setAttribute(
    "d",
    running ? "M7 7h10v10H7Z" : "M8 5v14l11-7Z",
  );

  if (status === SESSION_STATUS.ERROR && state.lastError) {
    showMessage(state.lastError, "error");
  } else if (state.modelStatus) {
    showMessage(state.modelStatus);
  }
}

function setBusy(busy) {
  elements.saveButton.disabled = busy;
  elements.toggleButton.disabled = busy;
}

function updateSegmentLabel() {
  elements.segmentSecondsValue.value = `${elements.segmentSeconds.value}秒`;
}

function swapLanguages() {
  const source = elements.sourceLanguage.value;
  const target = elements.targetLanguage.value;

  if (source === "auto") {
    elements.sourceLanguage.value = target;
    elements.targetLanguage.value = target === "ja" ? "en" : "ja";
    return;
  }

  if (["ja", "en"].includes(source)) {
    elements.sourceLanguage.value = target;
    elements.targetLanguage.value = source;
  }
}

function showMessage(message, type = "info") {
  elements.message.textContent = message;
  elements.message.dataset.type = type;
}

function humanizeCaptureError(error) {
  const message = error?.message ?? String(error);
  if (/activeTab|capture|invoked|gesture/i.test(message)) {
    return "タブ音声を取得できませんでした。YouTubeなどの通常ページで、もう一度ボタンを押してください。";
  }
  return message;
}
