import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSettings } from "../src/shared/settings.js";

test("normalizeSettings clamps unsafe numeric values", () => {
  const value = normalizeSettings({
    segmentSeconds: 99,
    fontSize: 2,
    backgroundOpacity: 4,
  });
  assert.equal(value.segmentSeconds, 12);
  assert.equal(value.fontSize, 18);
  assert.equal(value.backgroundOpacity, 0.95);
});

test("normalizeSettings rejects unsupported local settings", () => {
  const value = normalizeSettings({
    targetLanguage: "fr",
    modelSize: "large-v3",
    performanceMode: "cloud",
  });
  assert.equal(value.targetLanguage, "ja");
  assert.equal(value.modelSize, "base");
  assert.equal(value.performanceMode, "auto");
});
