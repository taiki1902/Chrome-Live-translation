import { MESSAGE_TYPES, SESSION_STATUS } from "../shared/constants.js";
import { LANGUAGES } from "../shared/languages.js";
import { DEFAULT_SETTINGS } from "../shared/settings.js";

const MASKED_KEY = "••••••••••••";

const elements = {};
let activeTab = null;
let state = { status: SESSION_STATUS.IDLE };
let hasStoredApiKey = false;

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
    "apiKey",
    "toggleApiKey",
    "segmentSeconds",
    "segmentSecondsValue",
    "position",
    "fontSize",
    "showOriginal",
    "silenceGate",
    "customVocabulary",
    "transcriptionModel",
    "translationModel",
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
    elements.sourceLanguage.add(new Option(language.label, language.code));
    if (language.code !== "auto") {
      elements.targetLanguage.add(new Option(language.label, language.code));
    }
  }
}

function bindEvents() {
  elements.segmentSeconds.addEventListener("input", updateSegmentLabel);
  elements.saveButton.addEventListener("click", saveFromForm);
  elements.toggleButton.addEventListener("click", toggleTranslation);
  elements.swapLanguages.addEventListener("click", swapLanguages);
  elements.toggleApiKey.addEventListener("click", toggleApiKeyVisibility);
}

async function refreshState() {
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.GET_STATE,
  });

  if (!response?.ok) {
    showMessage(response?.error ?? "状態を取得できませんでした。", "error");
    return;
  }

  state = response.state;
  applySettings(response.settings ?? DEFAULT_SETTINGS);
  renderState();
}

function applySettings(settings) {
  hasStoredApiKey = settings.apiKey === MASKED_KEY;
  elements.apiKey.value = "";
  elements.apiKey.placeholder = hasStoredApiKey
    ? "APIキーは保存済み"
    : "sk-...";
  elements.sourceLanguage.value = settings.sourceLanguage;
  elements.targetLanguage.value = settings.targetLanguage;
  elements.transcriptionModel.value = settings.transcriptionModel;
  elements.translationModel.value = settings.translationModel;
  elements.segmentSeconds.value = String(settings.segmentSeconds);
  elements.position.value = settings.position;
  elements.fontSize.value = String(settings.fontSize);
  elements.showOriginal.checked = settings.showOriginal;
  elements.silenceGate.checked = settings.silenceGate;
  elements.customVocabulary.value = settings.customVocabulary;
  updateSegmentLabel();
}

function collectSettings() {
  const typedApiKey = elements.apiKey.value.trim();
  return {
    apiKey: typedApiKey || (hasStoredApiKey ? MASKED_KEY : ""),
    sourceLanguage: elements.sourceLanguage.value,
    targetLanguage: elements.targetLanguage.value,
    transcriptionModel: elements.transcriptionModel.value.trim(),
    translationModel: elements.translationModel.value.trim(),
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
    hasStoredApiKey = Boolean(response.settings.apiKey);
    elements.apiKey.value = "";
    elements.apiKey.placeholder = hasStoredApiKey
      ? "APIキーは保存済み"
      : "sk-...";
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
    hasStoredApiKey = true;
    elements.apiKey.value = "";
    elements.apiKey.placeholder = "APIキーは保存済み";
    showMessage("翻訳字幕を開始しました。", "success");
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
    showMessage("翻訳字幕を停止しました。", "success");
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
    [SESSION_STATUS.STARTING]: "接続中",
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
    elements.targetLanguage.value = "ja";
  } else {
    elements.sourceLanguage.value = target;
    elements.targetLanguage.value = source;
  }
}

function toggleApiKeyVisibility() {
  const hidden = elements.apiKey.type === "password";
  elements.apiKey.type = hidden ? "text" : "password";
  elements.toggleApiKey.setAttribute(
    "aria-label",
    hidden ? "APIキーを隠す" : "APIキーを表示",
  );
}

function showMessage(message, type = "info") {
  elements.message.textContent = message;
  elements.message.dataset.type = type;
}

function humanizeCaptureError(error) {
  const message = error?.message ?? String(error);
  if (/activeTab|capture|invoked|gesture/i.test(message)) {
    return "タブ音声を取得できませんでした。通常のWebページを開き、もう一度ボタンを押してください。";
  }
  return message;
}
