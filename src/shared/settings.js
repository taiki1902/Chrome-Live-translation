import { STORAGE_KEYS } from "./constants.js";

export const DEFAULT_SETTINGS = Object.freeze({
  sourceLanguage: "auto",
  targetLanguage: "ja",
  modelSize: "base",
  performanceMode: "auto",
  segmentSeconds: 6,
  overlapMilliseconds: 700,
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
const ALLOWED_MODEL_SIZES = new Set(["tiny", "base"]);
const ALLOWED_PERFORMANCE_MODES = new Set(["auto", "webgpu", "wasm"]);
const ALLOWED_TARGET_LANGUAGES = new Set(["ja", "en"]);

export function normalizeSettings(value = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...(value ?? {}) };

  return {
    sourceLanguage:
      typeof merged.sourceLanguage === "string"
        ? merged.sourceLanguage
        : "auto",
    targetLanguage: ALLOWED_TARGET_LANGUAGES.has(merged.targetLanguage)
      ? merged.targetLanguage
      : DEFAULT_SETTINGS.targetLanguage,
    modelSize: ALLOWED_MODEL_SIZES.has(merged.modelSize)
      ? merged.modelSize
      : DEFAULT_SETTINGS.modelSize,
    performanceMode: ALLOWED_PERFORMANCE_MODES.has(merged.performanceMode)
      ? merged.performanceMode
      : DEFAULT_SETTINGS.performanceMode,
    segmentSeconds: clampNumber(merged.segmentSeconds, 4, 12, 6),
    overlapMilliseconds: clampNumber(
      merged.overlapMilliseconds,
      0,
      1_500,
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
  return { ...settings };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
