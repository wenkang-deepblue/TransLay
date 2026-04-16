import type { SlideExtractionResult, SlideTextNode } from "../adapters/slides";

export type NodeKind = "body" | "notes";
export type NodeStageStatus = "pending" | "succeeded" | "failed" | "skipped";

export interface JobNodeExecutionResult {
  readonly node_id: string;
  readonly slide_index: number;
  readonly source_slide_object_id: string;
  readonly source_slide_fingerprint: string;
  readonly node_kind: NodeKind;
  readonly translation_status: NodeStageStatus;
  readonly materialization_status: NodeStageStatus;
  readonly write_status: NodeStageStatus;
  readonly output_visible: boolean;
  readonly failure_reason_code?: string;
}

export type JobNodeExecutionResultMap = Map<string, JobNodeExecutionResult>;

export function initializeJobNodeResults(
  slides: readonly SlideExtractionResult[]
): JobNodeExecutionResultMap {
  const results: JobNodeExecutionResultMap = new Map();
  for (const slide of slides) {
    for (const node of slide.nodes) {
      results.set(node.node_id, {
        node_id: node.node_id,
        slide_index: slide.slide_index,
        source_slide_object_id: slide.slide_object_id,
        source_slide_fingerprint: slide.slide_fingerprint ?? "",
        node_kind: node.element_type === "speaker_notes" ? "notes" : "body",
        translation_status: "pending",
        materialization_status:
          node.element_type === "speaker_notes" ? "skipped" : "pending",
        write_status: "pending",
        output_visible: false,
      });
    }
  }
  return results;
}

export function listJobNodeResults(
  nodeResults: JobNodeExecutionResultMap
): JobNodeExecutionResult[] {
  return [...nodeResults.values()].sort((left, right) => {
    if (left.slide_index !== right.slide_index) {
      return left.slide_index - right.slide_index;
    }
    if (left.node_kind !== right.node_kind) {
      return left.node_kind.localeCompare(right.node_kind);
    }
    return left.node_id.localeCompare(right.node_id);
  });
}

export function markNodeTranslationSucceeded(
  nodeResults: JobNodeExecutionResultMap,
  nodeId: string
): void {
  updateNodeResult(nodeResults, nodeId, (current) => ({
    ...current,
    translation_status: "succeeded",
  }));
}

export function markNodeTranslationFailed(
  nodeResults: JobNodeExecutionResultMap,
  nodeId: string,
  failureReasonCode: string
): void {
  updateNodeResult(nodeResults, nodeId, (current) => ({
    ...current,
    translation_status: "failed",
    failure_reason_code: failureReasonCode,
    materialization_status:
      current.node_kind === "body" ? "skipped" : current.materialization_status,
    write_status: "skipped",
  }));
}

export function markNodeMaterializationSucceeded(
  nodeResults: JobNodeExecutionResultMap,
  nodeId: string
): void {
  updateNodeResult(nodeResults, nodeId, (current) => ({
    ...current,
    translation_status: current.translation_status === "pending" ? "succeeded" : current.translation_status,
    materialization_status: "succeeded",
  }));
}

export function markNodeMaterializationFailed(
  nodeResults: JobNodeExecutionResultMap,
  nodeId: string,
  failureReasonCode: string
): void {
  updateNodeResult(nodeResults, nodeId, (current) => ({
    ...current,
    translation_status: current.translation_status === "pending" ? "succeeded" : current.translation_status,
    materialization_status: "failed",
    failure_reason_code: failureReasonCode,
    write_status: "skipped",
  }));
}

export function markNodeWriteSucceeded(
  nodeResults: JobNodeExecutionResultMap,
  nodeId: string
): void {
  updateNodeResult(nodeResults, nodeId, (current) => ({
    ...current,
    write_status: "succeeded",
    output_visible: true,
  }));
}

export function markNodeWriteFailed(
  nodeResults: JobNodeExecutionResultMap,
  nodeId: string,
  failureReasonCode: string
): void {
  updateNodeResult(nodeResults, nodeId, (current) => ({
    ...current,
    write_status: "failed",
    failure_reason_code: failureReasonCode,
  }));
}

export function countSuccessfulBodyNodes(
  nodeResults: JobNodeExecutionResultMap,
  slideIndex: number
): number {
  return countMatchingNodes(
    nodeResults,
    slideIndex,
    (node) => node.node_kind === "body" && node.materialization_status === "succeeded"
  );
}

export function countSuccessfulNotesNodes(
  nodeResults: JobNodeExecutionResultMap,
  slideIndex: number
): number {
  return countMatchingNodes(
    nodeResults,
    slideIndex,
    (node) => node.node_kind === "notes" && node.translation_status === "succeeded"
  );
}

export function countWrittenBodyNodes(
  nodeResults: JobNodeExecutionResultMap,
  slideIndex: number
): number {
  return countMatchingNodes(
    nodeResults,
    slideIndex,
    (node) => node.node_kind === "body" && node.write_status === "succeeded"
  );
}

export function countWrittenNotesNodes(
  nodeResults: JobNodeExecutionResultMap,
  slideIndex: number
): number {
  return countMatchingNodes(
    nodeResults,
    slideIndex,
    (node) => node.node_kind === "notes" && node.write_status === "succeeded"
  );
}

export function countFailedBodyNodes(
  nodeResults: JobNodeExecutionResultMap,
  slideIndex: number
): number {
  return countMatchingNodes(
    nodeResults,
    slideIndex,
    (node) =>
      node.node_kind === "body" &&
      (node.translation_status === "failed" ||
        node.materialization_status === "failed" ||
        node.write_status === "failed")
  );
}

export function countFailedNotesNodes(
  nodeResults: JobNodeExecutionResultMap,
  slideIndex: number
): number {
  return countMatchingNodes(
    nodeResults,
    slideIndex,
    (node) =>
      node.node_kind === "notes" &&
      (node.translation_status === "failed" ||
        node.write_status === "failed")
  );
}

export function countNodesByKind(
  nodes: readonly SlideTextNode[],
  nodeKind: NodeKind
): number {
  return nodes.filter((node) =>
    nodeKind === "notes" ? node.element_type === "speaker_notes" : node.element_type !== "speaker_notes"
  ).length;
}

export function listNodeIdsForSlide(
  nodeResults: JobNodeExecutionResultMap,
  slideIndex: number,
  nodeKind: NodeKind
): string[] {
  return listJobNodeResults(nodeResults)
    .filter((node) => node.slide_index === slideIndex && node.node_kind === nodeKind)
    .map((node) => node.node_id);
}

function countMatchingNodes(
  nodeResults: JobNodeExecutionResultMap,
  slideIndex: number,
  predicate: (node: JobNodeExecutionResult) => boolean
): number {
  let count = 0;
  for (const node of nodeResults.values()) {
    if (node.slide_index === slideIndex && predicate(node)) {
      count += 1;
    }
  }
  return count;
}

function updateNodeResult(
  nodeResults: JobNodeExecutionResultMap,
  nodeId: string,
  updater: (current: JobNodeExecutionResult) => JobNodeExecutionResult
): void {
  const current = nodeResults.get(nodeId);
  if (!current) {
    return;
  }
  nodeResults.set(nodeId, updater(current));
}
