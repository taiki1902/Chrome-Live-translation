import { STORAGE_KEYS } from "./constants.js";

export const DEFAULT_SETTINGS = Object.freeze({
  apiKey: "",
  sourceLanguage: "auto",
  targetLanguage: "ja",
  transcriptionModel: "gpt-4o-mini-transcribe",
  translationModel: "gpt-5-mini",
  segmentSeconds: 4,
  overlapMilliseconds: 450,
  showOriginal: true,
  translationEnabled: true,
  fontSize: 27,
  backgroundOpacity: 0.76,
  position: "bottom",
  maxCaptionRows: 3,
  captionLifetimeSeconds: 12,
  silenceGate: true,
  silenceThreshold: 0.012,
  customVocabulary: "",
});

const ALLOWED_POSITIONS = new Set(["top", "bottom"]);

export function normalizeSettings(value = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...(value ?? {}) };

  return {
    apiKey: typeof merged.apiKey === "string" ? merged.apiKey.trim() : "",
    sourceLanguage:
      typeof merged.sourceLanguage === "string"
        ? merged.sourceLanguage
        : "auto",
    targetLanguage:
      typeof merged.targetLanguage === "string" ? merged.targetLanguage : "ja",
    transcriptionModel: sanitizeModel(
      merged.transcriptionModel,
      DEFAULT_SETTINGS.transcriptionModel,
    ),
    translationModel: sanitizeModel(
      merged.translationModel,
      DEFAULT_SETTINGS.translationModel,
    ),
    segmentSeconds: clampNumber(merged.segmentSeconds, 3, 10, 4),
    overlapMilliseconds: clampNumber(
      merged.overlapMilliseconds,
      0,
      900,
      DEFAULT_SETTINGS.overlapMilliseconds,
    ),
    showOriginal: Boolean(merged.showOriginal),
    translationEnabled: Boolean(merged.translationEnabled),
    fontSize: clampNumber(merged.fontSize, 18, 48, DEFAULT_SETTINGS.fontSize),
    backgroundOpacity: clampNumber(
      merged.backgroundOpacity,
      0.2,
      0.95,
      DEFAULT_SETTINGS.backgroundOpacity,
    ),
    position: ALLOWED_POSITIONS.has(merged.position)
      ? merged.position
      : DEFAULT_SETTINGS.position,
    maxCaptionRows: clampNumber(
      merged.maxCaptionRows,
      1,
      6,
      DEFAULT_SETTINGS.maxCaptionRows,
    ),
    captionLifetimeSeconds: clampNumber(
      merged.captionLifetimeSeconds,
      4,
      30,
      DEFAULT_SETTINGS.captionLifetimeSeconds,
    ),
    silenceGate: Boolean(merged.silenceGate),
    silenceThreshold: clampNumber(
      merged.silenceThreshold,
      0.003,
      0.08,
      DEFAULT_SETTINGS.silenceThreshold,
    ),
    customVocabulary:
      typeof merged.customVocabulary === "string"
        ? merged.customVocabulary.trim().slice(0, 800)
        : "",
  };
}

export async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return normalizeSettings(stored[STORAGE_KEYS.SETTINGS]);
}

export async function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: normalized });
  return normalized;
}

export function publicSettings(settings) {
  return { ...settings, apiKey: settings.apiKey ? "••••••••••••" : "" };
}

function sanitizeModel(value, fallback) {
  if (typeof value !== "string") return fallback;
  const model = value.trim();
  return /^[a-zA-Z0-9._:-]{2,100}$/.test(model) ? model : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
