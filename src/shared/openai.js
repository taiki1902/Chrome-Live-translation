import { API_BASE_URL } from "./constants.js";
import { cleanSubtitle, extractResponseText, trimTextOverlap } from "./text.js";
import { languageLabel } from "./languages.js";

const REQUEST_TIMEOUT_MS = 45_000;

export class ApiError extends Error {
  constructor(message, { status = 0, code = "api_error" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export async function transcribeAudio({
  blob,
  settings,
  signal,
  previousTranscript = "",
}) {
  const form = new FormData();
  const extension = extensionForMimeType(blob.type);
  form.append("file", blob, `segment-${Date.now()}.${extension}`);
  form.append("model", settings.transcriptionModel);
  form.append("response_format", "json");
  form.append("temperature", "0");

  if (settings.sourceLanguage !== "auto") {
    form.append("language", settings.sourceLanguage);
  }

  const prompt = buildTranscriptionPrompt(settings, previousTranscript);
  if (prompt) form.append("prompt", prompt);

  const response = await requestJson(`${API_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: authorizationHeader(settings.apiKey),
    body: form,
    signal,
  });

  const rawText =
    typeof response?.text === "string" ? response.text.trim() : "";
  return trimTextOverlap(previousTranscript, rawText);
}

export async function translateText({ text, settings, signal }) {
  if (!settings.translationEnabled || !text) return text;

  const targetLanguage = languageLabel(settings.targetLanguage);
  const vocabulary = settings.customVocabulary
    ? `\n固有名詞・専門語の参考: ${settings.customVocabulary}`
    : "";

  const response = await requestJson(`${API_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      ...authorizationHeader(settings.apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: settings.translationModel,
      store: false,
      max_output_tokens: 500,
      instructions:
        `あなたはライブ配信字幕の翻訳器です。入力文を${targetLanguage}へ自然かつ簡潔に翻訳してください。` +
        "人名、作品名、ゲーム用語、数値を保持し、説明・注釈・引用符・前置きを追加せず、翻訳字幕だけを返してください。" +
        vocabulary,
      input: text,
    }),
    signal,
  });

  const translated = cleanSubtitle(extractResponseText(response));
  if (!translated) {
    throw new ApiError("翻訳APIから空の応答が返されました。", {
      code: "empty_translation",
    });
  }
  return translated;
}

async function requestJson(url, options) {
  const { signal, cleanup } = createTimeoutSignal(options.signal);

  try {
    const response = await fetch(url, { ...options, signal });
    const payload = await parseResponse(response);

    if (!response.ok) {
      const message =
        payload?.error?.message ??
        payload?.message ??
        `APIリクエストに失敗しました（HTTP ${response.status}）。`;
      throw new ApiError(humanizeApiError(message, response.status), {
        status: response.status,
        code: payload?.error?.code ?? "http_error",
      });
    }

    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw error;
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      `通信に失敗しました: ${error?.message ?? String(error)}`,
      {
        code: "network_error",
      },
    );
  } finally {
    cleanup();
  }
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function authorizationHeader(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

function createTimeoutSignal(parentSignal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort("request-timeout"),
    REQUEST_TIMEOUT_MS,
  );

  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function buildTranscriptionPrompt(settings, previousTranscript) {
  const parts = [];
  if (previousTranscript) {
    parts.push(previousTranscript.slice(-500));
  }
  if (settings.customVocabulary) {
    parts.push(settings.customVocabulary);
  }
  return parts.join("\n").slice(0, 900);
}

function extensionForMimeType(mimeType = "") {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

function humanizeApiError(message, status) {
  if (status === 401) return "OpenAI APIキーが無効、または権限がありません。";
  if (status === 429) return "APIの利用上限またはレート制限に達しました。";
  if (status >= 500)
    return `OpenAI API側で一時的な障害が発生しました: ${message}`;
  return message;
}
