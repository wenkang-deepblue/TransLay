import type { slides_v1 } from "googleapis";
import type {
  SlideBoxGeometry,
  SlideBulletMetadata,
  SlideNodeArchetype,
  SlideParagraph,
  SlideRunStyleRole,
  SlideTextNode,
  SlideTextRun,
  SlideVisibleStyleSummary,
} from "./types";

const PT_TO_EMU = 12700;

type ExtractableElementType = SlideTextNode["element_type"];

interface BuildRichTextNodeParams {
  readonly nodeId: string;
  readonly objectId: string;
  readonly slideIndex: number;
  readonly elementType: ExtractableElementType;
  readonly placeholderType?: string;
  readonly textContent: slides_v1.Schema$TextContent;
  readonly box: SlideBoxGeometry;
  readonly visibleStyle?: SlideVisibleStyleSummary;
  readonly inheritedFontSizePt?: number;
  readonly rowIndex?: number;
  readonly colIndex?: number;
}

interface MutableSlideParagraph {
  paragraph_id: string;
  text: string;
  line_breaks_before: number;
  start_index: number;
  end_index: number;
  bullet?: SlideBulletMetadata;
  paragraph_style: slides_v1.Schema$ParagraphStyle;
  runs: SlideTextRun[];
}

export function buildRichTextNode(
  params: BuildRichTextNodeParams
): SlideTextNode | null {
  const fullText = extractPlainText(params.textContent);
  if (!fullText.trim()) {
    return null;
  }

  let extractedParagraphs = extractParagraphs(params.textContent);
  const initialArchetype = classifyNodeArchetype(
    params.elementType,
    fullText,
    extractedParagraphs
  );

  if (shouldPreserveBodySourceFormatting({
    elementType: params.elementType,
    placeholderType: params.placeholderType,
    fullText,
    box: params.box,
    visibleStyle: params.visibleStyle,
    archetype: initialArchetype,
    paragraphs: extractedParagraphs,
  })) {
    extractedParagraphs = extractParagraphsPreservingBodySourceFormatting(
      params.textContent
    );
  }

  if (typeof params.inheritedFontSizePt === "number" && params.inheritedFontSizePt > 0) {
    extractedParagraphs = applyInheritedFontSize(extractedParagraphs, params.inheritedFontSizePt);
  }

  const archetype = classifyNodeArchetype(
    params.elementType,
    fullText,
    extractedParagraphs
  );
  const paragraphs = assignStyleRoles(extractedParagraphs, archetype);
  const visibleStyle = mergeVisibleStyleSummary(
    params.visibleStyle,
    summarizeVisibleStyleFromParagraphs(paragraphs, params.box, archetype)
  );

  return {
    node_id: params.nodeId,
    text: fullText,
    full_text: fullText,
    slide_index: params.slideIndex,
    element_type: params.elementType,
    archetype,
    object_id: params.objectId,
    box: params.box,
    paragraphs,
    visible_style: visibleStyle,
    row_index: params.rowIndex,
    col_index: params.colIndex,
  };
}

export function extractPlainText(
  textContent: slides_v1.Schema$TextContent
): string {
  return (textContent.textElements ?? [])
    .map((element) => element.textRun?.content ?? "")
    .join("");
}

export function extractParagraphs(
  textContent: slides_v1.Schema$TextContent
): SlideParagraph[] {
  const paragraphs: SlideParagraph[] = [];
  let current: MutableSlideParagraph | null = null;

  for (const element of textContent.textElements ?? []) {
    if (element.paragraphMarker) {
      if (current) {
        paragraphs.push(finalizeParagraph(current));
      }

      current = createParagraph(
        paragraphs.length,
        element.startIndex ?? current?.end_index ?? 0,
        cloneIfPresent(element.paragraphMarker.style),
        extractBulletMetadata(element.paragraphMarker)
      );
      continue;
    }

    const rawText = element.textRun?.content ?? "";
    if (!rawText) {
      continue;
    }

    if (!current) {
      current = createParagraph(paragraphs.length, element.startIndex ?? 0);
    }

    appendRunToParagraph(current, element, rawText);

    if (rawText.includes("\n")) {
      paragraphs.push(finalizeParagraph(current));
      current = null;
    }
  }

  if (current) {
    paragraphs.push(finalizeParagraph(current));
  }

  return paragraphs.filter((paragraph) => paragraph.text.length > 0 || paragraph.bullet);
}

function extractParagraphsPreservingBodySourceFormatting(
  textContent: slides_v1.Schema$TextContent
): SlideParagraph[] {
  const paragraphs: SlideParagraph[] = [];
  let current: MutableSlideParagraph | null = null;
  let pendingLineBreaks = 0;
  let pendingParagraphStyle: slides_v1.Schema$ParagraphStyle | undefined;
  let pendingBullet: SlideBulletMetadata | undefined;
  let pendingStartIndex = 0;

  for (const element of textContent.textElements ?? []) {
    if (element.paragraphMarker) {
      if (hasParagraphContent(current)) {
        paragraphs.push(finalizeParagraph(current));
        pendingLineBreaks = Math.max(pendingLineBreaks, 1);
      }
      current = null;
      pendingParagraphStyle = cloneIfPresent(element.paragraphMarker.style);
      pendingBullet = extractBulletMetadata(element.paragraphMarker);
      pendingStartIndex = element.startIndex ?? 0;
      continue;
    }

    const rawText = element.textRun?.content ?? "";
    if (!rawText) {
      continue;
    }

    const nextState = appendRunToParagraphPreservingBodySourceFormatting(
      current,
      paragraphs,
      element,
      rawText,
      {
        pendingLineBreaks,
        pendingParagraphStyle,
        pendingBullet,
        pendingStartIndex,
      }
    );
    current = nextState.current;
    pendingLineBreaks = nextState.pendingLineBreaks;
    pendingParagraphStyle = nextState.pendingParagraphStyle;
    pendingBullet = nextState.pendingBullet;
    pendingStartIndex = nextState.pendingStartIndex;
  }

  if (hasParagraphContent(current)) {
    paragraphs.push(finalizeParagraph(current));
  }

  return paragraphs.filter((paragraph) => paragraph.text.length > 0 || paragraph.bullet);
}

export function extractBoxGeometry(
  element: slides_v1.Schema$PageElement,
  parentGroupScaleX?: number,
  parentGroupScaleY?: number
): SlideBoxGeometry {
  // This returns transform-aware effective geometry. Downstream fit / overflow
  // code must consume these EMU dimensions directly instead of reapplying
  // scaleX/scaleY or falling back to raw element size.
  const transform = element.transform;
  const rawWidth = dimensionToEmu(element.size?.width);
  const rawHeight = dimensionToEmu(element.size?.height);
  let scaleX = affineAxisScale(
    transform?.scaleX ?? 1,
    transform?.shearY ?? 0
  );
  let scaleY = affineAxisScale(
    transform?.scaleY ?? 1,
    transform?.shearX ?? 0
  );

  if (typeof parentGroupScaleX === "number" && parentGroupScaleX > 0) {
    scaleX *= parentGroupScaleX;
  }
  if (typeof parentGroupScaleY === "number" && parentGroupScaleY > 0) {
    scaleY *= parentGroupScaleY;
  }

  return {
    width_emu: rawWidth * scaleX,
    height_emu: rawHeight * scaleY,
    translate_x_emu: magnitudeToEmu(transform?.translateX, transform?.unit),
    translate_y_emu: magnitudeToEmu(transform?.translateY, transform?.unit),
    rotation_deg: affineRotationDeg(transform),
  };
}

function affineAxisScale(primaryComponent: number, orthogonalComponent: number): number {
  return Math.sqrt(primaryComponent ** 2 + orthogonalComponent ** 2);
}

export function extractVisibleStyleSummary(
  element: slides_v1.Schema$PageElement,
  textContent: slides_v1.Schema$TextContent
): SlideVisibleStyleSummary | undefined {
  const base = summarizeVisibleStyleFromParagraphs(extractParagraphs(textContent));
  const fillColorHex = extractThemeAgnosticColorHex(
    element.shape?.shapeProperties?.shapeBackgroundFill?.solidFill?.color
  );
  const outlineColorHex = extractThemeAgnosticColorHex(
    element.shape?.shapeProperties?.outline?.outlineFill?.solidFill?.color
  );

  if (!base && !fillColorHex && !outlineColorHex) {
    return undefined;
  }

  return {
    ...base,
    fill_color_hex: fillColorHex,
    outline_color_hex: outlineColorHex,
  };
}

export function extractTableCellVisibleStyleSummary(
  cell: unknown,
  textContent: slides_v1.Schema$TextContent
): SlideVisibleStyleSummary | undefined {
  const base = summarizeVisibleStyleFromParagraphs(extractParagraphs(textContent));
  const fillColorHex = extractTableCellFillColorHex(cell);

  if (!base && !fillColorHex) {
    return undefined;
  }

  return {
    ...base,
    fill_color_hex: fillColorHex,
  };
}

export function classifyNodeArchetype(
  elementType: ExtractableElementType,
  fullText: string,
  paragraphs: readonly SlideParagraph[]
): SlideNodeArchetype {
  if (elementType === "speaker_notes") {
    return "speaker_notes";
  }

  if (elementType === "table_cell") {
    return "table_cell";
  }

  if (paragraphs.some((paragraph) => paragraph.bullet)) {
    return "bullet_list";
  }

  if (looksLikeMetricCard(fullText, paragraphs)) {
    return "metric_card";
  }

  if (hasMixedTextStyles(paragraphs)) {
    return "mixed_emphasis";
  }

  return "plain_text";
}

function createParagraph(
  paragraphIndex: number,
  startIndex: number,
  paragraphStyle?: slides_v1.Schema$ParagraphStyle,
  bullet?: SlideBulletMetadata,
  lineBreaksBefore = paragraphIndex === 0 ? 0 : 1
): MutableSlideParagraph {
  return {
    paragraph_id: `p${paragraphIndex}`,
    text: "",
    line_breaks_before: lineBreaksBefore,
    start_index: startIndex,
    end_index: startIndex,
    bullet,
    paragraph_style: paragraphStyle ?? {},
    runs: [],
  };
}

function appendRunToParagraph(
  paragraph: MutableSlideParagraph,
  element: slides_v1.Schema$TextElement,
  rawText: string
): void {
  const visibleText = rawText.replace(/\n/g, "");
  const startIndex = element.startIndex ?? paragraph.end_index;
  const endIndex = startIndex + visibleText.length;

  if (visibleText.length > 0) {
    paragraph.runs.push({
      run_id: `${paragraph.paragraph_id}_r${paragraph.runs.length}`,
      text: visibleText,
      start_index: startIndex,
      end_index: endIndex,
      style_role: "default",
      text_style: cloneIfPresent(element.textRun?.style) ?? {},
    });
    paragraph.text += visibleText;
    paragraph.end_index = endIndex;
    return;
  }

  const fallbackEnd = element.endIndex ?? paragraph.end_index;
  paragraph.end_index = Math.max(paragraph.end_index, fallbackEnd);
}

function appendRunToParagraphPreservingBodySourceFormatting(
  paragraph: MutableSlideParagraph | null,
  paragraphs: SlideParagraph[],
  element: slides_v1.Schema$TextElement,
  rawText: string,
  state: {
    pendingLineBreaks: number;
    pendingParagraphStyle?: slides_v1.Schema$ParagraphStyle;
    pendingBullet?: SlideBulletMetadata;
    pendingStartIndex: number;
  }
): {
  current: MutableSlideParagraph | null;
  pendingLineBreaks: number;
  pendingParagraphStyle?: slides_v1.Schema$ParagraphStyle;
  pendingBullet?: SlideBulletMetadata;
  pendingStartIndex: number;
} {
  let current = paragraph;
  const style = cloneIfPresent(element.textRun?.style) ?? {};
  let pendingLineBreaks = state.pendingLineBreaks;
  let pendingParagraphStyle = state.pendingParagraphStyle;
  let pendingBullet = state.pendingBullet;
  let pendingStartIndex = state.pendingStartIndex;

  const ensureCurrent = (startIndexFallback: number) => {
    if (current) {
      return current;
    }
    current = createParagraph(
      paragraphs.length,
      pendingStartIndex || startIndexFallback,
      pendingParagraphStyle,
      pendingBullet,
      pendingLineBreaks
    );
    pendingLineBreaks = 0;
    pendingParagraphStyle = undefined;
    pendingBullet = undefined;
    pendingStartIndex = startIndexFallback;
    return current;
  };

  const flushChunk = (chunk: string) => {
    if (!chunk) {
      return;
    }
    const paragraphRef = ensureCurrent(element.startIndex ?? 0);
    const startIndex = paragraphRef.end_index;
    const endIndex = startIndex + chunk.length;
    paragraphRef.runs.push({
      run_id: `${paragraphRef.paragraph_id}_r${paragraphRef.runs.length}`,
      text: chunk,
      start_index: startIndex,
      end_index: endIndex,
      style_role: "default",
      text_style: style,
    });
    paragraphRef.text += chunk;
    paragraphRef.end_index = endIndex;
  };

  let chunkStart = 0;
  for (let index = 0; index < rawText.length; index += 1) {
    if (rawText[index] !== "\n") {
      continue;
    }

    flushChunk(rawText.slice(chunkStart, index));
    if (hasParagraphContent(current)) {
      paragraphs.push(finalizeParagraph(current));
    }
    current = null;
    pendingLineBreaks += 1;
    pendingStartIndex = (element.startIndex ?? 0) + index + 1;
    chunkStart = index + 1;
  }

  flushChunk(rawText.slice(chunkStart));
  return {
    current,
    pendingLineBreaks,
    pendingParagraphStyle,
    pendingBullet,
    pendingStartIndex: current?.end_index ?? pendingStartIndex,
  };
}

function hasParagraphContent(paragraph: MutableSlideParagraph | null): paragraph is MutableSlideParagraph {
  return Boolean(paragraph && (paragraph.text.length > 0 || paragraph.bullet));
}

function finalizeParagraph(paragraph: MutableSlideParagraph): SlideParagraph {
  return {
    paragraph_id: paragraph.paragraph_id,
    text: paragraph.text,
    line_breaks_before: paragraph.line_breaks_before,
    start_index: paragraph.start_index,
    end_index: paragraph.end_index,
    bullet: paragraph.bullet,
    paragraph_style: paragraph.paragraph_style,
    runs: paragraph.runs,
  };
}


function extractBulletMetadata(
  paragraphMarker: slides_v1.Schema$ParagraphMarker
): SlideBulletMetadata | undefined {
  const bullet = paragraphMarker.bullet as
    | (slides_v1.Schema$Bullet & { nestingLevel?: number | null })
    | undefined;

  if (!bullet) {
    return undefined;
  }

  return {
    list_id: bullet.listId ?? undefined,
    glyph: bullet.glyph ?? undefined,
    nesting_level: bullet.nestingLevel ?? undefined,
  };
}

function shouldPreserveBodySourceFormatting(params: {
  readonly elementType: ExtractableElementType;
  readonly placeholderType?: string;
  readonly fullText: string;
  readonly box: SlideBoxGeometry;
  readonly visibleStyle?: SlideVisibleStyleSummary;
  readonly archetype: SlideNodeArchetype;
  readonly paragraphs: readonly SlideParagraph[];
}): boolean {
  if (params.elementType !== "shape") {
    return false;
  }

  if (params.placeholderType && params.placeholderType !== "BODY") {
    return false;
  }

  if (params.archetype !== "plain_text" && params.archetype !== "mixed_emphasis") {
    return false;
  }

  const hasStructuralWhitespace =
    params.fullText.includes("\n") || /[ \t]{2,}/.test(params.fullText);
  if (!hasStructuralWhitespace) {
    return false;
  }

  if (params.placeholderType === "BODY") {
    return true;
  }

  if (params.paragraphs.length > 1 || params.fullText.trim().length >= 80) {
    return true;
  }

  const maxFontSize = params.visibleStyle?.max_font_size_pt ?? 0;
  const heightPt = params.box.height_emu / PT_TO_EMU;
  return maxFontSize > 0 && maxFontSize <= 24 && heightPt >= 36;
}

function applyInheritedFontSize(
  paragraphs: readonly SlideParagraph[],
  inheritedFontSizePt: number
): SlideParagraph[] {
  return paragraphs.map((paragraph) => ({
    ...paragraph,
    runs: paragraph.runs.map((run) => {
      if (typeof run.text_style.fontSize?.magnitude === "number" && run.text_style.fontSize.magnitude > 0) {
        return run;
      }
      return {
        ...run,
        text_style: {
          ...run.text_style,
          fontSize: { magnitude: inheritedFontSizePt, unit: "PT" },
        },
      };
    }),
  }));
}

function assignStyleRoles(
  paragraphs: readonly SlideParagraph[],
  archetype: SlideNodeArchetype
): SlideParagraph[] {
  if (paragraphs.length === 0) {
    return [...paragraphs];
  }

  const baselineSignature = mostCommonStyleSignature(paragraphs);

  return paragraphs.map((paragraph) => ({
    ...paragraph,
    runs: paragraph.runs.map((run, index) => ({
      ...run,
      style_role: resolveRunStyleRole(run, index, paragraph.runs, archetype, baselineSignature),
    })),
  }));
}

function resolveRunStyleRole(
  run: SlideTextRun,
  runIndex: number,
  runs: readonly SlideTextRun[],
  archetype: SlideNodeArchetype,
  baselineSignature: string
): SlideRunStyleRole {
  if (archetype === "metric_card") {
    return resolveMetricRunStyleRole(run, runIndex, runs);
  }

  if (styleSignature(run.text_style) !== baselineSignature) {
    return "emphasis";
  }

  return "default";
}

function resolveMetricRunStyleRole(
  run: SlideTextRun,
  runIndex: number,
  runs: readonly SlideTextRun[]
): SlideRunStyleRole {
  const trimmed = run.text.trim();
  if (!trimmed) {
    return "default";
  }

  const valueRunIndex = runs.findIndex((candidate) =>
    /\d/.test(candidate.text)
  );

  if (/^[\p{Sc}$€£¥₹₩₪₽₫฿]+$/u.test(trimmed)) {
    return "prefix";
  }

  if (/\d/.test(trimmed)) {
    return "metric_value";
  }

  if (valueRunIndex !== -1 && runIndex > valueRunIndex && trimmed.length <= 6) {
    return "metric_unit";
  }

  if (valueRunIndex !== -1 && runIndex < valueRunIndex) {
    return "prefix";
  }

  return "suffix";
}

function summarizeVisibleStyleFromParagraphs(
  paragraphs: readonly SlideParagraph[],
  box?: SlideBoxGeometry,
  archetype?: SlideNodeArchetype
): SlideVisibleStyleSummary | undefined {
  const explicitFontSizes = paragraphs
    .flatMap((paragraph) => paragraph.runs)
    .map((run) => run.text_style.fontSize?.magnitude)
    .filter((value): value is number => typeof value === "number" && value > 0);
  const inferredFontSize =
    explicitFontSizes.length === 0 && box && archetype
      ? inferFontSizeFromGeometry(paragraphs, box, archetype)
      : undefined;
  const fontSizes =
    explicitFontSizes.length > 0
      ? explicitFontSizes
      : typeof inferredFontSize === "number"
        ? [inferredFontSize]
        : [];

  const alignment = paragraphs.find((paragraph) => Boolean(paragraph.paragraph_style.alignment))
    ?.paragraph_style.alignment;
  const fontFamily = paragraphs
    .flatMap((paragraph) => paragraph.runs)
    .map((run) => run.text_style.weightedFontFamily?.fontFamily)
    .find((value): value is string => typeof value === "string" && value.length > 0);

  if (!alignment && !fontFamily && fontSizes.length === 0) {
    return undefined;
  }

  return {
    alignment: typeof alignment === "string" ? alignment : undefined,
    font_family: fontFamily,
    min_font_size_pt: fontSizes.length > 0 ? Math.min(...fontSizes) : undefined,
    max_font_size_pt: fontSizes.length > 0 ? Math.max(...fontSizes) : undefined,
  };
}

function mergeVisibleStyleSummary(
  provided?: SlideVisibleStyleSummary,
  inferred?: SlideVisibleStyleSummary
): SlideVisibleStyleSummary | undefined {
  if (!provided && !inferred) {
    return undefined;
  }

  return {
    alignment: provided?.alignment ?? inferred?.alignment,
    font_family: provided?.font_family ?? inferred?.font_family,
    min_font_size_pt: provided?.min_font_size_pt ?? inferred?.min_font_size_pt,
    max_font_size_pt: provided?.max_font_size_pt ?? inferred?.max_font_size_pt,
    fill_color_hex: provided?.fill_color_hex ?? inferred?.fill_color_hex,
    outline_color_hex: provided?.outline_color_hex ?? inferred?.outline_color_hex,
  };
}

function inferFontSizeFromGeometry(
  paragraphs: readonly SlideParagraph[],
  box: SlideBoxGeometry,
  archetype: SlideNodeArchetype
): number | undefined {
  const widthPt = box.width_emu / PT_TO_EMU;
  const heightPt = box.height_emu / PT_TO_EMU;
  if (widthPt <= 0 || heightPt <= 0) {
    return undefined;
  }

  const profile = getInferenceProfile(archetype);
  const longestLineWeight = Math.max(
    1,
    ...paragraphs.map((paragraph) => estimateWrapFriendlyLineWeight(paragraph.text))
  );
  const paragraphCount = Math.max(1, paragraphs.length);
  const widthLimitedFontSize = widthPt / (longestLineWeight * profile.widthFactor);
  const heightLimitedFontSize = heightPt / (paragraphCount * profile.lineHeightFactor);
  const inferred = Math.min(widthLimitedFontSize, heightLimitedFontSize);

  if (!Number.isFinite(inferred) || inferred <= 0) {
    return undefined;
  }

  return roundFontSize(Math.max(10, Math.min(44, inferred)));
}

function getInferenceProfile(archetype: SlideNodeArchetype): {
  readonly widthFactor: number;
  readonly lineHeightFactor: number;
} {
  switch (archetype) {
    case "bullet_list":
      return { widthFactor: 0.58, lineHeightFactor: 1.4 };
    case "metric_card":
      return { widthFactor: 0.78, lineHeightFactor: 1.12 };
    case "mixed_emphasis":
      return { widthFactor: 0.56, lineHeightFactor: 1.34 };
    case "table_cell":
      return { widthFactor: 0.62, lineHeightFactor: 1.28 };
    case "speaker_notes":
      return { widthFactor: 0.5, lineHeightFactor: 1.34 };
    case "plain_text":
    default:
      return { widthFactor: 0.54, lineHeightFactor: 1.35 };
  }
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

function measureTextWeight(text: string): number {
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

function roundFontSize(value: number): number {
  return Math.round(value * 10) / 10;
}

function mostCommonStyleSignature(paragraphs: readonly SlideParagraph[]): string {
  const counts = new Map<string, number>();

  for (const run of paragraphs.flatMap((paragraph) => paragraph.runs)) {
    if (!run.text.trim()) {
      continue;
    }

    const signature = styleSignature(run.text_style);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }

  let winner = "none";
  let maxCount = 0;

  for (const [signature, count] of counts) {
    if (count > maxCount) {
      winner = signature;
      maxCount = count;
    }
  }

  return winner;
}

function hasMixedTextStyles(paragraphs: readonly SlideParagraph[]): boolean {
  const signatures = new Set<string>();

  for (const run of paragraphs.flatMap((paragraph) => paragraph.runs)) {
    if (!run.text.trim()) {
      continue;
    }

    signatures.add(styleSignature(run.text_style));
    if (signatures.size > 1) {
      return true;
    }
  }

  return false;
}

function looksLikeMetricCard(
  fullText: string,
  paragraphs: readonly SlideParagraph[]
): boolean {
  const normalized = fullText.replace(/\s+/g, " ").trim();
  if (!normalized || !/\d/.test(normalized)) {
    return false;
  }

  const fontSizes = paragraphs
    .flatMap((paragraph) => paragraph.runs)
    .map((run) => run.text_style?.fontSize?.magnitude)
    .filter((size): size is number => typeof size === "number" && size > 0);

  const maxFontSize = fontSizes.length > 0 ? Math.max(...fontSizes) : 0;
  const minFontSize = fontSizes.length > 0 ? Math.min(...fontSizes) : 0;
  const sizeRatio =
    minFontSize > 0 ? maxFontSize / minFontSize : 1;

  return (
    normalized.length <= 96 &&
    paragraphs.length <= 3 &&
    (sizeRatio >= 1.35 ||
      /^[\p{Sc}$€£¥₹₩₪₽₫฿]?\s*[\d.,]+(?:\s*[A-Za-z%]{1,4}|[KMBT])?$/u.test(normalized) ||
      /[\d.,]+(?:万|亿|千|百|万元|亿美元|百萬|億)/u.test(normalized))
  );
}

function styleSignature(style?: slides_v1.Schema$TextStyle): string {
  if (!style) {
    return "none";
  }

  return JSON.stringify({
    fontSize: style.fontSize?.magnitude ?? null,
    fontUnit: style.fontSize?.unit ?? null,
    fontFamily: style.weightedFontFamily?.fontFamily ?? null,
    bold: style.bold ?? null,
    italic: style.italic ?? null,
    underline: style.underline ?? null,
    strikethrough: style.strikethrough ?? null,
    smallCaps: style.smallCaps ?? null,
    foregroundColor: colorSignature(style.foregroundColor),
  });
}

function colorSignature(color?: slides_v1.Schema$OptionalColor): string | null {
  const rgb = color?.opaqueColor?.rgbColor;
  if (!rgb) {
    return null;
  }

  return `${rgb.red ?? 0}:${rgb.green ?? 0}:${rgb.blue ?? 0}`;
}

function extractThemeAgnosticColorHex(color: unknown): string | undefined {
  if (!isRecord(color)) {
    return undefined;
  }

  const rgbColor = color.rgbColor;
  if (!isRecord(rgbColor)) {
    return undefined;
  }

  const red = clampColorChannel(rgbColor.red);
  const green = clampColorChannel(rgbColor.green);
  const blue = clampColorChannel(rgbColor.blue);
  if (red === null || green === null || blue === null) {
    return undefined;
  }

  return `#${toHexChannel(red)}${toHexChannel(green)}${toHexChannel(blue)}`;
}

function clampColorChannel(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

function toHexChannel(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractTableCellFillColorHex(cell: unknown): string | undefined {
  if (!isRecord(cell)) {
    return undefined;
  }

  const tableCellProperties = cell.tableCellProperties;
  if (!isRecord(tableCellProperties)) {
    return undefined;
  }

  const tableCellBackgroundFill = tableCellProperties.tableCellBackgroundFill;
  if (!isRecord(tableCellBackgroundFill)) {
    return undefined;
  }

  const solidFill = tableCellBackgroundFill.solidFill;
  if (!isRecord(solidFill)) {
    return undefined;
  }

  return extractThemeAgnosticColorHex(solidFill.color);
}

function dimensionToEmu(dimension?: slides_v1.Schema$Dimension): number {
  if (!dimension) {
    return 0;
  }

  return magnitudeToEmu(dimension.magnitude, dimension.unit);
}

function magnitudeToEmu(
  magnitude?: number | null,
  unit?: string | null
): number {
  if (typeof magnitude !== "number") {
    return 0;
  }

  if (unit === "EMU" || !unit) {
    return magnitude;
  }

  if (unit === "PT") {
    return magnitude * PT_TO_EMU;
  }

  return magnitude;
}

function affineRotationDeg(
  transform?: slides_v1.Schema$AffineTransform
): number {
  if (!transform) {
    return 0;
  }

  const radians = Math.atan2(-(transform.shearX ?? 0), transform.scaleX ?? 1);
  return radians * (180 / Math.PI);
}

function cloneIfPresent<T>(value?: T | null): T | undefined {
  if (!value) {
    return undefined;
  }

  return structuredClone(value);
}
