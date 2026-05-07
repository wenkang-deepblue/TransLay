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
  "rolled_back",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_PAUSE_STATUSES = ["pausing", "paused"] as const;
export type JobPauseStatus = (typeof JOB_PAUSE_STATUSES)[number];

/** Statuses that indicate a job is still in progress (not terminal). */
export type JobInProgressStatus = "pending" | "queued" | "extracting" | "translating" | "writing";
export type JobLiveStatus = JobInProgressStatus | JobPauseStatus;

export const JOB_EXECUTION_STAGES = [
  "extract",
  "layout_semantics",
  "authority",
  "finalize",
] as const;
export type JobExecutionStage = (typeof JOB_EXECUTION_STAGES)[number];

export const JOB_STAGE_STATUSES = [
  "pending",
  "queued",
  "running",
  "completed",
] as const;
export type JobStageStatus = (typeof JOB_STAGE_STATUSES)[number];

export const JOB_WARNING_RISK_LEVELS = ["medium", "high"] as const;
export type JobWarningRiskLevel = (typeof JOB_WARNING_RISK_LEVELS)[number];

export const JOB_WARNING_REASONS = [
  "possible_overflow",
  "mixed_style_alignment_low_confidence",
  "bullet_structure_rebuilt_with_compaction",
  "single_line_policy_degraded",
  "layout_semantics_fallback_applied",
  "materialization_trailing_empty_suffix_accepted",
  "unsafe_slide_excluded",
  "manual_review_recommended",
  "slide_translation_failed",
  "slide_materialization_failed",
  "slide_write_failed",
  "slide_notes_translation_failed",
  "slide_notes_write_failed",
  "slide_partial_content_only",
  "slide_partial_notes_only",
  "slide_notes_truncated",
  "slide_charge_refunded",
] as const;
export type JobWarningReason = (typeof JOB_WARNING_REASONS)[number];

export const JOB_COMPLETION_CODES = ["PARTIAL_SUCCESS"] as const;
export type JobCompletionCode = (typeof JOB_COMPLETION_CODES)[number];

export const SLIDE_EXECUTION_STATUSES = [
  "pending",
  "excluded_unsafe",
  "translated",
  "committed",
  "skipped_translation_failed",
  "skipped_materialization_failed",
  "skipped_write_failed",
  "canceled_after_translation",
] as const;
export type SlideExecutionStatus = (typeof SLIDE_EXECUTION_STATUSES)[number];

export const SLIDE_FAILURE_STAGES = [
  "extract",
  "authority",
  "materialization",
  "write",
] as const;
export type SlideFailureStage = (typeof SLIDE_FAILURE_STAGES)[number];

/**
 * Slide-level execution truth tracked in-memory by the worker.
 * Phase 4B.1 freezes failure attribution to slide boundaries before
 * provisional billing, refunds, and API exposure are implemented.
 */
export interface JobSlideResult {
  readonly slide_index: number;
  readonly source_slide_object_id?: string;
  readonly source_slide_fingerprint?: string;
  readonly status: SlideExecutionStatus;
  readonly failure_stage?: SlideFailureStage;
  readonly failure_reason_code?: string;
  readonly warning_codes: readonly string[];
  readonly provisionally_billed: boolean;
  readonly final_billable: boolean;
  readonly refund_required: boolean;
  readonly refunded: boolean;
  readonly output_visible: boolean;
  readonly output_slide_object_id?: string;
  readonly notes_present?: boolean;
  readonly content_translated?: boolean;
  readonly notes_translated?: boolean;
  readonly content_output_visible?: boolean;
  readonly notes_output_visible?: boolean;
  readonly notes_truncated?: boolean;
  readonly body_node_count?: number;
  readonly notes_node_count?: number;
  readonly body_translated_node_count?: number;
  readonly notes_translated_node_count?: number;
  readonly body_failed_node_count?: number;
  readonly notes_failed_node_count?: number;
  readonly body_written_node_count?: number;
  readonly notes_written_node_count?: number;
  readonly provisional_billed_units?: number;
  readonly final_billed_units?: number;
  readonly refunded_units?: number;
}

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

export const DRIVE_CLEANUP_STATUSES = [
  "not_required",
  "pending",
  "succeeded",
  "failed",
] as const;
export type DriveCleanupStatus = (typeof DRIVE_CLEANUP_STATUSES)[number];

export interface DriveAccessMetadata {
  readonly source_worker_permission_id?: string;
  readonly target_worker_permission_id?: string;
}

/** POST /api/jobs request body. */
export interface CreateJobRequest {
  readonly host_type: HostType;
  readonly document_id: string;
  readonly document_name: string;
  readonly target_document_id?: string;
  readonly drive_access?: DriveAccessMetadata;
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

export interface JobQuotaPartialOption {
  readonly ok: false;
  readonly error: "QUOTA_INSUFFICIENT_WITH_PARTIAL_OPTION";
  readonly message: string;
  readonly required_units: number;
  readonly available_units: number;
  readonly allowed_range_expression: string;
  readonly excluded_range_expression: string;
  readonly cta: {
    readonly upgrade_subscription: boolean;
    readonly buy_credits: boolean;
  };
}

export interface JobQuotaPreviewAccepted {
  readonly ok: true;
  readonly required_units: number;
  readonly available_units: number;
  readonly accepted_range_expression: string;
}

export type JobQuotaPreviewResponse =
  | JobQuotaPreviewAccepted
  | JobQuotaPartialOption;

export interface JobDriveCleanupSnapshot {
  readonly drive_cleanup_status?: DriveCleanupStatus;
  readonly drive_cleanup_attempts?: number;
  readonly drive_cleanup_last_error_code?: string;
}

/** GET /api/jobs/:jobId — in-progress response (status is NOT completed or failed). */
export interface JobProgressResponse extends JobDriveCleanupSnapshot {
  readonly job_id: string;
  readonly status: JobLiveStatus;
  readonly progress_percent: number;
  readonly current_stage?: JobExecutionStage;
  readonly stage_status?: JobStageStatus;
  readonly stage_attempt?: number;
  readonly current_step?: string;
  readonly details?: string;
  readonly translated_units_billed?: number;
}

/** GET /api/jobs/:jobId — completed response. */
export interface JobCompletedResponse extends JobDriveCleanupSnapshot {
  readonly job_id: string;
  readonly status: "completed" | "completed_with_warnings";
  readonly completion_code?: JobCompletionCode;
  readonly progress_percent: 100;
  readonly output_document_url: string;
  readonly message: string;
  readonly fully_delivered_body_slide_indices: readonly number[];
  readonly content_only_slide_indices: readonly number[];
  readonly notes_only_slide_indices: readonly number[];
  readonly body_partial_slide_indices: readonly number[];
  readonly skipped_slide_indices: readonly number[];
  readonly refunded_slide_indices: readonly number[];
  readonly total_billed_units: number;
  readonly gross_billed_slides: number;
  readonly refunded_slides: number;
  readonly net_billed_slides: number;
  readonly warnings?: readonly JobWarning[];
}

/** GET /api/jobs/:jobId — canceled response. */
export interface JobCanceledResponse extends JobDriveCleanupSnapshot {
  readonly job_id: string;
  readonly status: "canceled";
  readonly message: string;
  readonly total_units_billed: number;
  readonly output_mode: OutputMode;
  readonly output_document_url?: string;
}

/** GET /api/jobs/:jobId — failed response. */
export interface JobFailedResponse extends JobDriveCleanupSnapshot {
  readonly job_id: string;
  readonly status: "failed";
  readonly error: string;
  readonly message: string;
  readonly output_document_url?: string;
  readonly fully_delivered_body_slide_indices?: readonly number[];
  readonly content_only_slide_indices?: readonly number[];
  readonly notes_only_slide_indices?: readonly number[];
  readonly body_partial_slide_indices?: readonly number[];
  readonly skipped_slide_indices?: readonly number[];
  readonly refunded_slide_indices?: readonly number[];
  readonly total_billed_units?: number;
  readonly gross_billed_slides?: number;
  readonly refunded_slides?: number;
  readonly net_billed_slides?: number;
  readonly warnings?: readonly JobWarning[];
}

export type JobStatusResponse =
  | JobProgressResponse
  | JobCompletedResponse
  | JobCanceledResponse
  | JobFailedResponse;

/** POST /api/jobs/:jobId/drive-cleanup and /api/jobs/cleanup-pending response. */
export interface DriveCleanupRetryResponse {
  readonly job_id: string | null;
  readonly drive_cleanup_status: Extract<DriveCleanupStatus, "not_required" | "succeeded" | "failed">;
  readonly drive_cleanup_attempts: number;
  readonly drive_cleanup_last_error_code?: string;
  readonly message: string;
}

/** POST /api/jobs/:jobId/cancel response. */
export interface CancelJobResponse extends JobDriveCleanupSnapshot {
  readonly job_id: string;
  readonly status: "cancel_requested" | "canceled" | "already_completed" | "already_failed" | "already_canceled";
  readonly message: string;
}

/** POST /api/jobs/:jobId/pause response. */
export interface PauseJobResponse {
  readonly job_id: string;
  readonly status:
    | "pause_requested"
    | "paused"
    | "already_completed"
    | "already_failed"
    | "already_canceled";
  readonly message: string;
}

/** POST /api/jobs/:jobId/resume response. */
export interface ResumeJobResponse {
  readonly job_id: string;
  readonly status:
    | "resumed"
    | "already_running"
    | "already_completed"
    | "already_failed"
    | "already_canceled";
  readonly message: string;
}

/** Cloud Tasks payload (internal, not public API). */
export interface TaskPayload {
  readonly job_id: string;
  readonly attempt: number;
  readonly requested_at: string;
  readonly expected_stage?: JobExecutionStage;
  readonly stage_attempt?: number;
}
