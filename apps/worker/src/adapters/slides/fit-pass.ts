import type { TranslatedNode } from "@translay/shared-contracts";
import type {
  SlideParagraphStyleSnapshot,
  SlideTextNode,
  SlideTextStyleSnapshot,
} from "./types";

export type FitPassRisk = "low" | "medium" | "high";

export interface FitPassResult {
  readonly scale: number;
  readonly risk: FitPassRisk;
  readonly applyTighterParagraphSpacing: boolean;
  readonly compactness: "normal" | "tight";
  readonly avoidExpansion: boolean;
}

interface FitProfile {
  readonly widthFactor: number;
  readonly lineHeightFactor: number;
  readonly pressureBias: number;
  readonly minScale: number;
  readonly spacingTightenFactor: number;
}

const EMU_PER_PT = 12700;
const MIN_FONT_SIZE_PT = 6;

const FIT_PROFILE_BY_ARCHETYPE: Record<SlideTextNode["archetype"], FitProfile> = {
  plain_text: {
    widthFactor: 0.54,
    lineHeightFactor: 1.35,
    pressureBias: 1.0,
    minScale: 0.72,
    spacingTightenFactor: 0.95,
  },
  bullet_list: {
    widthFactor: 0.58,
    lineHeightFactor: 1.4,
    pressureBias: 0.97,
    minScale: 0.76,
    spacingTightenFactor: 0.93,
  },
  metric_card: {
    widthFactor: 0.78,
    lineHeightFactor: 1.12,
    pressureBias: 1.18,
    minScale: 0.84,
    spacingTightenFactor: 0.95,
  },
  mixed_emphasis: {
    widthFactor: 0.56,
    lineHeightFactor: 1.34,
    pressureBias: 1.04,
    minScale: 0.76,
    spacingTightenFactor: 0.95,
  },
  table_cell: {
    widthFactor: 0.62,
    lineHeightFactor: 1.28,
    pressureBias: 1.22,
    minScale: 0.82,
    spacingTightenFactor: 0.92,
  },
  speaker_notes: {
    widthFactor: 0.5,
    lineHeightFactor: 1.34,
    pressureBias: 0.88,
    minScale: 0.9,
    spacingTightenFactor: 0.96,
  },
};

export function fitTranslatedNode(
  sourceNode: SlideTextNode,
  translatedNode: TranslatedNode
): FitPassResult {
  const profile = FIT_PROFILE_BY_ARCHETYPE[sourceNode.archetype];
  let scale = 1;

  while (estimateOverflow(sourceNode, translatedNode, scale) > 1 && scale > profile.minScale) {
    scale = roundScale(scale - 0.04);
  }

  const overflowAtScale = estimateOverflow(sourceNode, translatedNode, scale);
  let applyTighterParagraphSpacing = false;
  let adjustedOverflow = overflowAtScale;

  if (overflowAtScale > 1) {
    applyTighterParagraphSpacing = true;
    adjustedOverflow = overflowAtScale * profile.spacingTightenFactor;
  } else if (scale < 0.92) {
    applyTighterParagraphSpacing = true;
    adjustedOverflow = overflowAtScale * profile.spacingTightenFactor;
  }

  let risk: FitPassRisk = "low";
  if (adjustedOverflow > 1) {
    risk = "high";
  } else if (scale < 1 || applyTighterParagraphSpacing) {
    risk = "medium";
  }

  return {
    scale,
    risk,
    applyTighterParagraphSpacing,
    compactness: applyTighterParagraphSpacing ? "tight" : "normal",
    avoidExpansion:
      translatedNode.translated_full_text.length > sourceNode.full_text.length || risk !== "low",
  };
}

export function estimateOverflow(
  sourceNode: SlideTextNode,
  translatedNode: TranslatedNode,
  scale = 1
): number {
  const profile = FIT_PROFILE_BY_ARCHETYPE[sourceNode.archetype];
  const widthPt = Math.max(1, sourceNode.box.width_emu / EMU_PER_PT);
  const heightPt = Math.max(1, sourceNode.box.height_emu / EMU_PER_PT);
  const paragraphCount = Math.max(1, translatedNode.paragraphs.length);
  const sourceParagraphCount = Math.max(1, sourceNode.paragraphs.length);
  const baseFontSizePt = getMaxSourceFontSize(sourceNode);
  const effectiveFontSizePt = Math.max(MIN_FONT_SIZE_PT, baseFontSizePt * scale);
  const charsPerLineBudget = Math.max(
    1,
    widthPt / (effectiveFontSizePt * profile.widthFactor)
  );
  const lineBudget = Math.max(
    paragraphCount,
    heightPt / (effectiveFontSizePt * profile.lineHeightFactor)
  );

  const sourceTotal = Math.max(1, measureTextWeight(sourceNode.full_text));
  const targetTotal = Math.max(1, measureTextWeight(translatedNode.translated_full_text));
  const sourceLongest = Math.max(
    1,
    ...sourceNode.paragraphs.map((paragraph) => measureTextWeight(paragraph.text))
  );
  const targetLongest = Math.max(
    1,
    ...translatedNode.paragraphs.map((paragraph) =>
      measureTextWeight(paragraph.translated_text)
    )
  );

  const estimatedSourceLines = Math.max(
    sourceParagraphCount,
    sourceTotal / charsPerLineBudget
  );
  const estimatedTargetLines = Math.max(paragraphCount, targetTotal / charsPerLineBudget);
  const widthPressure = targetLongest / charsPerLineBudget;
  const heightPressure = estimatedTargetLines / lineBudget;
  const expansionPressure =
    0.55 * (targetLongest / sourceLongest) + 0.45 * (targetTotal / sourceTotal);
  const sourceFitBias = Math.max(0.85, Math.min(1.05, estimatedSourceLines / lineBudget));

  return (
    Math.max(widthPressure, heightPressure) * profile.pressureBias * sourceFitBias +
    Math.max(0, expansionPressure - 1) * 0.25
  );
}

export function applyFitToTextStyle(
  textStyle: SlideTextStyleSnapshot,
  fit: FitPassResult,
  fallbackFontSizePt?: number
): SlideTextStyleSnapshot {
  const nextStyle = structuredClone(textStyle);

  if (nextStyle.fontSize?.magnitude) {
    nextStyle.fontSize = {
      ...nextStyle.fontSize,
      magnitude: Math.max(MIN_FONT_SIZE_PT, nextStyle.fontSize.magnitude * fit.scale),
    };
  } else if (fit.scale < 1 && typeof fallbackFontSizePt === "number") {
    nextStyle.fontSize = {
      magnitude: Math.max(MIN_FONT_SIZE_PT, fallbackFontSizePt * fit.scale),
      unit: "PT",
    };
  }

  return nextStyle;
}

export function applyFitToParagraphStyle(
  paragraphStyle: SlideParagraphStyleSnapshot,
  fit: FitPassResult
): SlideParagraphStyleSnapshot {
  const nextStyle = structuredClone(paragraphStyle);

  if (!fit.applyTighterParagraphSpacing) {
    return nextStyle;
  }

  if (typeof nextStyle.lineSpacing === "number") {
    nextStyle.lineSpacing = Math.max(80, nextStyle.lineSpacing * 0.94);
  }

  if (nextStyle.spaceAbove?.magnitude) {
    nextStyle.spaceAbove = {
      ...nextStyle.spaceAbove,
      magnitude: Math.max(0, nextStyle.spaceAbove.magnitude * 0.82),
    };
  }

  if (nextStyle.spaceBelow?.magnitude) {
    nextStyle.spaceBelow = {
      ...nextStyle.spaceBelow,
      magnitude: Math.max(0, nextStyle.spaceBelow.magnitude * 0.82),
    };
  }

  return nextStyle;
}

function getMaxSourceFontSize(sourceNode: SlideTextNode): number {
  // Fallback to 16pt when all runs inherit theme sizing and expose no explicit fontSize.
  // This keeps overflow estimation anchored near common Slides body defaults (roughly 14-18pt)
  // while avoiding a zero/undefined baseline that would make fit pass unusable.
  let maxFontSize = 16;

  for (const paragraph of sourceNode.paragraphs) {
    for (const run of paragraph.runs) {
      const magnitude = run.text_style.fontSize?.magnitude;
      if (typeof magnitude === "number" && magnitude > maxFontSize) {
        maxFontSize = magnitude;
      }
    }
  }

  return maxFontSize;
}

export function measureTextWeight(text: string): number {
  let total = 0;

  for (const character of text) {
    if (character === "\n" || character === "\t") {
      continue;
    }

    if (/\s/.test(character)) {
      total += 0.35;
      continue;
    }

    if (/[A-Z]/.test(character)) {
      total += 1.08;
      continue;
    }

    if (/[a-z]/.test(character)) {
      total += 1;
      continue;
    }

    if (/[0-9]/.test(character)) {
      total += 0.92;
      continue;
    }

    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(character)) {
      total += 1.15;
      continue;
    }

    total += 0.65;
  }

  return total;
}

function roundScale(value: number): number {
  return Math.round(value * 100) / 100;
}
