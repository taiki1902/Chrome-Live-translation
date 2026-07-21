import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanSubtitle,
  extractResponseText,
  isRestrictedUrl,
  trimTextOverlap,
} from "../src/shared/text.js";

test("trimTextOverlap removes duplicated words from overlapped audio", () => {
  assert.equal(
    trimTextOverlap(
      "hello everyone welcome to the stream",
      "welcome to the stream today we play",
    ),
    "today we play",
  );
});

test("trimTextOverlap keeps unrelated text", () => {
  assert.equal(
    trimTextOverlap("first caption", "second caption"),
    "second caption",
  );
});

test("extractResponseText reads Responses API message content", () => {
  assert.equal(
    extractResponseText({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "翻訳結果" }],
        },
      ],
    }),
    "翻訳結果",
  );
});

test("cleanSubtitle removes translation wrappers", () => {
  assert.equal(cleanSubtitle("翻訳: 「こんにちは」"), "こんにちは");
});

test("isRestrictedUrl blocks browser internal pages", () => {
  assert.equal(isRestrictedUrl("chrome://extensions"), true);
  assert.equal(isRestrictedUrl("https://example.com"), false);
});

test("trimTextOverlap handles Japanese text without spaces", () => {
  assert.equal(
    trimTextOverlap(
      "今日はゲーム配信を始めます",
      "配信を始めますよろしくお願いします",
    ),
    "よろしくお願いします",
  );
});
