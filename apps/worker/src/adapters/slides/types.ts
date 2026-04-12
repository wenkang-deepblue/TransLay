import type { slides_v1 } from "googleapis";

export type SlideNodeArchetype =
  | "plain_text"
  | "bullet_list"
  | "metric_card"
  | "mixed_emphasis"
  | "table_cell"
  | "speaker_notes";

export type SlideRunStyleRole =
  | "default"
  | "emphasis"
  | "metric_value"
  | "metric_unit"
  | "prefix"
  | "suffix";

export const SLIDE_LAYOUT_VISUAL_ROLES = [
  "title",
  "subtitle",
  "section_label",
  "agenda_item",
  "step_label",
  "body",
  "caption",
  "badge",
  "decorative_text",
  "unknown",
] as const;
export type SlideLayoutVisualRole =
  (typeof SLIDE_LAYOUT_VISUAL_ROLES)[number];

export const SLIDE_LAYOUT_LINE_POLICIES = [
  "prefer_single_line",
  "allow_wrap",
  "fixed_multiline",
] as const;
export type SlideLayoutLinePolicy =
  (typeof SLIDE_LAYOUT_LINE_POLICIES)[number];

export const SLIDE_LAYOUT_SCALE_SYNC_OPTIONS = [
  "sync_with_group",
  "independent",
] as const;
export type SlideLayoutScaleSync =
  (typeof SLIDE_LAYOUT_SCALE_SYNC_OPTIONS)[number];

export type SlideTextStyleSnapshot = slides_v1.Schema$TextStyle;
export type SlideParagraphStyleSnapshot = slides_v1.Schema$ParagraphStyle;

export interface SlideBoxGeometry {
  readonly width_emu: number;
  readonly height_emu: number;
  readonly translate_x_emu: number;
  readonly translate_y_emu: number;
  readonly rotation_deg: number;
}

export interface SlideBulletMetadata {
  readonly list_id?: string;
  readonly glyph?: string;
  readonly nesting_level?: number;
}

export interface SlideTextRun {
  readonly run_id: string;
  readonly text: string;
  readonly start_index: number;
  readonly end_index: number;
  readonly style_role: SlideRunStyleRole;
  readonly text_style: SlideTextStyleSnapshot;
}

export interface SlideParagraph {
  readonly paragraph_id: string;
  readonly text: string;
  readonly start_index: number;
  readonly end_index: number;
  readonly bullet?: SlideBulletMetadata;
  readonly paragraph_style: SlideParagraphStyleSnapshot;
  readonly runs: SlideTextRun[];
}

export interface SlideVisibleStyleSummary {
  readonly alignment?: string;
  readonly font_family?: string;
  readonly min_font_size_pt?: number;
  readonly max_font_size_pt?: number;
  readonly fill_color_hex?: string;
  readonly outline_color_hex?: string;
}

export interface SlideLayoutSemanticHint {
  readonly node_id: string;
  readonly visual_role: SlideLayoutVisualRole;
  readonly cluster_id: string;
  readonly line_policy: SlideLayoutLinePolicy;
  readonly scale_sync: SlideLayoutScaleSync;
  readonly confidence: number;
}

/** Extracted text node from a Slides presentation. */
export interface SlideTextNode {
  readonly node_id: string;
  /** Flattened translatable text for the current translation stage. */
  readonly text: string;
  readonly full_text: string;
  readonly slide_index: number;
  /** Source element for write-back reference. */
  readonly element_type: "shape" | "table_cell" | "speaker_notes";
  readonly archetype: SlideNodeArchetype;
  readonly object_id: string;
  readonly box: SlideBoxGeometry;
  readonly paragraphs: SlideParagraph[];
  readonly visible_style?: SlideVisibleStyleSummary;
  readonly layout_hint?: SlideLayoutSemanticHint;
  /** For table cells: row and column indices. */
  readonly row_index?: number;
  readonly col_index?: number;
}

/** Extraction result for a single slide. */
export interface SlideExtractionResult {
  readonly slide_index: number;
  readonly slide_object_id: string;
  readonly nodes: SlideTextNode[];
}

/** Full extraction result for the presentation. */
export interface PresentationExtractionResult {
  readonly presentation_id: string;
  readonly title: string;
  readonly total_slides: number;
  readonly extracted_slides: SlideExtractionResult[];
  readonly all_nodes: SlideTextNode[];
  /** Plain text summary of the entire presentation (all slides), for translation context. */
  readonly full_context_text: string;
}
