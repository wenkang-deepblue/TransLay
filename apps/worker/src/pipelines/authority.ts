import type {
  AuthorityTranslationNode,
  TranslationContextNodeSummary,
} from "@translay/shared-contracts";
import type { SlideExtractionResult, SlideTextNode } from "../adapters/slides";
import type { AuthoritySourceNode } from "../providers/vertex-gemini-authority";
import {
  groupNodesForTranslation,
  projectLayoutHint,
  projectNodesToContextSummaries,
  projectVisibleStyle,
} from "./context-pack";

export interface AuthorityCoverageAuditResult {
  readonly authority_nodes: readonly AuthorityTranslationNode[];
  readonly missing_nodes: readonly SlideTextNode[];
}

export function projectNodesToAuthoritySourceNodes(
  nodes: readonly SlideTextNode[]
): AuthoritySourceNode[] {
  return nodes.map((node) => ({
    node_id: node.node_id,
    slide_index: node.slide_index,
    object_id: node.object_id,
    element_type: node.element_type,
    archetype: node.archetype,
    full_text: node.full_text,
    visible_style: projectVisibleStyle(node),
    layout_hint: projectLayoutHint(node),
  }));
}

export function auditAuthorityCoverage(
  sourceNodes: readonly SlideTextNode[],
  authorityNodes: readonly AuthorityTranslationNode[]
): AuthorityCoverageAuditResult {
  const byId = new Map(authorityNodes.map((node) => [node.node_id, node]));
  const completeNodes: AuthorityTranslationNode[] = [];
  const missingNodes: SlideTextNode[] = [];

  for (const sourceNode of sourceNodes) {
    const authorityNode = byId.get(sourceNode.node_id);
    if (!authorityNode || authorityNode.translated_full_text.trim().length === 0) {
      missingNodes.push(sourceNode);
      continue;
    }

    completeNodes.push(authorityNode);
  }

  return {
    authority_nodes: completeNodes,
    missing_nodes: missingNodes,
  };
}

export function mergeAuthorityNodes(
  primaryNodes: readonly AuthorityTranslationNode[],
  supplementNodes: readonly AuthorityTranslationNode[]
): AuthorityTranslationNode[] {
  const merged = new Map<string, AuthorityTranslationNode>();
  for (const node of primaryNodes) {
    merged.set(node.node_id, node);
  }
  for (const node of supplementNodes) {
    merged.set(node.node_id, node);
  }
  return [...merged.values()].sort((left, right) => {
    if (left.slide_index !== right.slide_index) {
      return left.slide_index - right.slide_index;
    }
    return left.node_id.localeCompare(right.node_id);
  });
}

export interface MaterializationGroup {
  readonly node_summaries: readonly TranslationContextNodeSummary[];
}

export function buildMaterializationGroups(
  slides: readonly SlideExtractionResult[],
  options: {
    readonly maxNodesPerGroup?: number;
    readonly maxCharsPerGroup?: number;
  } = {}
): MaterializationGroup[] {
  const groups: MaterializationGroup[] = [];
  for (const slide of slides) {
    const packedGroups = groupNodesForTranslation(slide.nodes, options);
    for (const group of packedGroups) {
      groups.push({
        node_summaries: projectNodesToContextSummaries(group),
      });
    }
  }
  return groups;
}
