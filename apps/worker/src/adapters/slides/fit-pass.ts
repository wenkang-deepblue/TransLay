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
  readonly degradedSingleLine: boolean;
  readonly usedFallbackLayoutHint: boolean;
  readonly rejectedGroupSync: boolean;
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
const DENSE_SCRIPT_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const LONG_COMPOUND_TOKEN_RE = /[A-Za-z\u00c0-\u024f]{14,}/;

// Google Slides™ API does not expose per-shape text inset truth in the public
// presentation response. Treat editor defaults as the fallback rendering
// budget, but prefer node-level inset truth if a future extractor path can
// surface it.
const DEFAULT_SHAPE_INSET_H_EMU = 91440; // 0.1 inch per side (left + right)
const DEFAULT_SHAPE_INSET_V_EMU = 45720; // 0.05 inch per side (top + bottom)
const DEFAULT_LAYOUT_HINT = {
  visual_role: "unknown",
  line_policy: "allow_wrap",
  scale_sync: "independent",
} as const;
const PARAGRAPH_COMPACTION = {
  lineSpacingScale: 0.94,
  minLineSpacing: 80,
  spaceScale: 0.82,
} as const;

type FitCompactness = FitPassResult["compactness"];

function resolveTextInsetBudgetEmu(sourceNode: SlideTextNode) {
  if (sourceNode.element_type !== "shape") {
    return {
      left_emu: 0,
      right_emu: 0,
      top_emu: 0,
      bottom_emu: 0,
    };
  }

  return (
    sourceNode.text_insets_emu ?? {
      left_emu: DEFAULT_SHAPE_INSET_H_EMU,
      right_emu: DEFAULT_SHAPE_INSET_H_EMU,
      top_emu: DEFAULT_SHAPE_INSET_V_EMU,
      bottom_emu: DEFAULT_SHAPE_INSET_V_EMU,
    }
  );
}

function usableWidthPt(node: SlideTextNode): number {
  const inset = resolveTextInsetBudgetEmu(node);
  return Math.max(1, (node.box.width_emu - inset.left_emu - inset.right_emu) / EMU_PER_PT);
}

function usableHeightPt(node: SlideTextNode): number {
  const inset = resolveTextInsetBudgetEmu(node);
  return Math.max(1, (node.box.height_emu - inset.top_emu - inset.bottom_emu) / EMU_PER_PT);
}

interface OverflowAnalysis {
  readonly overflow: number;
  readonly widthPressure: number;
  readonly heightPressure: number;
  readonly sourceFullness: number;
}

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
    minScale: 0.78,
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
  const layoutHint = resolveEffectiveLayoutHint(sourceNode);
  if (layoutHint.line_policy === "fixed_multiline") {
    return fitWithWrapAllowed(sourceNode, translatedNode);
  }

  if (layoutHint.line_policy === "prefer_single_line") {
    return fitWithSingleLinePriority(sourceNode, translatedNode);
  }

  return fitWithWrapAllowed(sourceNode, translatedNode);
}

export function resolveSlideNodeFits(
  sourceNodes: readonly SlideTextNode[],
  translatedNodes: readonly TranslatedNode[]
): Map<string, FitPassResult> {
  const translatedByNodeId = new Map(
    translatedNodes.map((translatedNode) => [translatedNode.node_id, translatedNode] as const)
  );
  const fitsByNodeId = new Map<string, FitPassResult>();
  const syncGroups = new Map<
    string,
    Array<{ sourceNode: SlideTextNode; translatedNode: TranslatedNode }>
  >();

  for (const sourceNode of sourceNodes) {
    const translatedNode = translatedByNodeId.get(sourceNode.node_id);
    if (!translatedNode) {
      continue;
    }

    const fit = fitTranslatedNode(sourceNode, translatedNode);
    fitsByNodeId.set(sourceNode.node_id, fit);

    const layoutHint = resolveEffectiveLayoutHint(sourceNode);
    if (layoutHint.scale_sync !== "sync_with_group" || !layoutHint.cluster_id) {
      continue;
    }

    const groupMembers = syncGroups.get(layoutHint.cluster_id) ?? [];
    groupMembers.push({ sourceNode, translatedNode });
    syncGroups.set(layoutHint.cluster_id, groupMembers);
  }

  for (const groupMembers of syncGroups.values()) {
    if (groupMembers.length < 2) {
      continue;
    }

    if (!isGeometryCompatibleSyncGroup(groupMembers.map(({ sourceNode }) => sourceNode))) {
      for (const { sourceNode } of groupMembers) {
        const currentFit = fitsByNodeId.get(sourceNode.node_id);
        if (currentFit) {
          fitsByNodeId.set(sourceNode.node_id, {
            ...currentFit,
            rejectedGroupSync: true,
          });
        }
      }
      continue;
    }

    const sharedScale = Math.min(
      ...groupMembers.map(({ sourceNode }) => fitsByNodeId.get(sourceNode.node_id)?.scale ?? 1)
    );

    for (const { sourceNode, translatedNode } of groupMembers) {
      fitsByNodeId.set(
        sourceNode.node_id,
        evaluateFitAtScale(sourceNode, translatedNode, sharedScale)
      );
    }
  }

  return fitsByNodeId;
}

function fitWithWrapAllowed(
  sourceNode: SlideTextNode,
  translatedNode: TranslatedNode
): FitPassResult {
  const profile = FIT_PROFILE_BY_ARCHETYPE[sourceNode.archetype];
  const minScale = resolveMinScale(sourceNode, translatedNode, profile.minScale);
  let scale = 1;

  while (estimateOverflow(sourceNode, translatedNode, scale) > 1 && scale > minScale) {
    scale = Math.max(minScale, roundScale(scale - 0.04));
  }

  return evaluateFitAtScale(sourceNode, translatedNode, scale);
}

function fitWithSingleLinePriority(
  sourceNode: SlideTextNode,
  translatedNode: TranslatedNode
): FitPassResult {
  if (translatedNode.paragraphs.length !== 1) {
    return fitWithWrapAllowed(sourceNode, translatedNode);
  }

  const profile = FIT_PROFILE_BY_ARCHETYPE[sourceNode.archetype];
  const archetypeMinScale = resolveMinScale(sourceNode, translatedNode, profile.minScale);
  const singleLineMinScale = resolveSingleLineMinScale(sourceNode);
  const minScale = sourceNode.archetype === "metric_card"
    ? Math.max(0.84, archetypeMinScale, singleLineMinScale)
    : Math.min(archetypeMinScale, singleLineMinScale);
  let scale = 1;

  while (estimateSingleLineOverflow(sourceNode, translatedNode, scale) > 1 && scale > minScale) {
    scale = Math.max(minScale, roundScale(scale - 0.04));
  }

  if (estimateSingleLineOverflow(sourceNode, translatedNode, scale) > 1) {
    const constrainedFit = evaluateFitAtScale(sourceNode, translatedNode, minScale);
    if (resolveSingleLineEnforcement(sourceNode) === "strong") {
      return constrainedFit;
    }

    const wrapFit = fitWithWrapAllowed(sourceNode, translatedNode);
    return choosePreferredSoftSingleLineFit(constrainedFit, wrapFit);
  }

  return evaluateFitAtScale(sourceNode, translatedNode, scale);
}

function evaluateFitAtScale(
  sourceNode: SlideTextNode,
  translatedNode: TranslatedNode,
  scale: number,
  options?: {
    readonly rejectedGroupSync?: boolean;
  }
): FitPassResult {
  const layoutHint = resolveEffectiveLayoutHint(sourceNode);
  const normalAnalysis = analyzeOverflow(sourceNode, translatedNode, scale, "normal");
  const singleLineOverflow =
    layoutHint.line_policy === "prefer_single_line" && translatedNode.paragraphs.length === 1
      ? estimateSingleLineOverflow(sourceNode, translatedNode, scale)
      : null;
  const honorsSingleLine =
    layoutHint.line_policy === "prefer_single_line" &&
    translatedNode.paragraphs.length === 1 &&
    (singleLineOverflow ?? Number.POSITIVE_INFINITY) <= 1;

  let applyTighterParagraphSpacing = false;
  let adjustedOverflow = normalAnalysis.overflow;

  if (honorsSingleLine && singleLineOverflow !== null) {
    adjustedOverflow = Math.min(normalAnalysis.overflow, singleLineOverflow);
  } else if (normalAnalysis.overflow > 1) {
    applyTighterParagraphSpacing = true;
    adjustedOverflow = analyzeOverflow(sourceNode, translatedNode, scale, "tight").overflow;
  } else if (scale < 0.92 && sourceNode.archetype === "bullet_list") {
    applyTighterParagraphSpacing = true;
    adjustedOverflow = analyzeOverflow(sourceNode, translatedNode, scale, "tight").overflow;
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
    degradedSingleLine:
      layoutHint.line_policy === "prefer_single_line" && !honorsSingleLine,
    usedFallbackLayoutHint: layoutHint.usedFallbackLayoutHint,
    rejectedGroupSync: options?.rejectedGroupSync ?? false,
  };
}

export function estimateOverflow(
  sourceNode: SlideTextNode,
  translatedNode: TranslatedNode,
  scale = 1
): number {
  return analyzeOverflow(sourceNode, translatedNode, scale, "normal").overflow;
}

function analyzeOverflow(
  sourceNode: SlideTextNode,
  translatedNode: TranslatedNode,
  scale: number,
  compactness: FitCompactness
): OverflowAnalysis {
  const profile = FIT_PROFILE_BY_ARCHETYPE[sourceNode.archetype];
  const widthPt = usableWidthPt(sourceNode);
  const heightPt = usableHeightPt(sourceNode);
  const baseFontSizePt = getMaxSourceFontSize(sourceNode);
  const sourceTotal = Math.max(1, measureTextWeight(sourceNode.full_text));
  const targetTotal = Math.max(1, measureTextWeight(translatedNode.translated_full_text));
  const sourceLongest = Math.max(1, estimateMaxWrappedLineWeight(sourceNode.paragraphs.map((p) => p.text)));
  const targetLongest = Math.max(
    1,
    estimateMaxWrappedLineWeight(translatedNode.paragraphs.map((p) => p.translated_text))
  );
  const horizontalBudget = Math.max(
    1,
    widthPt / (Math.max(MIN_FONT_SIZE_PT, baseFontSizePt * scale) * profile.widthFactor)
  );
  const widthPressure = targetLongest / horizontalBudget;
  const sourceOccupancyPt = estimateNodeVerticalOccupancy(
    sourceNode,
    sourceNode.paragraphs.map((paragraph) => paragraph.text),
    scale,
    compactness
  );
  const targetOccupancyPt = estimateNodeVerticalOccupancy(
    sourceNode,
    resolveTargetParagraphTexts(sourceNode, translatedNode),
    scale,
    compactness
  );
  const sourceFullness = sourceOccupancyPt / heightPt;
  const safetyMarginPt = estimateDynamicSafetyMarginPt(
    sourceNode,
    translatedNode,
    sourceOccupancyPt,
    targetOccupancyPt,
    heightPt,
    scale,
    compactness
  );
  const heightPressure = (targetOccupancyPt + safetyMarginPt) / heightPt;
  const metricSegmentPressure = estimateMetricSegmentPressure(
    sourceNode,
    translatedNode,
    scale
  );
  const expansionPressure =
    0.55 * (targetLongest / sourceLongest) + 0.45 * (targetTotal / sourceTotal);
  const sourceFitBias = Math.max(0.9, Math.min(1.06, 0.92 + sourceFullness * 0.08));
  const rawExpansionPenalty = Math.max(0, expansionPressure - 1) * 0.18;
  const expansionDamping = Math.min(1, Math.pow(widthPressure, 1.5));

  return {
    overflow:
      Math.max(widthPressure, heightPressure, metricSegmentPressure) *
      profile.pressureBias *
      sourceFitBias +
      rawExpansionPenalty * expansionDamping,
    widthPressure,
    heightPressure,
    sourceFullness,
  };
}

function estimateSingleLineOverflow(
  sourceNode: SlideTextNode,
  translatedNode: TranslatedNode,
  scale = 1
): number {
  if (translatedNode.paragraphs.length !== 1) {
    return Number.POSITIVE_INFINITY;
  }

  const profile = FIT_PROFILE_BY_ARCHETYPE[sourceNode.archetype];
  const widthPt = usableWidthPt(sourceNode);
  const heightPt = usableHeightPt(sourceNode);
  const baseFontSizePt = getMaxSourceFontSize(sourceNode);
  const effectiveFontSizePt = Math.max(MIN_FONT_SIZE_PT, baseFontSizePt * scale);
  const widthSafetyFactor = resolveSingleLineWidthSafetyFactor(sourceNode, translatedNode);
  const charsPerLineBudget = Math.max(
    1,
    (widthPt * widthSafetyFactor) / (effectiveFontSizePt * profile.widthFactor)
  );
  const sourceSingleLine = Math.max(1, measureTextWeight(sourceNode.full_text));
  const targetSingleLine = Math.max(1, measureTextWeight(translatedNode.translated_full_text));
  const sourceOccupancyPt = estimateNodeVerticalOccupancy(
    sourceNode,
    sourceNode.paragraphs.map((paragraph) => paragraph.text),
    scale,
    "normal"
  );
  const targetOccupancyPt = estimateNodeVerticalOccupancy(
    sourceNode,
    [translatedNode.translated_full_text],
    scale,
    "normal"
  );
  const metricSegmentPressure = estimateMetricSegmentPressure(
    sourceNode,
    translatedNode,
    scale
  );
  const noWrapPressure = targetSingleLine / charsPerLineBudget;
  const heightPressure = targetOccupancyPt / heightPt;
  const expansionPressure = targetSingleLine / sourceSingleLine;
  const sourceFullness = sourceOccupancyPt / heightPt;
  const rawExpansionPenalty = Math.max(0, expansionPressure - 1) * 0.18;
  const expansionDamping = Math.min(1, Math.pow(noWrapPressure, 1.5));

  return (
    Math.max(noWrapPressure, heightPressure, metricSegmentPressure) *
      profile.pressureBias *
      Math.max(0.9, Math.min(1.12, 0.94 + sourceFullness * 0.12)) +
    rawExpansionPenalty * expansionDamping
  );
}

function resolveSingleLineWidthSafetyFactor(
  sourceNode: SlideTextNode,
  translatedNode: TranslatedNode
): number {
  const layoutHint = resolveEffectiveLayoutHint(sourceNode);
  let factor = 0.98;
  const sourceSingleLine = Math.max(1, measureTextWeight(sourceNode.full_text));
  const targetSingleLine = Math.max(1, measureTextWeight(translatedNode.translated_full_text));
  const expansionRatio = targetSingleLine / sourceSingleLine;
  const longestTokenWeight = estimateLongestTokenWeight(translatedNode.translated_full_text);

  if (layoutHint.visual_role === "title" || layoutHint.visual_role === "subtitle") {
    factor -= 0.01;
  }

  if (expansionRatio > 1.75) {
    factor -= 0.005;
  }

  if (longestTokenWeight >= 14) {
    factor -= 0.005;
  }

  return Math.max(0.96, factor);
}

function resolveSingleLineEnforcement(sourceNode: SlideTextNode): "strong" | "soft" {
  const layoutHint = resolveEffectiveLayoutHint(sourceNode);
  if (layoutHint.visual_role === "title" || layoutHint.visual_role === "subtitle") {
    return "strong";
  }

  return sourceLooksSingleLineAtSourceSize(sourceNode) ? "strong" : "soft";
}

function sourceLooksSingleLineAtSourceSize(sourceNode: SlideTextNode): boolean {
  if (sourceNode.paragraphs.length !== 1) {
    return false;
  }

  const text = sourceNode.full_text.trim();
  if (!text) {
    return false;
  }

  const fontSize = getMaxSourceFontSize(sourceNode);
  if (fontSize <= 0) {
    return false;
  }

  const widthPt = usableWidthPt(sourceNode);
  const profile = FIT_PROFILE_BY_ARCHETYPE[sourceNode.archetype];
  const charsPerLineBudget = Math.max(1, widthPt / (fontSize * profile.widthFactor));
  return measureTextWeight(text) <= charsPerLineBudget;
}

function choosePreferredSoftSingleLineFit(
  constrainedFit: FitPassResult,
  wrapFit: FitPassResult
): FitPassResult {
  if (wrapFit.scale >= constrainedFit.scale + 0.06 && wrapFit.risk !== "high") {
    return wrapFit;
  }

  return constrainedFit;
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
    nextStyle.lineSpacing = Math.max(
      PARAGRAPH_COMPACTION.minLineSpacing,
      nextStyle.lineSpacing * PARAGRAPH_COMPACTION.lineSpacingScale
    );
  }

  if (nextStyle.spaceAbove?.magnitude) {
    nextStyle.spaceAbove = {
      ...nextStyle.spaceAbove,
      magnitude: Math.max(0, nextStyle.spaceAbove.magnitude * PARAGRAPH_COMPACTION.spaceScale),
    };
  }

  if (nextStyle.spaceBelow?.magnitude) {
    nextStyle.spaceBelow = {
      ...nextStyle.spaceBelow,
      magnitude: Math.max(0, nextStyle.spaceBelow.magnitude * PARAGRAPH_COMPACTION.spaceScale),
    };
  }

  return nextStyle;
}

function resolveTargetParagraphTexts(
  sourceNode: SlideTextNode,
  translatedNode: TranslatedNode
): string[] {
  const translatedByParagraphId = new Map(
    translatedNode.paragraphs.map((paragraph) => [paragraph.paragraph_id, paragraph.translated_text] as const)
  );

  return sourceNode.paragraphs.map((paragraph, index) => {
    const translatedText = translatedByParagraphId.get(paragraph.paragraph_id);
    if (typeof translatedText === "string") {
      return translatedText;
    }
    return translatedNode.paragraphs[index]?.translated_text ?? "";
  });
}

function estimateNodeVerticalOccupancy(
  sourceNode: SlideTextNode,
  paragraphTexts: readonly string[],
  scale: number,
  compactness: FitCompactness
): number {
  const widthPt = usableWidthPt(sourceNode);
  const profile = FIT_PROFILE_BY_ARCHETYPE[sourceNode.archetype];
  const baseFontSizePt = getMaxSourceFontSize(sourceNode);
  const roundUpWrappedLines = paragraphTexts.length > 1;
  let total = 0;

  for (let index = 0; index < paragraphTexts.length; index += 1) {
    const sourceParagraph = sourceNode.paragraphs[index] ?? sourceNode.paragraphs[sourceNode.paragraphs.length - 1];
    const paragraphText = paragraphTexts[index] ?? "";
    const paragraphFontSizePt = Math.max(
      MIN_FONT_SIZE_PT,
      resolveParagraphFontSize(sourceParagraph, baseFontSizePt) * scale
    );
    const charsPerLineBudget = Math.max(
      1,
      widthPt / (paragraphFontSizePt * profile.widthFactor)
    );
    const lineCount = estimateParagraphWrappedLines(
      paragraphText,
      charsPerLineBudget,
      roundUpWrappedLines
    );

    total +=
      lineCount *
        resolveParagraphLineHeightMultiplier(sourceParagraph, profile.lineHeightFactor, compactness) *
        paragraphFontSizePt +
      resolveParagraphSpacingPt(sourceParagraph.paragraph_style.spaceAbove, compactness) +
      resolveParagraphSpacingPt(sourceParagraph.paragraph_style.spaceBelow, compactness);
  }

  return total;
}

function estimateDynamicSafetyMarginPt(
  sourceNode: SlideTextNode,
  translatedNode: TranslatedNode,
  sourceOccupancyPt: number,
  targetOccupancyPt: number,
  heightPt: number,
  scale: number,
  compactness: FitCompactness
): number {
  const sourceTotal = Math.max(1, measureTextWeight(sourceNode.full_text));
  const targetTotal = Math.max(1, measureTextWeight(translatedNode.translated_full_text));
  const paragraphCount = Math.max(1, translatedNode.paragraphs.length);
  const sourceFullness = sourceOccupancyPt / heightPt;
  const expansionRatio = targetTotal / sourceTotal;
  const baseFontSizePt = Math.max(MIN_FONT_SIZE_PT, getMaxSourceFontSize(sourceNode) * scale);
  const avgSpacingPt =
    sourceNode.paragraphs.reduce((sum, paragraph) => {
      return (
        sum +
        resolveParagraphSpacingPt(paragraph.paragraph_style.spaceAbove, compactness) +
        resolveParagraphSpacingPt(paragraph.paragraph_style.spaceBelow, compactness)
      );
    }, 0) / Math.max(1, sourceNode.paragraphs.length);

  if (paragraphCount === 1) {
    // Keep single-paragraph wrap evaluation only slightly conservative.
    // A small fixed height reserve is enough to avoid optimistic edge fits
    // without forcing narrow labels back into over-shrunk single-line output.
    return heightPt * 0.01;
  }

  let extraLines = 0;
  if (paragraphCount >= 3) {
    extraLines += Math.min(0.6, 0.08 * (paragraphCount - 2));
  }
  if (sourceFullness > 0.82) {
    extraLines += Math.min(0.25, (sourceFullness - 0.82) * 0.65);
  }
  if (expansionRatio > 1.12) {
    extraLines += Math.min(0.25, (expansionRatio - 1.12) * 0.35);
  }
  if (LONG_COMPOUND_TOKEN_RE.test(translatedNode.translated_full_text)) {
    extraLines += 0.1;
  }
  if (avgSpacingPt > baseFontSizePt * 0.2) {
    extraLines += 0.08;
  }

  const occupancyDelta = Math.max(0, targetOccupancyPt - sourceOccupancyPt);
  return extraLines * baseFontSizePt * 0.8 + occupancyDelta * 0.03;
}

function resolveParagraphFontSize(
  paragraph: SlideTextNode["paragraphs"][number] | undefined,
  fallbackFontSizePt: number
): number {
  if (!paragraph) {
    return fallbackFontSizePt;
  }

  const weightedRuns = paragraph.runs
    .map((run) => ({
      fontSize: run.text_style.fontSize?.magnitude,
      weight: Math.max(1, run.text.replace(/\s+/g, "").length),
    }))
    .filter(
      (entry): entry is { fontSize: number; weight: number } =>
        typeof entry.fontSize === "number" && entry.fontSize > 0
    );

  if (weightedRuns.length > 0) {
    const weightedSum = weightedRuns.reduce(
      (sum, entry) => sum + entry.fontSize * entry.weight,
      0
    );
    const totalWeight = weightedRuns.reduce((sum, entry) => sum + entry.weight, 0);
    return weightedSum / Math.max(1, totalWeight);
  }

  return fallbackFontSizePt;
}

function resolveParagraphLineHeightMultiplier(
  paragraph: SlideTextNode["paragraphs"][number] | undefined,
  defaultLineHeightFactor: number,
  compactness: FitCompactness
): number {
  const rawLineSpacing = paragraph?.paragraph_style.lineSpacing;
  let lineSpacingPercent =
    typeof rawLineSpacing === "number" && Number.isFinite(rawLineSpacing) && rawLineSpacing > 0
      ? rawLineSpacing
      : defaultLineHeightFactor * 100;

  if (compactness === "tight") {
    lineSpacingPercent = Math.max(
      PARAGRAPH_COMPACTION.minLineSpacing,
      lineSpacingPercent * PARAGRAPH_COMPACTION.lineSpacingScale
    );
  }

  return Math.max(0.8, Math.min(2.2, lineSpacingPercent / 100));
}

function resolveParagraphSpacingPt(
  dimension: SlideParagraphStyleSnapshot["spaceAbove"] | SlideParagraphStyleSnapshot["spaceBelow"],
  compactness: FitCompactness
): number {
  const magnitude = dimension?.magnitude;
  if (typeof magnitude !== "number" || !Number.isFinite(magnitude) || magnitude <= 0) {
    return 0;
  }

  const scaledMagnitude =
    compactness === "tight" ? magnitude * PARAGRAPH_COMPACTION.spaceScale : magnitude;
  return dimension?.unit === "EMU" ? scaledMagnitude / EMU_PER_PT : scaledMagnitude;
}

function estimateParagraphWrappedLines(
  text: string,
  charsPerLineBudget: number,
  roundUpWrappedLines: boolean
): number {
  const weight = measureWrapAwareTextWeight(text);
  if (weight <= 0) {
    return 1;
  }

  const rawLineCount = Math.max(1, weight / charsPerLineBudget);
  return roundUpWrappedLines ? Math.max(1, Math.ceil(rawLineCount)) : rawLineCount;
}

function estimateMaxWrappedLineWeight(paragraphTexts: readonly string[]): number {
  if (paragraphTexts.length === 0) {
    return 1;
  }

  return Math.max(
    1,
    ...paragraphTexts.map((paragraphText) => estimateWrapFriendlyLineWeight(paragraphText))
  );
}

function getMaxSourceFontSize(sourceNode: SlideTextNode): number {
  if (
    typeof sourceNode.visible_style?.max_font_size_pt === "number" &&
    sourceNode.visible_style.max_font_size_pt > 0
  ) {
    return sourceNode.visible_style.max_font_size_pt;
  }

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

function resolveMinScale(
  sourceNode: SlideTextNode,
  translatedNode: TranslatedNode,
  defaultMinScale: number
): number {
  if (sourceNode.archetype !== "metric_card") {
    return defaultMinScale;
  }

  if (!DENSE_SCRIPT_RE.test(translatedNode.translated_full_text)) {
    return defaultMinScale;
  }

  const metricExpansionRatio = getMaxMetricSegmentExpansionRatio(sourceNode, translatedNode);
  if (metricExpansionRatio >= 1.8) {
    return Math.min(defaultMinScale, 0.64);
  }
  if (metricExpansionRatio >= 1.4) {
    return Math.min(defaultMinScale, 0.72);
  }

  return defaultMinScale;
}

function estimateMetricSegmentPressure(
  sourceNode: SlideTextNode,
  translatedNode: TranslatedNode,
  scale: number
): number {
  if (sourceNode.archetype !== "metric_card") {
    return 0;
  }

  const translatedSegmentById = new Map(
    translatedNode.segments.map((segment) => [segment.segment_id, segment] as const)
  );
  let maxPressure = 0;

  for (const paragraph of sourceNode.paragraphs) {
    for (const run of paragraph.runs) {
      if (!isMetricRunStyleRole(run.style_role)) {
        continue;
      }

      const translatedSegment = translatedSegmentById.get(run.run_id);
      if (!translatedSegment) {
        continue;
      }

      const sourceText = run.text.trim();
      const targetText = translatedSegment.translated_text.trim();
      if (!sourceText || !targetText) {
        continue;
      }

      const sourceWeight = Math.max(1, measureTextWeight(sourceText));
      const targetWeight = Math.max(1, measureTextWeight(targetText));
      const roleFactor = metricRolePressureFactor(run.style_role);
      const denseScriptFactor = DENSE_SCRIPT_RE.test(targetText) ? 1.05 : 1;
      const pressure = (targetWeight / sourceWeight) * scale * roleFactor * denseScriptFactor;

      if (pressure > maxPressure) {
        maxPressure = pressure;
      }
    }
  }

  return maxPressure;
}

function getMaxMetricSegmentExpansionRatio(
  sourceNode: SlideTextNode,
  translatedNode: TranslatedNode
): number {
  if (sourceNode.archetype !== "metric_card") {
    return 1;
  }

  const translatedSegmentById = new Map(
    translatedNode.segments.map((segment) => [segment.segment_id, segment] as const)
  );
  let maxRatio = 1;

  for (const paragraph of sourceNode.paragraphs) {
    for (const run of paragraph.runs) {
      if (!isMetricRunStyleRole(run.style_role)) {
        continue;
      }

      const translatedSegment = translatedSegmentById.get(run.run_id);
      if (!translatedSegment) {
        continue;
      }

      const sourceText = run.text.trim();
      const targetText = translatedSegment.translated_text.trim();
      if (!sourceText || !targetText) {
        continue;
      }

      const sourceWeight = Math.max(1, measureTextWeight(sourceText));
      const targetWeight = Math.max(1, measureTextWeight(targetText));
      maxRatio = Math.max(maxRatio, targetWeight / sourceWeight);
    }
  }

  return maxRatio;
}

function isMetricRunStyleRole(styleRole: SlideTextNode["paragraphs"][number]["runs"][number]["style_role"]): boolean {
  return (
    styleRole === "metric_value" ||
    styleRole === "metric_unit" ||
    styleRole === "prefix" ||
    styleRole === "suffix"
  );
}

function metricRolePressureFactor(
  styleRole: SlideTextNode["paragraphs"][number]["runs"][number]["style_role"]
): number {
  switch (styleRole) {
    case "metric_value":
      return 0.7;
    case "metric_unit":
    case "suffix":
      return 0.58;
    case "prefix":
      return 0.5;
    default:
      return 0.5;
  }
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

function normalizeWrapBreakText(text: string): string {
  return text.replace(/[-‐‑‒–—]+/g, " ");
}

function measureWrapAwareTextWeight(text: string): number {
  return measureTextWeight(normalizeWrapBreakText(text));
}

function estimateWrapFriendlyLineWeight(text: string): number {
  const normalized = normalizeWrapBreakText(text).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return 0;
  }

  const totalWeight = measureTextWeight(normalized);
  const tokens = normalized.split(" ");
  if (tokens.length <= 1) {
    return totalWeight;
  }

  const longestTokenWeight = Math.max(
    ...tokens.map((token) => measureTextWeight(token))
  );
  const lineCountHint = Math.min(3, Math.max(2, Math.ceil(Math.sqrt(tokens.length))));

  return Math.max(longestTokenWeight, totalWeight / lineCountHint);
}

function estimateLongestTokenWeight(text: string): number {
  const normalized = normalizeWrapBreakText(text).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return 0;
  }

  return Math.max(...normalized.split(" ").map((token) => measureTextWeight(token)));
}

function resolveSingleLineMinScale(sourceNode: SlideTextNode): number {
  const layoutHint = resolveEffectiveLayoutHint(sourceNode);

  switch (layoutHint.visual_role) {
    case "title":
      return 0.58;
    case "subtitle":
      return 0.62;
    case "caption":
    case "section_label":
    case "agenda_item":
    case "step_label":
    case "badge":
      return 0.64;
    default:
      return sourceNode.archetype === "plain_text" ? 0.68 : 0.72;
  }
}

function resolveEffectiveLayoutHint(sourceNode: SlideTextNode): {
  visual_role: NonNullable<SlideTextNode["layout_hint"]>["visual_role"];
  cluster_id: string;
  line_policy: NonNullable<SlideTextNode["layout_hint"]>["line_policy"];
  scale_sync: NonNullable<SlideTextNode["layout_hint"]>["scale_sync"];
  usedFallbackLayoutHint: boolean;
} {
  const layoutHint = sourceNode.layout_hint;

  return {
    visual_role: layoutHint?.visual_role ?? DEFAULT_LAYOUT_HINT.visual_role,
    cluster_id: layoutHint?.cluster_id ?? sourceNode.node_id,
    line_policy: layoutHint?.line_policy ?? DEFAULT_LAYOUT_HINT.line_policy,
    scale_sync: layoutHint?.scale_sync ?? DEFAULT_LAYOUT_HINT.scale_sync,
    usedFallbackLayoutHint: usesFallbackLayoutHint(sourceNode),
  };
}

function usesFallbackLayoutHint(sourceNode: SlideTextNode): boolean {
  return sourceNode.layout_hint_source === "fallback" || !sourceNode.layout_hint;
}

function isGeometryCompatibleSyncGroup(sourceNodes: readonly SlideTextNode[]): boolean {
  if (sourceNodes.length < 2) {
    return true;
  }

  const widths = sourceNodes.map((node) => Math.max(1, node.box.width_emu));
  const heights = sourceNodes.map((node) => Math.max(1, node.box.height_emu));
  const fontSizes = sourceNodes.map((node) => Math.max(MIN_FONT_SIZE_PT, getMaxSourceFontSize(node)));
  const visualRoles = new Set(
    sourceNodes.map((node) => resolveEffectiveLayoutHint(node).visual_role)
  );
  const widthRatio = Math.max(...widths) / Math.min(...widths);
  const heightRatio = Math.max(...heights) / Math.min(...heights);
  const fontRatio = Math.max(...fontSizes) / Math.min(...fontSizes);

  return visualRoles.size <= 2 && widthRatio <= 1.35 && heightRatio <= 1.45 && fontRatio <= 1.35;
}

function roundScale(value: number): number {
  return Math.round(value * 100) / 100;
}
