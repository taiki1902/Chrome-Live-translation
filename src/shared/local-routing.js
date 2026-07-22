const WHISPER_LANGUAGE_NAMES = Object.freeze({
  ja: "japanese",
  en: "english",
  ko: "korean",
  zh: "chinese",
  es: "spanish",
  fr: "french",
  de: "german",
  it: "italian",
  pt: "portuguese",
  ru: "russian",
  id: "indonesian",
  th: "thai",
  vi: "vietnamese",
});

export function createLocalProcessingPlan(settings) {
  const source = settings.sourceLanguage;
  const target = settings.targetLanguage;

  if (source !== "auto" && source === target) {
    return {
      asrTask: "transcribe",
      asrLanguage: WHISPER_LANGUAGE_NAMES[source] ?? null,
      intermediateLanguage: source,
      translationPair: null,
    };
  }

  if (target === "en") {
    return {
      asrTask: source === "en" ? "transcribe" : "translate",
      asrLanguage:
        source === "auto" ? null : (WHISPER_LANGUAGE_NAMES[source] ?? null),
      intermediateLanguage: "en",
      translationPair: null,
    };
  }

  if (target === "ja") {
    if (source === "ja") {
      return {
        asrTask: "transcribe",
        asrLanguage: "japanese",
        intermediateLanguage: "ja",
        translationPair: null,
      };
    }

    return {
      asrTask: source === "en" ? "transcribe" : "translate",
      asrLanguage:
        source === "auto" ? null : (WHISPER_LANGUAGE_NAMES[source] ?? null),
      intermediateLanguage: "en",
      translationPair: { sourceLanguage: "en", targetLanguage: "ja" },
    };
  }

  throw new Error("現在のローカル版は日本語または英語の字幕に対応しています。");
}

export function whisperModelId(modelSize) {
  return modelSize === "tiny"
    ? "onnx-community/whisper-tiny"
    : "onnx-community/whisper-base";
}

export const LOCAL_TRANSLATION_MODEL = "Xenova/opus-mt-en-jap";
