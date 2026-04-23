export interface PresetLanguage {
  readonly display_name_zh: string;
  readonly display_name_en: string;
  readonly language_code: string;
  readonly bcp47_tag: string;
  readonly is_preset: true;
  readonly is_low_resource: boolean;
  readonly rtl: boolean;
  readonly aliases: readonly string[];
}

/** Preset language dictionary. UI displays language names, not internal codes. */
export const PRESET_LANGUAGES = [
  {
    display_name_zh: "英语",
    display_name_en: "English",
    language_code: "EN",
    bcp47_tag: "en",
    is_preset: true,
    is_low_resource: false,
    rtl: false,
    aliases: ["english", "英语", "en"],
  },
  {
    display_name_zh: "葡萄牙语",
    display_name_en: "Portuguese",
    language_code: "PT",
    bcp47_tag: "pt",
    is_preset: true,
    is_low_resource: false,
    rtl: false,
    aliases: ["portuguese", "葡萄牙语", "葡语", "pt"],
  },
  {
    display_name_zh: "西班牙语",
    display_name_en: "Spanish",
    language_code: "ES",
    bcp47_tag: "es",
    is_preset: true,
    is_low_resource: false,
    rtl: false,
    aliases: ["spanish", "西班牙语", "西语", "es"],
  },
  {
    display_name_zh: "法语",
    display_name_en: "French",
    language_code: "FR",
    bcp47_tag: "fr",
    is_preset: true,
    is_low_resource: false,
    rtl: false,
    aliases: ["french", "法语", "fr"],
  },
  {
    display_name_zh: "德语",
    display_name_en: "German",
    language_code: "DE",
    bcp47_tag: "de",
    is_preset: true,
    is_low_resource: false,
    rtl: false,
    aliases: ["german", "德语", "de"],
  },
  {
    display_name_zh: "意大利语",
    display_name_en: "Italian",
    language_code: "IT",
    bcp47_tag: "it",
    is_preset: true,
    is_low_resource: false,
    rtl: false,
    aliases: ["italian", "意大利语", "it"],
  },
  {
    display_name_zh: "荷兰语",
    display_name_en: "Dutch",
    language_code: "NL",
    bcp47_tag: "nl",
    is_preset: true,
    is_low_resource: false,
    rtl: false,
    aliases: ["dutch", "荷兰语", "nl"],
  },
  {
    display_name_zh: "瑞典语",
    display_name_en: "Swedish",
    language_code: "SV",
    bcp47_tag: "sv",
    is_preset: true,
    is_low_resource: false,
    rtl: false,
    aliases: ["swedish", "瑞典语", "sv"],
  },
  {
    display_name_zh: "俄语",
    display_name_en: "Russian",
    language_code: "RU",
    bcp47_tag: "ru",
    is_preset: true,
    is_low_resource: false,
    rtl: false,
    aliases: ["russian", "俄语", "ru"],
  },
  {
    display_name_zh: "阿拉伯语",
    display_name_en: "Arabic",
    language_code: "AR",
    bcp47_tag: "ar",
    is_preset: true,
    is_low_resource: false,
    rtl: true,
    aliases: ["arabic", "阿拉伯语", "ar"],
  },
  {
    display_name_zh: "希腊语",
    display_name_en: "Greek",
    language_code: "EL",
    bcp47_tag: "el",
    is_preset: true,
    is_low_resource: false,
    rtl: false,
    aliases: ["greek", "希腊语", "el"],
  },
  {
    display_name_zh: "希伯来语",
    display_name_en: "Hebrew",
    language_code: "HE",
    bcp47_tag: "he",
    is_preset: true,
    is_low_resource: false,
    rtl: true,
    aliases: ["hebrew", "希伯来语", "he"],
  },
  {
    display_name_zh: "简体中文",
    display_name_en: "Simplified Chinese",
    language_code: "zh-Hans",
    bcp47_tag: "zh-Hans",
    is_preset: true,
    is_low_resource: false,
    rtl: false,
    aliases: [
      "simplified chinese",
      "chinese simplified",
      "简体中文",
      "简中",
      "zh-hans",
      "zh_cn",
      "zh-cn",
    ],
  },
  {
    display_name_zh: "繁体中文",
    display_name_en: "Traditional Chinese",
    language_code: "zh-Hant",
    bcp47_tag: "zh-Hant",
    is_preset: true,
    is_low_resource: false,
    rtl: false,
    aliases: [
      "traditional chinese",
      "chinese traditional",
      "繁体中文",
      "繁中",
      "zh-hant",
      "zh_tw",
      "zh-tw",
    ],
  },
  {
    display_name_zh: "日语",
    display_name_en: "Japanese",
    language_code: "JA",
    bcp47_tag: "ja",
    is_preset: true,
    is_low_resource: false,
    rtl: false,
    aliases: ["japanese", "日语", "日文", "ja"],
  },
  {
    display_name_zh: "韩语",
    display_name_en: "Korean",
    language_code: "KO",
    bcp47_tag: "ko",
    is_preset: true,
    is_low_resource: false,
    rtl: false,
    aliases: ["korean", "韩语", "韩文", "ko"],
  },
  {
    display_name_zh: "克林贡语",
    display_name_en: "Klingon",
    language_code: "TLH",
    bcp47_tag: "tlh",
    is_preset: true,
    is_low_resource: true,
    rtl: false,
    aliases: ["klingon", "克林贡语", "tlh"],
  },
] as const satisfies readonly PresetLanguage[];

export type PresetLanguageCode = (typeof PRESET_LANGUAGES)[number]["language_code"];

function normalizeLanguageInput(input: string): string {
  return input
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, " ");
}

function findPresetLanguageByNormalizedInput(
  normalizedInput: string
): (typeof PRESET_LANGUAGES)[number] | null {
  if (!normalizedInput) {
    return null;
  }

  for (const lang of PRESET_LANGUAGES) {
    const candidates = [
      lang.display_name_en,
      lang.display_name_zh,
      lang.language_code,
      lang.bcp47_tag,
      ...lang.aliases,
    ];
    if (
      candidates.some((candidate) => normalizeLanguageInput(candidate) === normalizedInput)
    ) {
      return lang;
    }
  }

  return null;
}

/** Attempts to match a natural-language input to a preset language code. */
export function matchPresetLanguage(input: string): PresetLanguageCode | null {
  const normalized = normalizeLanguageInput(input);
  return findPresetLanguageByNormalizedInput(normalized)?.language_code ?? null;
}

/** Resolves the user-facing language label that should be passed to the model. */
export function resolveModelTargetLanguage(input: string): string {
  const normalized = normalizeLanguageInput(input);
  const preset = findPresetLanguageByNormalizedInput(normalized);
  if (preset) {
    return preset.display_name_en;
  }

  return input.trim();
}

type ScriptValidationProfile = {
  readonly labels: readonly string[];
  readonly targetScriptPattern: RegExp;
  readonly fallbackScriptPattern?: RegExp;
};

const SCRIPT_VALIDATION_PROFILES: readonly ScriptValidationProfile[] = [
  {
    labels: ["arabic", "ar", "阿拉伯语"],
    targetScriptPattern: /\p{Script=Arabic}/gu,
    fallbackScriptPattern: /\p{Script=Latin}/gu,
  },
  {
    labels: ["greek", "el", "希腊语"],
    targetScriptPattern: /\p{Script=Greek}/gu,
    fallbackScriptPattern: /\p{Script=Latin}/gu,
  },
  {
    labels: ["hebrew", "he", "希伯来语"],
    targetScriptPattern: /\p{Script=Hebrew}/gu,
    fallbackScriptPattern: /\p{Script=Latin}/gu,
  },
  {
    labels: ["russian", "ru", "俄语"],
    targetScriptPattern: /\p{Script=Cyrillic}/gu,
    fallbackScriptPattern: /\p{Script=Latin}/gu,
  },
  {
    labels: [
      "simplified chinese",
      "traditional chinese",
      "zh hans",
      "zh hant",
      "简体中文",
      "繁体中文",
    ],
    targetScriptPattern: /\p{Script=Han}/gu,
    fallbackScriptPattern: /\p{Script=Latin}/gu,
  },
  {
    labels: ["japanese", "ja", "日语", "日文"],
    targetScriptPattern: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu,
    fallbackScriptPattern: /\p{Script=Latin}/gu,
  },
  {
    labels: ["korean", "ko", "韩语", "韩文"],
    targetScriptPattern: /\p{Script=Hangul}/gu,
    fallbackScriptPattern: /\p{Script=Latin}/gu,
  },
  {
    labels: ["tibetan", "bo", "藏语", "藏文"],
    targetScriptPattern: /\p{Script=Tibetan}/gu,
    fallbackScriptPattern: /\p{Script=Latin}/gu,
  },
] as const;

function countMatches(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  return [...text.matchAll(regex)].length;
}

function findScriptValidationProfile(input: string): ScriptValidationProfile | null {
  const normalized = normalizeLanguageInput(input);
  if (!normalized) {
    return null;
  }

  return (
    SCRIPT_VALIDATION_PROFILES.find((profile) =>
      profile.labels.some((label) => normalizeLanguageInput(label) === normalized)
    ) ?? null
  );
}

export type TargetLanguageValidationResult =
  | {
      readonly ok: true;
      readonly checked: boolean;
    }
  | {
      readonly ok: false;
      readonly checked: true;
      readonly reason: string;
    };

/**
 * Performs a lightweight script-based validation to catch obvious target-language mismatches
 * without blocking custom languages that do not have a reliable script profile.
 */
export function validateTargetLanguageOutput(
  targetLanguageInput: string,
  translatedTexts: readonly string[]
): TargetLanguageValidationResult {
  const profile = findScriptValidationProfile(targetLanguageInput);
  if (!profile) {
    return { ok: true, checked: false };
  }

  const sample = translatedTexts
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .join("\n")
    .slice(0, 4_000);
  if (!sample) {
    return { ok: true, checked: true };
  }

  const targetScriptChars = countMatches(sample, profile.targetScriptPattern);
  const fallbackScriptChars = profile.fallbackScriptPattern
    ? countMatches(sample, profile.fallbackScriptPattern)
    : 0;
  const significantChars = targetScriptChars + fallbackScriptChars;

  if (targetScriptChars >= 4) {
    return { ok: true, checked: true };
  }

  if (significantChars < 12) {
    return { ok: true, checked: true };
  }

  if (targetScriptChars === 0 && fallbackScriptChars >= Math.ceil(significantChars * 0.6)) {
    return {
      ok: false,
      checked: true,
      reason: `Translated output does not appear to be in ${resolveModelTargetLanguage(targetLanguageInput)}.`,
    };
  }

  return { ok: true, checked: true };
}
