import { RESTRICTED_URL_PREFIXES } from "./constants.js";

export function isRestrictedUrl(url = "") {
  return RESTRICTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

export function normalizeComparableText(value = "") {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function trimTextOverlap(previousText = "", currentText = "") {
  const previousWords = splitWords(previousText);
  const currentWords = splitWords(currentText);

  if (previousWords.length === 0 || currentWords.length === 0) {
    return currentText.trim();
  }

  const maximum = Math.min(16, previousWords.length, currentWords.length);

  for (let size = maximum; size >= 2; size -= 1) {
    const previousSlice = previousWords.slice(-size).join(" ");
    const currentSlice = currentWords.slice(0, size).join(" ");

    if (
      normalizeComparableText(previousSlice) ===
      normalizeComparableText(currentSlice)
    ) {
      return currentWords.slice(size).join(" ").trim();
    }
  }

  return trimCharacterOverlap(previousText, currentText);
}

function trimCharacterOverlap(previousText, currentText) {
  const previous = comparableCharacters(previousText);
  const current = comparableCharacters(currentText);
  const maximum = Math.min(36, previous.length, current.length);

  for (let size = maximum; size >= 4; size -= 1) {
    if (previous.slice(-size).join("") !== current.slice(0, size).join(""))
      continue;

    let comparableCount = 0;
    const normalizedCurrent = String(currentText).normalize("NFKC");
    for (let index = 0; index < normalizedCurrent.length; index += 1) {
      if (isComparableCharacter(normalizedCurrent[index])) comparableCount += 1;
      if (comparableCount === size)
        return normalizedCurrent.slice(index + 1).trim();
    }
  }

  return currentText.trim();
}

function comparableCharacters(value) {
  return Array.from(String(value).normalize("NFKC"))
    .filter(isComparableCharacter)
    .map((character) => character.toLocaleLowerCase());
}

function isComparableCharacter(character) {
  return !/[\p{P}\p{S}\s]/u.test(character);
}

export function cleanSubtitle(value = "") {
  let text = String(value)
    .replace(/^```(?:text)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  text = text.replace(/^(translation|translated text|翻訳)\s*[:：]\s*/i, "");

  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("「") && text.endsWith("」")))
  ) {
    text = text.slice(1, -1).trim();
  }

  return text.replace(/\s+/g, " ").trim();
}

export function extractResponseText(response) {
  if (typeof response?.output_text === "string") {
    return response.output_text;
  }

  const fragments = [];
  for (const item of response?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        fragments.push(content.text);
      }
    }
  }

  return fragments.join("\n").trim();
}

export function createSessionId() {
  return crypto.randomUUID();
}

function splitWords(value) {
  return String(value).trim().split(/\s+/).filter(Boolean);
}
