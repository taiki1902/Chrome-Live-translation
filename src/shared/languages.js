export const LANGUAGES = Object.freeze([
  { code: "auto", label: "自動検出" },
  { code: "ja", label: "日本語" },
  { code: "en", label: "英語" },
  { code: "ko", label: "韓国語" },
  { code: "zh", label: "中国語" },
  { code: "es", label: "スペイン語" },
  { code: "fr", label: "フランス語" },
  { code: "de", label: "ドイツ語" },
  { code: "it", label: "イタリア語" },
  { code: "pt", label: "ポルトガル語" },
  { code: "ru", label: "ロシア語" },
  { code: "id", label: "インドネシア語" },
  { code: "th", label: "タイ語" },
  { code: "vi", label: "ベトナム語" },
]);

export function languageLabel(code) {
  return LANGUAGES.find((language) => language.code === code)?.label ?? code;
}
