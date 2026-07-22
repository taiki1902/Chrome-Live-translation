import test from "node:test";
import assert from "node:assert/strict";
import {
  createLocalProcessingPlan,
  whisperModelId,
} from "../src/shared/local-routing.js";

test("auto audio to Japanese uses Whisper translation then local English-Japanese translation", () => {
  assert.deepEqual(
    createLocalProcessingPlan({ sourceLanguage: "auto", targetLanguage: "ja" }),
    {
      asrTask: "translate",
      asrLanguage: null,
      intermediateLanguage: "en",
      translationPair: { sourceLanguage: "en", targetLanguage: "ja" },
    },
  );
});

test("English audio to Japanese keeps English transcription", () => {
  assert.deepEqual(
    createLocalProcessingPlan({ sourceLanguage: "en", targetLanguage: "ja" }),
    {
      asrTask: "transcribe",
      asrLanguage: "english",
      intermediateLanguage: "en",
      translationPair: { sourceLanguage: "en", targetLanguage: "ja" },
    },
  );
});

test("Japanese audio to English uses Whisper audio translation without a text model", () => {
  const plan = createLocalProcessingPlan({
    sourceLanguage: "ja",
    targetLanguage: "en",
  });
  assert.equal(plan.asrTask, "translate");
  assert.equal(plan.translationPair, null);
});

test("model size maps to supported browser Whisper models", () => {
  assert.equal(whisperModelId("tiny"), "onnx-community/whisper-tiny");
  assert.equal(whisperModelId("base"), "onnx-community/whisper-base");
});
