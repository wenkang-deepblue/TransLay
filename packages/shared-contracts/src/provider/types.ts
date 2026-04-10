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
  readonly style_roles: readonly string[];
}

export interface TranslationContextNodeSummary {
  readonly node_id: string;
  readonly archetype: TranslationNodeArchetype;
  readonly slide_index: number;
  readonly full_text: string;
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

/** Translation response from inference plane. */
export interface TranslatedNode {
  readonly node_id: string;
  /** @internal MUST NOT be persisted, logged, or cached — zero-content-persistence rule. */
  readonly translated_text: string;
}

export interface TranslationResponse {
  readonly provider_request_id: string;
  readonly nodes: readonly TranslatedNode[];
}
