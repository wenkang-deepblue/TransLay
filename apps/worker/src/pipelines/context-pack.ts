import type {
  TranslationContextGlossaryCandidate,
  TranslationContextPack,
  TranslationNode,
} from "@translay/shared-contracts";
import type { SlideTextNode } from "../adapters/slides";

export interface TranslationGroupOptions {
  readonly maxNodesPerGroup?: number;
  readonly maxCharsPerGroup?: number;
}

export interface BuildDeckContextPackParams {
  readonly deckTitle: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly deckPlaintextContext: string;
  readonly deckNodes: readonly SlideTextNode[];
  readonly activeGroup: readonly SlideTextNode[];
}

const DEFAULT_MAX_NODES_PER_GROUP = 25;
const DEFAULT_MAX_CHARS_PER_GROUP = 4_000;
const MAX_GLOSSARY_CANDIDATES = 20;

export function groupNodesForTranslation(
  nodes: readonly SlideTextNode[],
  options: TranslationGroupOptions = {}
): SlideTextNode[][] {
  if (nodes.length === 0) {
    return [];
  }

  const maxNodesPerGroup = options.maxNodesPerGroup ?? DEFAULT_MAX_NODES_PER_GROUP;
  const maxCharsPerGroup = options.maxCharsPerGroup ?? DEFAULT_MAX_CHARS_PER_GROUP;
  const bodyBuckets = createContainerBuckets(
    nodes.filter((node) => node.element_type !== "speaker_notes")
  );
  const notesBuckets = createContainerBuckets(
    nodes.filter((node) => node.element_type === "speaker_notes")
  );

  return [
    ...packBucketsIntoGroups(bodyBuckets, maxNodesPerGroup, maxCharsPerGroup),
    ...packBucketsIntoGroups(notesBuckets, maxNodesPerGroup, maxCharsPerGroup),
  ];
}

export function projectGroupToTranslationNodes(
  group: readonly SlideTextNode[]
): TranslationNode[] {
  return group.map((node) => ({
    node_id: node.node_id,
    text: node.text,
  }));
}

export function buildDeckContextPack(
  params: BuildDeckContextPackParams
): TranslationContextPack {
  return {
    deck_title: params.deckTitle,
    source_language: params.sourceLanguage,
    target_language: params.targetLanguage,
    deck_plaintext_context: params.deckPlaintextContext,
    glossary_candidates: extractGlossaryCandidates(params.deckNodes),
    nodes: params.activeGroup.map((node) => ({
      node_id: node.node_id,
      archetype: node.archetype,
      slide_index: node.slide_index,
      full_text: node.full_text,
      paragraphs: node.paragraphs.map((paragraph) => ({
        paragraph_id: paragraph.paragraph_id,
        text: paragraph.text,
        bullet: paragraph.bullet
          ? { nesting_level: paragraph.bullet.nesting_level }
          : undefined,
        style_roles: paragraph.runs.map((run) => run.style_role),
        segments: paragraph.runs.map((run) => ({
          segment_id: run.run_id,
          text: run.text,
          style_role: run.style_role,
        })),
      })),
    })),
  };
}

function extractGlossaryCandidates(
  nodes: readonly SlideTextNode[]
): TranslationContextGlossaryCandidate[] {
  const candidates = new Map<string, TranslationContextGlossaryCandidate>();

  for (const node of nodes) {
    for (const term of extractCandidateTerms(node.full_text)) {
      const key = term.toLowerCase();
      const existing = candidates.get(key);
      if (existing) {
        candidates.set(key, {
          ...existing,
          occurrences: existing.occurrences + 1,
        });
        continue;
      }

      candidates.set(key, {
        source_term: term,
        occurrences: 1,
      });
    }
  }

  return pruneContainedCandidates([...candidates.values()])
    .filter((candidate) => candidate.occurrences >= 2)
    .sort((left, right) => {
      if (right.occurrences !== left.occurrences) {
        return right.occurrences - left.occurrences;
      }

      return left.source_term.localeCompare(right.source_term);
    })
    .slice(0, MAX_GLOSSARY_CANDIDATES);
}

function extractCandidateTerms(text: string): string[] {
  const terms = new Set<string>();

  for (const match of text.matchAll(/\b[A-Z][A-Z0-9]{1,}\b/g)) {
    if (match[0]) {
      terms.add(match[0]);
    }
  }

  for (const match of text.matchAll(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*\b/g)) {
    if (match[0]) {
      terms.add(match[0]);
    }
  }

  for (const match of text.matchAll(/[（(]([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,20})[）)]/gu)) {
    if (match[1]) {
      terms.add(match[1]);
    }
  }

  for (const match of text.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,20}/gu)) {
    if (match[0]) {
      terms.add(match[0]);
      for (const subterm of extractCjkSubterms(match[0])) {
        terms.add(subterm);
      }
    }
  }

  return [...terms];
}

function createContainerBuckets(nodes: readonly SlideTextNode[]): SlideTextNode[][] {
  const buckets: SlideTextNode[][] = [];
  const bucketByKey = new Map<string, SlideTextNode[]>();

  for (const node of nodes) {
    const key = `${node.element_type}:${node.object_id}`;
    const existingBucket = bucketByKey.get(key);
    if (existingBucket) {
      existingBucket.push(node);
      continue;
    }

    const bucket = [node];
    bucketByKey.set(key, bucket);
    buckets.push(bucket);
  }

  return buckets;
}

function packBucketsIntoGroups(
  buckets: readonly SlideTextNode[][],
  maxNodesPerGroup: number,
  maxCharsPerGroup: number
): SlideTextNode[][] {
  const groups: SlideTextNode[][] = [];
  let currentGroup: SlideTextNode[] = [];
  let currentNodeCount = 0;
  let currentCharCount = 0;

  for (const bucket of buckets) {
    const bucketNodeCount = bucket.length;
    const bucketCharCount = bucket.reduce((sum, node) => sum + node.text.length, 0);
    const exceedsNodeLimit =
      currentGroup.length > 0 && currentNodeCount + bucketNodeCount > maxNodesPerGroup;
    const exceedsCharLimit =
      currentGroup.length > 0 && currentCharCount + bucketCharCount > maxCharsPerGroup;

    if (exceedsNodeLimit || exceedsCharLimit) {
      groups.push(currentGroup);
      currentGroup = [];
      currentNodeCount = 0;
      currentCharCount = 0;
    }

    currentGroup.push(...bucket);
    currentNodeCount += bucketNodeCount;
    currentCharCount += bucketCharCount;
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

function extractCjkSubterms(segment: string): string[] {
  const terms = new Set<string>();
  const maxLength = Math.min(8, segment.length);

  for (let length = 4; length <= maxLength; length += 1) {
    for (let start = 0; start <= segment.length - length; start += 1) {
      terms.add(segment.slice(start, start + length));
    }
  }

  return [...terms];
}

function pruneContainedCandidates(
  candidates: readonly TranslationContextGlossaryCandidate[]
): TranslationContextGlossaryCandidate[] {
  return candidates.filter((candidate) => {
    return !candidates.some((other) => {
      if (candidate.source_term === other.source_term) {
        return false;
      }

      return (
        other.occurrences >= candidate.occurrences &&
        other.source_term.length > candidate.source_term.length &&
        other.source_term.includes(candidate.source_term)
      );
    });
  });
}
