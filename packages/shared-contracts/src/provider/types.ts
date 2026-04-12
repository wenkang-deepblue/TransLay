export const PROVIDER_NAMES = ["vertex_gemini", "gemma3_translate"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];
export const TRANSLATION_NODE_ARCHETYPES = [
  "plain_text",
  "bullet_list",
  "metric_card",
  "mixed_emphasis",
  "table_cell",
  "speaker_notes",
] as const;
export type TranslationNodeArchetype =
  (typeof TRANSLATION_NODE_ARCHETYPES)[number];

export const TRANSLATION_SEGMENT_STYLE_ROLES = [
  "default",
  "emphasis",
  "metric_value",
  "metric_unit",
  "prefix",
  "suffix",
] as const;
export type TranslationSegmentStyleRole =
  (typeof TRANSLATION_SEGMENT_STYLE_ROLES)[number];

export const TRANSLATED_PARAGRAPH_BULLET_BEHAVIORS = [
  "preserve",
  "none",
] as const;
export type TranslatedParagraphBulletBehavior =
  (typeof TRANSLATED_PARAGRAPH_BULLET_BEHAVIORS)[number];

/** Translation request sent from Worker to inference plane. */
export interface TranslationNode {
  readonly node_id: string;
  /** @internal MUST NOT be persisted, logged, or cached — zero-content-persistence rule. */
  readonly text: string;
}

export interface TranslationContextGlossaryCandidate {
  readonly source_term: string;
  readonly occurrences: number;
  readonly preferred_translation?: string;
}

export interface TranslationContextParagraphSummary {
  readonly paragraph_id: string;
  readonly text: string;
  readonly bullet?: {
    readonly nesting_level?: number;
  };
  readonly style_roles: readonly TranslationSegmentStyleRole[];
  readonly segments: readonly TranslationContextSegmentSummary[];
}

export interface TranslationContextSegmentSummary {
  readonly segment_id: string;
  readonly text: string;
  readonly style_role: TranslationSegmentStyleRole;
}

export interface TranslationContextNodeVisibleStyleSummary {
  readonly alignment?: string;
  readonly font_family?: string;
  readonly min_font_size_pt?: number;
  readonly max_font_size_pt?: number;
  readonly fill_color_hex?: string;
  readonly outline_color_hex?: string;
}

export interface TranslationContextNodeLayoutHint {
  readonly node_id: string;
  readonly visual_role:
    | "title"
    | "subtitle"
    | "section_label"
    | "agenda_item"
    | "step_label"
    | "body"
    | "caption"
    | "badge"
    | "decorative_text"
    | "unknown";
  readonly cluster_id: string;
  readonly line_policy: "prefer_single_line" | "allow_wrap" | "fixed_multiline";
  readonly scale_sync: "sync_with_group" | "independent";
  readonly confidence: number;
}

export interface TranslationContextNodeSummary {
  readonly node_id: string;
  readonly archetype: TranslationNodeArchetype;
  readonly slide_index: number;
  readonly full_text: string;
  readonly visible_style?: TranslationContextNodeVisibleStyleSummary;
  readonly layout_hint?: TranslationContextNodeLayoutHint;
  readonly paragraphs: readonly TranslationContextParagraphSummary[];
}

export interface TranslationContextPack {
  readonly deck_title: string;
  readonly source_language: string;
  readonly target_language: string;
  /**
   * Full-deck plaintext context, potentially truncated to stay within model budget.
   * @internal MUST NOT be persisted, logged, or cached — zero-content-persistence rule.
   */
  readonly deck_plaintext_context: string;
  readonly glossary_candidates: readonly TranslationContextGlossaryCandidate[];
  /**
   * Structure summary for the current translation batch only.
   * @internal MUST NOT be persisted, logged, or cached — zero-content-persistence rule.
   */
  readonly nodes: readonly TranslationContextNodeSummary[];
}

export interface TranslationRequest {
  readonly provider: ProviderName;
  readonly model: string;
  readonly source_language: string;
  readonly target_language: string;
  readonly nodes: readonly TranslationNode[];
  /**
   * Deck-level context pack provided as read-only context for terminology consistency.
   * @internal MUST NOT be persisted, logged, or cached — zero-content-persistence rule.
   */
  readonly context_pack?: TranslationContextPack;
}

export interface AuthorityTranslationNode {
  readonly node_id: string;
  readonly slide_index: number;
  /** @internal MUST NOT be persisted, logged, or cached — zero-content-persistence rule. */
  readonly translated_full_text: string;
  readonly preferred_terms_used?: readonly string[];
  readonly notes?: readonly string[];
}

export interface AuthorityTranslationResponse {
  readonly provider_request_id: string;
  readonly nodes: readonly AuthorityTranslationNode[];
}

/** Translation response from inference plane. */
export interface TranslatedNode {
  readonly node_id: string;
  /** @internal MUST NOT be persisted, logged, or cached — zero-content-persistence rule. */
  readonly translated_full_text: string;
  readonly paragraphs: readonly TranslatedParagraph[];
  readonly segments: readonly TranslatedSegment[];
  readonly risk_flags?: readonly string[];
}

export interface TranslatedParagraph {
  readonly paragraph_id: string;
  /** @internal MUST NOT be persisted, logged, or cached — zero-content-persistence rule. */
  readonly translated_text: string;
  readonly bullet_behavior: TranslatedParagraphBulletBehavior;
}

export interface TranslatedSegment {
  readonly segment_id: string;
  /** @internal MUST NOT be persisted, logged, or cached — zero-content-persistence rule. */
  readonly translated_text: string;
  readonly style_role: TranslationSegmentStyleRole;
}

export interface TranslationResponse {
  readonly provider_request_id: string;
  readonly nodes: readonly TranslatedNode[];
}
