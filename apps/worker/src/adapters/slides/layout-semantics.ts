import type { DeckStoryboard, StoryboardFrame } from "./storyboard";
import type {
  SlideExtractionResult,
  SlideLayoutLinePolicy,
  SlideLayoutScaleSync,
  SlideLayoutSemanticHint,
  SlideLayoutVisualRole,
  SlideTextNode,
} from "./types";
import {
  SLIDE_LAYOUT_LINE_POLICIES,
  SLIDE_LAYOUT_SCALE_SYNC_OPTIONS,
  SLIDE_LAYOUT_VISUAL_ROLES,
} from "./types";

const DEFAULT_VISUAL_ROLE: SlideLayoutVisualRole = "unknown";
const DEFAULT_LINE_POLICY: SlideLayoutLinePolicy = "allow_wrap";
const DEFAULT_SCALE_SYNC: SlideLayoutScaleSync = "independent";
const MAX_TEXT_EXCERPT_LENGTH = 160;
const MIN_LAYOUT_HINT_CONFIDENCE = 0.6;

export interface SlideLayoutSemanticNodeInput {
  readonly node_id: string;
  readonly element_type: SlideTextNode["element_type"];
  readonly archetype: SlideTextNode["archetype"];
  readonly text_excerpt: string;
  readonly paragraph_count: number;
  readonly alignment: string;
  readonly min_font_size_pt?: number;
  readonly max_font_size_pt?: number;
  readonly font_family?: string;
  readonly fill_color_hex?: string;
  readonly outline_color_hex?: string;
  readonly box: SlideTextNode["box"];
}

export interface SlideLayoutSemanticSlideInput {
  readonly slide_index: number;
  readonly slide_object_id: string;
  readonly thumbnail: StoryboardFrame;
  readonly nodes: readonly SlideLayoutSemanticNodeInput[];
}

export type SlideLayoutSemanticAnalyzer = (
  input: SlideLayoutSemanticSlideInput
) => Promise<unknown>;

export function buildLayoutSemanticInputs(
  slides: readonly SlideExtractionResult[],
  storyboard: DeckStoryboard
): SlideLayoutSemanticSlideInput[] {
  const frameBySlideIndex = new Map(
    storyboard.frames.map((frame) => [frame.slide_index, frame])
  );

  return slides.flatMap((slide) => {
    const thumbnail = frameBySlideIndex.get(slide.slide_index);
    const visibleNodes = slide.nodes.filter((node) => node.element_type !== "speaker_notes");

    if (!thumbnail || visibleNodes.length === 0) {
      return [];
    }

    return [
      {
        slide_index: slide.slide_index,
        slide_object_id: slide.slide_object_id,
        thumbnail,
        nodes: visibleNodes.map(projectNodeToLayoutSemanticInput),
      },
    ];
  });
}

export function validateSlideLayoutHints(
  slideInput: SlideLayoutSemanticSlideInput,
  rawHints: unknown
): SlideLayoutSemanticHint[] {
  if (!Array.isArray(rawHints)) {
    return [];
  }

  const knownNodeIds = new Set(slideInput.nodes.map((node) => node.node_id));
  const validatedByNodeId = new Map<string, SlideLayoutSemanticHint>();

  for (const candidate of rawHints) {
    if (!isRecord(candidate)) {
      continue;
    }

    const nodeId = typeof candidate.node_id === "string" ? candidate.node_id : "";
    if (!knownNodeIds.has(nodeId)) {
      continue;
    }

    const normalized: SlideLayoutSemanticHint = {
      node_id: nodeId,
      visual_role: normalizeVisualRole(candidate.visual_role),
      cluster_id: normalizeClusterId(candidate.cluster_id, nodeId),
      line_policy: normalizeLinePolicy(candidate.line_policy),
      scale_sync: normalizeScaleSync(candidate.scale_sync),
      confidence: normalizeConfidence(candidate.confidence),
    };

    if (normalized.confidence < MIN_LAYOUT_HINT_CONFIDENCE) {
      continue;
    }

    const existing = validatedByNodeId.get(nodeId);
    if (!existing || normalized.confidence >= existing.confidence) {
      validatedByNodeId.set(nodeId, normalized);
    }
  }

  return slideInput.nodes
    .map((node) => validatedByNodeId.get(node.node_id))
    .filter((hint): hint is SlideLayoutSemanticHint => Boolean(hint));
}

export async function annotateSlidesWithLayoutSemanticsBestEffort(
  slides: readonly SlideExtractionResult[],
  storyboard: DeckStoryboard,
  analyzeSlide: SlideLayoutSemanticAnalyzer
): Promise<SlideExtractionResult[]> {
  const inputs = buildLayoutSemanticInputs(slides, storyboard);
  const inputBySlideIndex = new Map(inputs.map((input) => [input.slide_index, input]));
  const hintsBySlideIndex = new Map<number, readonly SlideLayoutSemanticHint[]>();

  for (const slide of slides) {
    const input = inputBySlideIndex.get(slide.slide_index);
    if (!input) {
      hintsBySlideIndex.set(slide.slide_index, []);
      continue;
    }

    try {
      const rawHints = await analyzeSlide(input);
      const validatedHints = validateSlideLayoutHints(input, rawHints);
      const hintStats = summarizeHintValidation(
        input,
        Array.isArray(rawHints) ? rawHints : [],
        validatedHints
      );
      console.log(
        `Layout semantics slide ${slide.slide_index + 1}: accepted=${hintStats.accepted}, rejected_low_confidence=${hintStats.rejectedLowConfidence}, ignored_invalid=${hintStats.ignoredInvalid}`
      );
      hintsBySlideIndex.set(slide.slide_index, validatedHints);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      console.warn(
        `Layout semantics analysis fallback applied for slide ${slide.slide_index + 1}: ${message}`
      );
      hintsBySlideIndex.set(slide.slide_index, []);
    }
  }

  return slides.map((slide) => {
    const slideHints = new Map(
      (hintsBySlideIndex.get(slide.slide_index) ?? []).map((hint) => [hint.node_id, hint])
    );
    const fallbackHints = buildRuleBasedFallbackHints(slide.nodes);

    return {
      ...slide,
      nodes: slide.nodes.map((node) => {
        if (node.element_type === "speaker_notes") {
          return node;
        }

        return {
          ...node,
          layout_hint:
            slideHints.get(node.node_id) ??
            fallbackHints.get(node.node_id) ??
            buildDefaultLayoutHint(node.node_id),
          layout_hint_source: slideHints.has(node.node_id) ? "model" : "fallback",
        };
      }),
    };
  });
}

function projectNodeToLayoutSemanticInput(
  node: SlideTextNode
): SlideLayoutSemanticNodeInput {
  const fontMetrics = collectFontMetrics(node);

  return {
    node_id: node.node_id,
    element_type: node.element_type,
    archetype: node.archetype,
    text_excerpt: truncateText(node.full_text, MAX_TEXT_EXCERPT_LENGTH),
    paragraph_count: node.paragraphs.length,
    alignment: resolveAlignment(node),
    min_font_size_pt: fontMetrics.min_font_size_pt,
    max_font_size_pt: fontMetrics.max_font_size_pt,
    font_family: resolveFontFamily(node),
    fill_color_hex: node.visible_style?.fill_color_hex,
    outline_color_hex: node.visible_style?.outline_color_hex,
    box: node.box,
  };
}

function buildDefaultLayoutHint(nodeId: string): SlideLayoutSemanticHint {
  return {
    node_id: nodeId,
    visual_role: DEFAULT_VISUAL_ROLE,
    cluster_id: nodeId,
    line_policy: DEFAULT_LINE_POLICY,
    scale_sync: DEFAULT_SCALE_SYNC,
    confidence: 0,
  };
}

function buildRuleBasedFallbackHints(
  nodes: readonly SlideTextNode[]
): Map<string, SlideLayoutSemanticHint> {
  const visibleNodes = nodes.filter((node) => node.element_type !== "speaker_notes");
  const hints = new Map<string, SlideLayoutSemanticHint>();
  if (visibleNodes.length === 0) {
    return hints;
  }

  const sortedByTop = [...visibleNodes].sort(
    (left, right) =>
      left.box.translate_y_emu - right.box.translate_y_emu ||
      right.box.width_emu - left.box.width_emu
  );
  const maxFontSize = Math.max(
    0,
    ...visibleNodes.map((node) => node.visible_style?.max_font_size_pt ?? 0)
  );
  const titleCandidate = sortedByTop.find((node) =>
    isObviousTitleNode(node, sortedByTop[0], maxFontSize)
  );

  for (const node of visibleNodes) {
    if (titleCandidate && node.node_id === titleCandidate.node_id) {
      hints.set(
        node.node_id,
        buildFallbackHint(node.node_id, "title", "prefer_single_line", "independent")
      );
      continue;
    }

    if (node.archetype === "bullet_list" || node.archetype === "table_cell") {
      hints.set(
        node.node_id,
        buildFallbackHint(node.node_id, "body", "allow_wrap", "independent")
      );
      continue;
    }

    if (node.paragraphs.length > 1 || node.full_text.trim().length >= 80) {
      hints.set(
        node.node_id,
        buildFallbackHint(node.node_id, "body", "allow_wrap", "independent")
      );
    }
  }

  return hints;
}

function buildFallbackHint(
  nodeId: string,
  visualRole: SlideLayoutVisualRole,
  linePolicy: SlideLayoutLinePolicy,
  scaleSync: SlideLayoutScaleSync
): SlideLayoutSemanticHint {
  return {
    node_id: nodeId,
    visual_role: visualRole,
    cluster_id: nodeId,
    line_policy: linePolicy,
    scale_sync: scaleSync,
    confidence: 0,
  };
}

function isObviousTitleNode(
  node: SlideTextNode,
  topMostNode: SlideTextNode | undefined,
  maxFontSize: number
): boolean {
  if (node.element_type !== "shape") {
    return false;
  }
  if (node.archetype !== "plain_text" && node.archetype !== "mixed_emphasis") {
    return false;
  }
  if (node.paragraphs.length !== 1) {
    return false;
  }

  const fontSize = node.visible_style?.max_font_size_pt ?? 0;
  const isTopMostNode = topMostNode?.node_id === node.node_id;
  const isWide = node.box.width_emu >= 260 * 12700;
  const isShort = node.box.height_emu <= 60 * 12700;
  const hasLargeType = fontSize >= Math.max(26, maxFontSize * 0.9);
  const hasLongHeadline = node.full_text.trim().length >= 18;

  return isTopMostNode && isWide && isShort && hasLargeType && hasLongHeadline;
}

function summarizeHintValidation(
  slideInput: SlideLayoutSemanticSlideInput,
  candidates: readonly unknown[],
  validatedHints: readonly SlideLayoutSemanticHint[]
): {
  readonly accepted: number;
  readonly rejectedLowConfidence: number;
  readonly ignoredInvalid: number;
} {
  const knownNodeIds = new Set(slideInput.nodes.map((node: SlideLayoutSemanticNodeInput) => node.node_id));
  const acceptedNodeIds = new Set(validatedHints.map((hint) => hint.node_id));
  let rejectedLowConfidence = 0;
  let ignoredInvalid = 0;

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      ignoredInvalid += 1;
      continue;
    }

    const nodeId = typeof (candidate as { node_id?: unknown }).node_id === "string"
      ? (candidate as { node_id: string }).node_id
      : "";
    if (!knownNodeIds.has(nodeId)) {
      ignoredInvalid += 1;
      continue;
    }
    if (acceptedNodeIds.has(nodeId)) {
      continue;
    }

    const confidence = normalizeConfidence((candidate as { confidence?: unknown }).confidence);
    if (confidence < MIN_LAYOUT_HINT_CONFIDENCE) {
      rejectedLowConfidence += 1;
      continue;
    }

    ignoredInvalid += 1;
  }

  return {
    accepted: validatedHints.length,
    rejectedLowConfidence,
    ignoredInvalid,
  };
}

function collectFontMetrics(node: SlideTextNode): {
  min_font_size_pt?: number;
  max_font_size_pt?: number;
} {
  if (
    typeof node.visible_style?.min_font_size_pt === "number" &&
    typeof node.visible_style?.max_font_size_pt === "number"
  ) {
    return {
      min_font_size_pt: node.visible_style.min_font_size_pt,
      max_font_size_pt: node.visible_style.max_font_size_pt,
    };
  }

  const sizes = node.paragraphs
    .flatMap((paragraph) => paragraph.runs)
    .map((run) => run.text_style.fontSize?.magnitude)
    .filter((value): value is number => typeof value === "number" && value > 0);

  if (sizes.length === 0) {
    return {};
  }

  return {
    min_font_size_pt: Math.min(...sizes),
    max_font_size_pt: Math.max(...sizes),
  };
}

function resolveAlignment(node: SlideTextNode): string {
  if (typeof node.visible_style?.alignment === "string" && node.visible_style.alignment) {
    return node.visible_style.alignment;
  }

  for (const paragraph of node.paragraphs) {
    const alignment = paragraph.paragraph_style.alignment;
    if (typeof alignment === "string" && alignment) {
      return alignment;
    }
  }

  return "UNKNOWN";
}

function resolveFontFamily(node: SlideTextNode): string | undefined {
  if (typeof node.visible_style?.font_family === "string" && node.visible_style.font_family) {
    return node.visible_style.font_family;
  }

  for (const paragraph of node.paragraphs) {
    for (const run of paragraph.runs) {
      const fontFamily = run.text_style.weightedFontFamily?.fontFamily;
      if (typeof fontFamily === "string" && fontFamily) {
        return fontFamily;
      }
    }
  }

  return undefined;
}

function normalizeVisualRole(value: unknown): SlideLayoutVisualRole {
  return typeof value === "string" && SLIDE_LAYOUT_VISUAL_ROLES.includes(value as SlideLayoutVisualRole)
    ? (value as SlideLayoutVisualRole)
    : DEFAULT_VISUAL_ROLE;
}

function normalizeClusterId(value: unknown, nodeId: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : nodeId;
}

function normalizeLinePolicy(value: unknown): SlideLayoutLinePolicy {
  return typeof value === "string" &&
    SLIDE_LAYOUT_LINE_POLICIES.includes(value as SlideLayoutLinePolicy)
    ? (value as SlideLayoutLinePolicy)
    : DEFAULT_LINE_POLICY;
}

function normalizeScaleSync(value: unknown): SlideLayoutScaleSync {
  return typeof value === "string" &&
    SLIDE_LAYOUT_SCALE_SYNC_OPTIONS.includes(value as SlideLayoutScaleSync)
    ? (value as SlideLayoutScaleSync)
    : DEFAULT_SCALE_SYNC;
}

function normalizeConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : 0;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
