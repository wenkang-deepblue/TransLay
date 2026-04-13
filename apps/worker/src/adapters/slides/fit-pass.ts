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
const DEFAULT_LAYOUT_HINT = {
  visual_role: "unknown",
  line_policy: "allow_wrap",
  scale_sync: "independent",
} as const;

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
  const layoutHint = resolveEffectiveLayoutHint(sourceNode);
  if (layoutHint.line_policy === "fixed_multiline") {
    return fitWithWrapAllowed(sourceNode, translatedNode);
  }

  if (layoutHint.line_policy === "prefer_single_line") {
    const singleLineFit = fitWithSingleLinePriority(sourceNode, translatedNode);
    if (singleLineFit) {
      return singleLineFit;
    }
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
): FitPassResult | null {
  if (translatedNode.paragraphs.length !== 1) {
    return null;
  }

  const profile = FIT_PROFILE_BY_ARCHETYPE[sourceNode.archetype];
  const archetypeMinScale = resolveMinScale(sourceNode, translatedNode, profile.minScale);
  const singleLineMinScale = resolveSingleLineMinScale(sourceNode);
  const minScale = sourceNode.archetype === "metric_card"
    ? Math.max(archetypeMinScale, singleLineMinScale)
    : Math.min(archetypeMinScale, singleLineMinScale);
  let scale = 1;

  while (estimateSingleLineOverflow(sourceNode, translatedNode, scale) > 1 && scale > minScale) {
    scale = Math.max(minScale, roundScale(scale - 0.04));
  }

  if (estimateSingleLineOverflow(sourceNode, translatedNode, scale) > 1) {
    return null;
  }

  return evaluateFitAtScale(sourceNode, translatedNode, scale);
}

function evaluateFitAtScale(
  sourceNode: SlideTextNode,
  translatedNode: TranslatedNode,
  scale: number
): FitPassResult {
  const profile = FIT_PROFILE_BY_ARCHETYPE[sourceNode.archetype];
  const layoutHint = resolveEffectiveLayoutHint(sourceNode);
  const overflowAtScale = estimateOverflow(sourceNode, translatedNode, scale);
  const honorsSingleLine =
    layoutHint.line_policy === "prefer_single_line" &&
    translatedNode.paragraphs.length === 1 &&
    estimateSingleLineOverflow(sourceNode, translatedNode, scale) <= 1;

  let applyTighterParagraphSpacing = false;
  let adjustedOverflow = overflowAtScale;

  if (overflowAtScale > 1) {
    applyTighterParagraphSpacing = true;
    adjustedOverflow = overflowAtScale * profile.spacingTightenFactor;
  } else if (scale < 0.92 && sourceNode.archetype === "bullet_list") {
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
    degradedSingleLine:
      layoutHint.line_policy === "prefer_single_line" && !honorsSingleLine,
    usedFallbackLayoutHint: layoutHint.usedFallbackLayoutHint,
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
    ...sourceNode.paragraphs.map((paragraph) => estimateWrapFriendlyLineWeight(paragraph.text))
  );
  const targetLongest = Math.max(
    1,
    ...translatedNode.paragraphs.map((paragraph) =>
      estimateWrapFriendlyLineWeight(paragraph.translated_text)
    )
  );

  const estimatedSourceLines = Math.max(
    sourceParagraphCount,
    sourceTotal / charsPerLineBudget
  );
  const estimatedTargetLines = Math.max(paragraphCount, targetTotal / charsPerLineBudget);
  const widthPressure = targetLongest / charsPerLineBudget;
  const heightPressure = estimatedTargetLines / lineBudget;
  const metricSegmentPressure = estimateMetricSegmentPressure(
    sourceNode,
    translatedNode,
    scale
  );
  const expansionPressure =
    0.55 * (targetLongest / sourceLongest) + 0.45 * (targetTotal / sourceTotal);
  const sourceFitBias = Math.max(0.85, Math.min(1.05, estimatedSourceLines / lineBudget));

  return (
    Math.max(widthPressure, heightPressure, metricSegmentPressure) *
      profile.pressureBias *
      sourceFitBias +
    Math.max(0, expansionPressure - 1) * 0.25
  );
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
  const widthPt = Math.max(1, sourceNode.box.width_emu / EMU_PER_PT);
  const baseFontSizePt = getMaxSourceFontSize(sourceNode);
  const effectiveFontSizePt = Math.max(MIN_FONT_SIZE_PT, baseFontSizePt * scale);
  const charsPerLineBudget = Math.max(
    1,
    widthPt / (effectiveFontSizePt * profile.widthFactor)
  );
  const sourceSingleLine = Math.max(1, measureTextWeight(sourceNode.full_text));
  const targetSingleLine = Math.max(1, measureTextWeight(translatedNode.translated_full_text));
  const metricSegmentPressure = estimateMetricSegmentPressure(
    sourceNode,
    translatedNode,
    scale
  );
  const noWrapPressure = targetSingleLine / charsPerLineBudget;
  const expansionPressure = targetSingleLine / sourceSingleLine;

  return (
    Math.max(noWrapPressure, metricSegmentPressure) * profile.pressureBias +
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

function estimateWrapFriendlyLineWeight(text: string): number {
  const normalized = text.replace(/\s+/g, " ").trim();
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

function resolveSingleLineMinScale(sourceNode: SlideTextNode): number {
  const layoutHint = resolveEffectiveLayoutHint(sourceNode);

  switch (layoutHint.visual_role) {
    case "title":
      return 0.58;
    case "subtitle":
      return 0.62;
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

function roundScale(value: number): number {
  return Math.round(value * 100) / 100;
}
