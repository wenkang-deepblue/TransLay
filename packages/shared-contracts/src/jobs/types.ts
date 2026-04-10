import type { TranslationNodeArchetype } from "../provider/types";

export const HOST_TYPES = ["docs", "sheets", "slides"] as const;
export type HostType = (typeof HOST_TYPES)[number];

export const OUTPUT_MODES = ["append_in_file", "create_new_file"] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

export const RANGE_MODES = ["current", "entire", "custom"] as const;
export type RangeMode = (typeof RANGE_MODES)[number];

export const SOURCE_LANGUAGE_MODES = ["auto"] as const;
export type SourceLanguageMode = (typeof SOURCE_LANGUAGE_MODES)[number];

export const JOB_STATUSES = [
  "pending",
  "queued",
  "extracting",
  "translating",
  "writing",
  "completed",
  "completed_with_warnings",
  "failed",
  "canceled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses that indicate a job is still in progress (not terminal). */
export type JobInProgressStatus = "pending" | "queued" | "extracting" | "translating" | "writing";

export const JOB_WARNING_RISK_LEVELS = ["medium", "high"] as const;
export type JobWarningRiskLevel = (typeof JOB_WARNING_RISK_LEVELS)[number];

export const JOB_WARNING_REASONS = [
  "possible_overflow",
  "mixed_style_alignment_low_confidence",
  "bullet_structure_rebuilt_with_compaction",
  "manual_review_recommended",
] as const;
export type JobWarningReason = (typeof JOB_WARNING_REASONS)[number];

/** Structured warning metadata exposed to clients without persisting document content. */
export interface JobWarning {
  readonly node_id: string;
  readonly slide_index: number;
  readonly archetype: TranslationNodeArchetype;
  readonly risk_level: JobWarningRiskLevel;
  readonly risk_reason: JobWarningReason;
}

export const SEGMENT_TYPES = ["extract", "translate", "write"] as const;
export type SegmentType = (typeof SEGMENT_TYPES)[number];

export const SEGMENT_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
] as const;
export type SegmentStatus = (typeof SEGMENT_STATUSES)[number];

export const USAGE_UNITS = ["pages", "cells", "slides"] as const;
export type UsageUnit = (typeof USAGE_UNITS)[number];

/** POST /api/jobs request body. */
export interface CreateJobRequest {
  readonly host_type: HostType;
  readonly document_id: string;
  readonly document_name: string;
  readonly target_document_id?: string;
  readonly resubmit?: boolean;
  readonly source_language_mode: SourceLanguageMode;
  readonly target_language_input: string;
  readonly output_mode: OutputMode;
  readonly range_mode: RangeMode;
  readonly range_expression?: string;
  readonly idempotency_key: string;
}

/** POST /api/jobs response. */
export interface CreateJobResponse {
  readonly status: "accepted";
  readonly job_id: string;
  readonly queued: boolean;
}

/** GET /api/jobs/:jobId — in-progress response (status is NOT completed or failed). */
export interface JobProgressResponse {
  readonly job_id: string;
  readonly status: JobInProgressStatus;
  readonly progress_percent: number;
  readonly current_step?: string;
  readonly details?: string;
}

/** GET /api/jobs/:jobId — completed response. */
export interface JobCompletedResponse {
  readonly job_id: string;
  readonly status: "completed" | "completed_with_warnings";
  readonly progress_percent: 100;
  readonly output_document_url: string;
  readonly message: string;
  readonly warnings?: readonly JobWarning[];
}

/** GET /api/jobs/:jobId — canceled response. */
export interface JobCanceledResponse {
  readonly job_id: string;
  readonly status: "canceled";
  readonly message: string;
  readonly total_units_billed: number;
  readonly output_mode: OutputMode;
  readonly output_document_url?: string;
}

/** GET /api/jobs/:jobId — failed response. */
export interface JobFailedResponse {
  readonly job_id: string;
  readonly status: "failed";
  readonly error: string;
  readonly message: string;
}

export type JobStatusResponse =
  | JobProgressResponse
  | JobCompletedResponse
  | JobCanceledResponse
  | JobFailedResponse;

/** POST /api/jobs/:jobId/cancel response. */
export interface CancelJobResponse {
  readonly job_id: string;
  readonly status: "cancel_requested" | "canceled" | "already_completed" | "already_failed" | "already_canceled";
  readonly message: string;
}

/** Cloud Tasks payload (internal, not public API). */
export interface TaskPayload {
  readonly job_id: string;
  readonly attempt: number;
  readonly requested_at: string;
}
