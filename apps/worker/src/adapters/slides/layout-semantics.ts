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
import { measureTextWeight } from "./fit-pass";

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
    const resolved = slide.nodes.map((node) =>
      resolveNodeLayoutSemantics(node, slideHints, fallbackHints)
    );

    return {
      ...slide,
      nodes: applyGeometricClusterOverride(resolved, fallbackHints),
    };
  });
}

export async function annotateSlidesWithLayoutSemanticsBestEffortOnDemand(
  slides: readonly SlideExtractionResult[],
  getThumbnail: (slide: SlideExtractionResult) => Promise<StoryboardFrame>,
  analyzeSlide: SlideLayoutSemanticAnalyzer
): Promise<SlideExtractionResult[]> {
  const hintsBySlideIndex = new Map<number, readonly SlideLayoutSemanticHint[]>();

  for (const slide of slides) {
    const thumbnail = await getThumbnail(slide);
    const [input] = buildLayoutSemanticInputs([slide], { frames: [thumbnail] });
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

  return annotateSlidesWithPersistedLayoutHints(
    slides,
    slides.flatMap((slide) =>
      (hintsBySlideIndex.get(slide.slide_index) ?? []).map((hint) => ({
        ...hint,
        slide_index: slide.slide_index,
      }))
    )
  );
}

export function annotateSlidesWithPersistedLayoutHints(
  slides: readonly SlideExtractionResult[],
  hints: readonly (SlideLayoutSemanticHint & { readonly slide_index: number })[]
): SlideExtractionResult[] {
  const hintsBySlideIndex = new Map<number, SlideLayoutSemanticHint[]>();
  for (const hint of hints) {
    const members = hintsBySlideIndex.get(hint.slide_index) ?? [];
    members.push(hint);
    hintsBySlideIndex.set(hint.slide_index, members);
  }

  return slides.map((slide) => {
    const slideHints = new Map(
      (hintsBySlideIndex.get(slide.slide_index) ?? []).map((hint) => [hint.node_id, hint])
    );
    const fallbackHints = buildRuleBasedFallbackHints(slide.nodes);
    const resolved = slide.nodes.map((node) =>
      resolveNodeLayoutSemantics(node, slideHints, fallbackHints)
    );

    return {
      ...slide,
      nodes: applyGeometricClusterOverride(resolved, fallbackHints),
    };
  });
}

/**
 * Layout semantics policy matrix:
 * 1. Accepted model hints define visual intent and remain the primary source.
 * 2. Rule-based fallback only fills gaps when the model is missing, invalid,
 *    or below confidence threshold after validation.
 * 3. Fit-pass remains the physical arbiter: it may degrade single-line intent
 *    when transform-aware geometry proves the hint impossible to honor.
 * 4. High-confidence geometric sync groups may merge fragmented short-label
 *    clusters when the model clearly under-clusters a repeated visual series.
 */
function resolveNodeLayoutSemantics(
  node: SlideTextNode,
  modelHints: ReadonlyMap<string, SlideLayoutSemanticHint>,
  fallbackHints: ReadonlyMap<string, SlideLayoutSemanticHint>
): SlideTextNode {
  if (node.element_type === "speaker_notes") {
    return node;
  }

  const modelHint = modelHints.get(node.node_id);
  if (modelHint) {
    const corrected = applyGeometricLineCorrection(node, modelHint, fallbackHints);
    return {
      ...node,
      layout_hint: corrected,
      layout_hint_source: "model",
    };
  }

  return {
    ...node,
    layout_hint: fallbackHints.get(node.node_id) ?? buildDefaultLayoutHint(node.node_id),
    layout_hint_source: "fallback",
  };
}

/**
 * If the model classifies a source-single-line label as wrap-tolerant or
 * intentionally multiline, override it back to prefer_single_line. The model
 * lacks precise geometric awareness and occasionally overreacts to long text
 * or rounded labels; this correction restores the source's visible treatment.
 */
function applyGeometricLineCorrection(
  node: SlideTextNode,
  hint: SlideLayoutSemanticHint,
  fallbackHints: ReadonlyMap<string, SlideLayoutSemanticHint>
): SlideLayoutSemanticHint {
  const fallback = fallbackHints.get(node.node_id);
  if (fallback?.line_policy === "prefer_single_line" && isSourceSingleLine(node, fallback.visual_role)) {
    return { ...hint, line_policy: "prefer_single_line" };
  }

  return hint;
}

/**
 * When fallback hints discover a high-confidence geometric sync group and the
 * resolved hints fragment a repeated short-label series, merge them into one
 * geometric cluster. This is a narrow safety net for obvious repeating peers
 * (agenda items, badges, captions) rather than a general replacement for the
 * model's semantic grouping.
 */
function applyGeometricClusterOverride(
  nodes: readonly SlideTextNode[],
  fallbackHints: ReadonlyMap<string, SlideLayoutSemanticHint>
): SlideTextNode[] {
  const geoGroups = new Map<string, string[]>();
  for (const [nodeId, hint] of fallbackHints) {
    if (hint.scale_sync === "sync_with_group" && hint.cluster_id.startsWith("geo_sync_")) {
      const members = geoGroups.get(hint.cluster_id) ?? [];
      members.push(nodeId);
      geoGroups.set(hint.cluster_id, members);
    }
  }

  if (geoGroups.size === 0) return nodes as SlideTextNode[];

  const nodesById = new Map(nodes.map((node) => [node.node_id, node]));

  const overrideMap = new Map<string, string>();
  for (const [clusterId, memberIds] of geoGroups) {
    if (memberIds.length < 2) continue;
    const members = memberIds
      .map((nodeId) => nodesById.get(nodeId))
      .filter((node): node is SlideTextNode => Boolean(node));
    if (!shouldApplyGeometricClusterOverride(members)) {
      continue;
    }
    for (const nodeId of memberIds) {
      overrideMap.set(nodeId, clusterId);
    }
  }

  return nodes.map((node) => {
    const geoClusterId = overrideMap.get(node.node_id);
    if (!geoClusterId) return node;

    const hint = node.layout_hint;
    if (!hint) return node;

    if (hint.scale_sync === "sync_with_group" && hint.cluster_id === geoClusterId) {
      return node;
    }

    return {
      ...node,
      layout_hint: {
        ...hint,
        cluster_id: geoClusterId,
        scale_sync: "sync_with_group",
      },
    };
  });
}

const GEO_OVERRIDE_COMPATIBLE_ROLES = new Set<SlideLayoutSemanticHint["visual_role"]>([
  "agenda_item",
  "step_label",
  "section_label",
  "caption",
  "badge",
  "subtitle",
  "unknown",
]);

function shouldApplyGeometricClusterOverride(nodes: readonly SlideTextNode[]): boolean {
  if (nodes.length < 2) {
    return false;
  }

  const hints = nodes
    .map((node) => node.layout_hint)
    .filter((hint): hint is SlideLayoutSemanticHint => Boolean(hint));
  if (hints.length !== nodes.length) {
    return false;
  }

  if (
    !nodes.every((node) => {
      const hint = node.layout_hint;
      return (
        node.paragraphs.length === 1 &&
        node.full_text.trim().length > 0 &&
        node.full_text.trim().length < 80 &&
        hint?.line_policy !== "fixed_multiline" &&
        GEO_OVERRIDE_COMPATIBLE_ROLES.has(hint?.visual_role ?? "unknown")
      );
    })
  ) {
    return false;
  }

  const syncSignatures = new Set(
    hints.map((hint) =>
      hint.scale_sync === "sync_with_group"
        ? `group:${hint.cluster_id}`
        : `independent:${hint.node_id}`
    )
  );
  if (syncSignatures.size <= 1) {
    return false;
  }

  return true;
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

const EMU_PER_PT = 12700;
const SINGLE_LINE_WIDTH_FACTOR = 0.56;
const DEFAULT_SHAPE_INSET_H_EMU = 91440;

function resolveSingleLineInsetBudgetEmu(node: SlideTextNode) {
  if (node.element_type !== "shape") {
    return {
      left_emu: 0,
      right_emu: 0,
    };
  }

  return {
    left_emu: node.text_insets_emu?.left_emu ?? DEFAULT_SHAPE_INSET_H_EMU,
    right_emu: node.text_insets_emu?.right_emu ?? DEFAULT_SHAPE_INSET_H_EMU,
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
      continue;
    }

    const visualRole = inferShortTextVisualRole(node, titleCandidate);
    if (isSourceSingleLine(node, visualRole)) {
      hints.set(
        node.node_id,
        buildFallbackHint(node.node_id, visualRole, "prefer_single_line", "independent")
      );
    }
  }

  assignGeometricSyncGroups(visibleNodes, hints, titleCandidate);

  return hints;
}

/**
 * Post-process fallback hints: find groups of geometrically near-identical
 * short-text shape nodes on the same slide and assign them a shared cluster
 * with sync_with_group. Typical targets are agenda items, step labels, or
 * repeating tag elements the user drew with similar dimensions and font size.
 */
function assignGeometricSyncGroups(
  nodes: readonly SlideTextNode[],
  hints: Map<string, SlideLayoutSemanticHint>,
  titleCandidate: SlideTextNode | undefined
): void {
  const candidates = nodes.filter((n) => {
    if (n.element_type !== "shape") return false;
    if (titleCandidate && n.node_id === titleCandidate.node_id) return false;
    if (n.archetype === "bullet_list" || n.archetype === "table_cell") return false;
    if (n.paragraphs.length > 1) return false;
    if (n.full_text.trim().length >= 80) return false;
    if (hints.get(n.node_id)?.line_policy !== "prefer_single_line") return false;
    const fontSize = n.visible_style?.max_font_size_pt ?? 0;
    return fontSize > 0;
  });

  if (candidates.length < 2) return;

  type BucketKey = string;
  const buckets = new Map<BucketKey, SlideTextNode[]>();

  for (const node of candidates) {
    const fontSize = Math.round((node.visible_style?.max_font_size_pt ?? 0) * 10);
    const w = Math.round(node.box.width_emu / 10000);
    const h = Math.round(node.box.height_emu / 10000);
    const key: BucketKey = `${node.slide_index}:${w}:${h}:${fontSize}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(node);
    buckets.set(key, bucket);
  }

  for (const group of buckets.values()) {
    if (group.length < 2) continue;

    const clusterId = `geo_sync_${group[0]!.node_id}`;
    for (const node of group) {
      const existing = hints.get(node.node_id);
      if (existing) {
        hints.set(node.node_id, {
          ...existing,
          cluster_id: clusterId,
          scale_sync: "sync_with_group",
        });
      } else {
        hints.set(
          node.node_id,
          buildFallbackHint(node.node_id, "section_label", "prefer_single_line", "sync_with_group")
        );
        const h = hints.get(node.node_id)!;
        hints.set(node.node_id, { ...h, cluster_id: clusterId });
      }
    }
  }
}

/**
 * Detect whether the source text visually fits on a single line
 * inside its bounding box at its current font size.
 */
function isSourceSingleLine(
  node: SlideTextNode,
  visualRole: SlideLayoutVisualRole = "unknown"
): boolean {
  if (node.paragraphs.length !== 1) {
    return false;
  }

  const text = node.full_text.trim();
  if (!text || text.length === 0) {
    return false;
  }

  const fontSize = node.visible_style?.max_font_size_pt ?? 0;
  if (fontSize <= 0) {
    return false;
  }

  const inset = resolveSingleLineInsetBudgetEmu(node);
  const widthPt = Math.max(1, (node.box.width_emu - inset.left_emu - inset.right_emu) / EMU_PER_PT);
  const charsPerLine = widthPt / (fontSize * SINGLE_LINE_WIDTH_FACTOR);
  const textWeight = measureTextWeight(text);
  const toleranceFactor = resolveSourceSingleLineToleranceFactor(visualRole);

  return textWeight <= charsPerLine * toleranceFactor;
}

function resolveSourceSingleLineToleranceFactor(visualRole: SlideLayoutVisualRole): number {
  switch (visualRole) {
    case "title":
      return 1.06;
    case "subtitle":
    case "caption":
    case "section_label":
    case "badge":
    case "agenda_item":
    case "step_label":
      return 1.08;
    default:
      return 1.03;
  }
}

function inferShortTextVisualRole(
  node: SlideTextNode,
  titleNode: SlideTextNode | undefined
): SlideLayoutVisualRole {
  const fontSize = node.visible_style?.max_font_size_pt ?? 0;
  const titleFontSize = titleNode?.visible_style?.max_font_size_pt ?? 0;

  if (titleFontSize > 0 && fontSize >= titleFontSize * 0.7 && fontSize < titleFontSize) {
    return "subtitle";
  }

  if (node.box.width_emu >= 200 * EMU_PER_PT && fontSize >= 10) {
    return "caption";
  }

  return "section_label";
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
