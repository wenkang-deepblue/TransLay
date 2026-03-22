/** Preset language list. UI displays name only, never the code. */
export const PRESET_LANGUAGES = [
  { name: "English", code: "en" },
  { name: "Portuguese", code: "pt" },
  { name: "Spanish", code: "es" },
  { name: "French", code: "fr" },
  { name: "German", code: "de" },
  { name: "Italian", code: "it" },
  { name: "Dutch", code: "nl" },
  { name: "Swedish", code: "sv" },
  { name: "Russian", code: "ru" },
  { name: "Arabic", code: "ar" },
  { name: "Greek", code: "el" },
  { name: "Hebrew", code: "he" },
  { name: "Simplified Chinese", code: "zh-CN" },
  { name: "Traditional Chinese", code: "zh-TW" },
  { name: "Japanese", code: "ja" },
  { name: "Korean", code: "ko" },
  { name: "Klingon", code: "tlh" },
] as const;

export type PresetLanguageCode = (typeof PRESET_LANGUAGES)[number]["code"];

/** Attempts to match a natural language input to a preset language code. */
export function matchPresetLanguage(input: string): PresetLanguageCode | null {
  const normalized = input.trim().toLowerCase();
  for (const lang of PRESET_LANGUAGES) {
    if (lang.name.toLowerCase() === normalized || lang.code.toLowerCase() === normalized) {
      return lang.code;
    }
  }
  return null;
}
