import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSettings } from "../src/shared/settings.js";

test("normalizeSettings clamps unsafe numeric values", () => {
  const value = normalizeSettings({
    segmentSeconds: 99,
    fontSize: 2,
    backgroundOpacity: 4,
  });
  assert.equal(value.segmentSeconds, 10);
  assert.equal(value.fontSize, 18);
  assert.equal(value.backgroundOpacity, 0.95);
});

test("normalizeSettings rejects malformed model identifiers", () => {
  assert.equal(
    normalizeSettings({ translationModel: "<script>" }).translationModel,
    "gpt-5-mini",
  );
});
