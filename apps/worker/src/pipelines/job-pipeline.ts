import type { Pool, PoolClient } from "pg";
import type Redis from "ioredis";
import type { WorkerConfig } from "@translay/shared-config";
import type {
  AuthorityTranslationResponse,
  AuthorityTranslationNode,
  JobExecutionStage,
  JobSlideResult,
  JobWarning,
  TaskPayload,
  TranslationContextGlossaryCandidate,
  TranslationResponse,
  TranslatedNode,
} from "@translay/shared-contracts";
import {
  matchPresetLanguage,
  billingPeriodKey,
  getHostLimit,
  getQuotaLimits,
  parsePageRange,
  buildJobCancelKey,
  buildJobPauseKey,
  resolveModelTargetLanguage,
  validateTargetLanguageOutput,
} from "@translay/shared-domain";
import {
  claimJobStageLease,
  getJobById,
  heartbeatJobStage,
  isCancelRequested,
  updateJobStatus,
} from "../repositories/job-repo";
import { cleanupDriveWorkerPermissionsForJob } from "../adapters/drive/permissions";
import { upsertJobSlideResults } from "../repositories/job-slide-result-repo";
import { upsertJobNodeResults } from "../repositories/job-node-result-repo";
import {
  listJobLayoutSemanticHints,
  replaceJobLayoutSemanticHintsForSlide,
} from "../repositories/job-layout-semantic-hint-repo";
import {
  getActivePlanForUser,
  getUsageBeforeJob,
  insertUsageLedger,
} from "../repositories/usage-repo";
import { consumeCredits } from "../repositories/credit-repo";
import { setJobProgress } from "../cache/job-progress";
import {
  extractSlides,
  writeBackAppend,
  writeBackExistingSlides,
  writeBackNewFile,
  type ExistingSlideWriteTarget,
  type SlideTextNode,
} from "../adapters/slides";
import {
  annotateSlidesWithLayoutSemanticsBestEffort,
  annotateSlidesWithLayoutSemanticsBestEffortOnDemand,
  annotateSlidesWithPersistedLayoutHints,
} from "../adapters/slides/layout-semantics";
import {
  buildLayoutSemanticInputs,
  validateSlideLayoutHints,
} from "../adapters/slides/layout-semantics";
import {
  buildDeckStoryboard,
  buildSingleSlideStoryboardFrame,
  selectSlidingWindowSlides,
} from "../adapters/slides/storyboard";
import { isUserTokenAuthError } from "../adapters/slides/auth";
import type { WriteBackResult } from "../adapters/slides";
import { selectRoute } from "../providers/router";
import {
  fillMissingAuthorityWithVertexGemini,
  materializeTranslatedNodesWithVertexGemini,
  translateSpeakerNotesWithVertexGemini,
  translateDeckAuthorityWithVertexGemini,
} from "../providers/vertex-gemini-authority";
import { requestSlideLayoutSemanticsWithVertexGemini } from "../providers/vertex-gemini-layout";
import type { LlmDebugCaptureFn } from "../providers/llm-debug";
import {
  scanNodesForPromptInjectionRisk,
  scanSlidesForPromptInjectionRisk,
} from "../providers/llm-prompt-safety";
import { enqueueStageTask } from "../tasks/cloud-tasks";
import {
  extractGlossaryCandidates,
  projectNodesToContextSummaries,
} from "./context-pack";
import {
  auditAuthorityCoverage,
  buildMaterializationGroups,
  explodeMaterializationGroup,
  mergeAuthorityNodes,
  projectNodesToAuthoritySourceNodes,
} from "./authority";
import {
  initializeJobSlideResults,
  listJobSlideResults,
  markNotesCommitted,
  markNotesFailure,
  markNotesTranslated,
  markSlideCanceledAfterTranslation,
  markSlideExcludedUnsafe,
  markSlideFailure,
  markSlideCommitted,
  markSlideTranslated,
} from "./slide-results";
import {
  countFailedBodyNodes,
  countFailedNotesNodes,
  countSuccessfulBodyNodes,
  countSuccessfulNotesNodes,
  countWrittenBodyNodes,
  countWrittenNotesNodes,
  initializeJobNodeResults,
  listJobNodeResults,
  markNodeMaterializationFailed,
  markNodeMaterializationSucceeded,
  markNodeTranslationFailed,
  markNodeTranslationSucceeded,
  markNodeWriteFailed,
  markNodeWriteSucceeded,
  type JobNodeExecutionResultMap,
} from "./node-results";

const MAX_PROVIDER_ATTEMPTS_PER_BATCH = 3;
const PROVIDER_RETRY_BASE_DELAY_MS = 500;
const PROVIDER_RETRY_MAX_DELAY_MS = 2_000;
const SPEAKER_NOTES_MAX_CHARS_PER_SLIDE = 5_000;
const AUTHORITY_CHUNK_HEARTBEAT_INTERVAL_MS = 20_000;
const PAUSE_POLL_INTERVAL_MS = 1_000;
const PAUSE_HEARTBEAT_INTERVAL_MS = 15_000;
let cleanupTerminalDrivePermissions = cleanupDriveWorkerPermissionsForJob;

type SlideBillingSettlementMode = "successful" | "failed" | "canceled";

type SlideBillingSettlement = {
  provisionally_billed_units: number;
  gross_billed_slides: number;
  refunded_slides: number;
  net_billed_slides: number;
  provisional_slide_indices: number[];
  refunded_slide_indices: number[];
  provisional_units_by_slide: ReadonlyMap<number, number>;
  refunded_units_by_slide: ReadonlyMap<number, number>;
};

type NotesTranslationPreparedSlide = {
  readonly slide_index: number;
  readonly body_nodes: readonly SlideTextNode[];
  readonly note_nodes: readonly SlideTextNode[];
  readonly truncated_note_nodes: readonly SlideTextNode[];
  readonly notes_truncated: boolean;
  readonly notes_prompt_blocked: boolean;
};

type NotesTranslationOutcome =
  | {
      readonly slide_index: number;
      readonly translated_nodes: readonly TranslatedNode[];
      readonly prepared_slide: NotesTranslationPreparedSlide;
      readonly provider_request_id: string;
    }
  | {
      readonly slide_index: number;
      readonly translated_nodes: readonly TranslatedNode[];
      readonly prepared_slide: NotesTranslationPreparedSlide;
      readonly failure_reason_code: string;
      readonly blocked: boolean;
    };

type TerminalDriveCleanupUpdate = {
  readonly driveCleanupStatus?: "not_required" | "succeeded" | "failed";
  readonly driveCleanupLastErrorCode?: string | null;
  readonly incrementDriveCleanupAttempts?: boolean;
};

/**
 * Stage dispatcher for the translation worker.
 */
export async function runJobPipeline(
  pool: Pool,
  redis: Redis,
  config: WorkerConfig,
  payload: TaskPayload
): Promise<void> {
  const { job_id, expected_stage, stage_attempt } = payload;
  const job = await getJobById(pool, job_id);
  if (!job) {
    console.error(`Job ${job_id} not found in database`);
    return;
  }

  if (isTerminalStatus(job.status)) {
    console.log(`Job ${job_id} already finalized with status ${job.status}, noop`);
    return;
  }

  const currentStage = job.current_stage ?? "extract";
  const currentStageAttempt = job.stage_attempt > 0 ? job.stage_attempt : 1;
  if (expected_stage && expected_stage !== currentStage) {
    console.log(
      `Job ${job_id} received stale stage task for ${expected_stage}, current stage is ${currentStage}, noop`
    );
    return;
  }
  if (stage_attempt !== undefined && stage_attempt !== currentStageAttempt) {
    console.log(
      `Job ${job_id} received stale stage attempt ${stage_attempt}, current attempt is ${currentStageAttempt}, noop`
    );
    return;
  }

  const leaseOutcome = await claimJobStageLease(
    pool,
    job_id,
    currentStage,
    currentStageAttempt,
    getStageLeaseSeconds(currentStage)
  );
  if (leaseOutcome.status === "stale") {
    console.log(`Job ${job_id} stage ${currentStage} became stale before lease claim, noop`);
    return;
  }
  if (leaseOutcome.status === "busy") {
    throw new StageLeaseBusyError(job_id, currentStage, leaseOutcome.leaseExpiresAt);
  }

  switch (currentStage) {
    case "extract":
      await runExtractStage(pool, redis, config, job_id, currentStageAttempt);
      return;
    case "layout_semantics":
      await runLayoutStage(pool, redis, config, job_id, currentStageAttempt);
      return;
    case "authority":
      await runAuthorityStage(pool, redis, config, payload);
      return;
    case "finalize":
      throw new PipelineError(
        "JOB_INTERNAL_ERROR",
        "Unexpected finalize stage dispatch without inline finalization support"
      );
    default:
      throw new PipelineError("JOB_INTERNAL_ERROR", `Unsupported stage: ${currentStage}`);
  }
}

async function runExtractStage(
  pool: Pool,
  redis: Redis,
  config: WorkerConfig,
  jobId: string,
  stageAttempt: number
): Promise<void> {
  const job = await getJobById(pool, jobId);
  if (!job) {
    return;
  }

  let slideResults = initializeJobSlideResults([]);
  const emptyWriteResult: WriteBackResult = {
    outputUrl: "",
    committedUnits: 0,
    committed_slide_indexes: [],
    failed_slide_indexes: [],
    slide_results: [],
    warnings: [],
  };

  try {
    await updateJobStatus(pool, jobId, "extracting", {
      currentStage: "extract",
      stageStatus: "running",
    });
    await setJobProgress(redis, jobId, {
      status: "extracting",
      progress_percent: 5,
      current_step: "extracting_content",
      details: "Extracting presentation content",
    });
    await assertNotCanceled(pool, redis, job, emptyWriteResult, 0);

    if (job.host_type !== "slides") {
      throw new PipelineError(
        "HOST_ADAPTER_ERROR",
        `Host type "${job.host_type}" is not yet supported`
      );
    }

    const pageIndices = resolvePageIndices(job);
    const extraction = await extractSlides(job.source_doc_id, pageIndices, {
      pool,
      jobId,
    });
    if (extraction.all_nodes.length === 0) {
      throw new PipelineError(
        "HOST_ADAPTER_ERROR",
        "No translatable text found in the selected slides"
      );
    }

    const preparedSlides = prepareSlidesForDecoupledNotes(extraction.extracted_slides);
    const bodyPromptInjectionScan = scanSlidesForPromptInjectionRisk(
      preparedSlides
        .filter((slide) => slide.body_nodes.length > 0)
        .map((slide) => ({
          slide_index: slide.slide_index,
          slide_object_id: extraction.extracted_slides.find(
            (item) => item.slide_index === slide.slide_index
          )?.slide_object_id ?? `slide_${slide.slide_index}`,
          nodes: [...slide.body_nodes],
        }))
    );
    const notesPresentSlideIndices = extraction.extracted_slides
      .filter((slide) => slide.nodes.some((node) => node.element_type === "speaker_notes"))
      .map((slide) => slide.slide_index);
    slideResults = initializeJobSlideResults(
      extraction.extracted_slides,
      { notesPresentSlideIndices }
    );
    for (const slideIndex of bodyPromptInjectionScan.hard_block_slide_indices) {
      markSlideExcludedUnsafe(slideResults, slideIndex);
    }
    const client = await pool.connect();
    try {
      await upsertJobSlideResults(client, jobId, listJobSlideResults(slideResults));
    } finally {
      client.release();
    }

    const nextStagePayload = {
      selected_slide_indices:
        pageIndices ?? extraction.extracted_slides.map((slide) => slide.slide_index),
      safe_slide_indices: extraction.extracted_slides
        .map((slide) => slide.slide_index)
        .filter((slideIndex) => !bodyPromptInjectionScan.hard_block_slide_indices.includes(slideIndex)),
      excluded_slide_indices: bodyPromptInjectionScan.hard_block_slide_indices,
      notes_present_slide_indices: notesPresentSlideIndices,
      total_selected_slides: extraction.extracted_slides.length,
    };

    await scheduleNextStage(
      pool,
      config,
      jobId,
      "layout_semantics",
      stageAttempt + 1,
      nextStagePayload
    );
    await setJobProgress(redis, jobId, {
      status: "queued",
      progress_percent: 15,
      current_step: "layout_semantics",
      details: `Queued layout analysis for ${nextStagePayload.safe_slide_indices.length} safe slide(s)`,
    });
  } catch (error) {
    if (error instanceof CancellationRequestedError) {
      await finalizeCanceledJob(pool, redis, job, jobId, emptyWriteResult, 0, slideResults);
      return;
    }

    const safeMessage = toSafePipelineMessage(error, "Extraction stage failed before translation started.");
    await finalizeFailedJob(
      pool,
      redis,
      job,
      jobId,
      emptyWriteResult,
      [],
      0,
      slideResults,
      toSlideFailureReasonCode(error),
      safeMessage
    );
  }
}

async function runLayoutStage(
  pool: Pool,
  redis: Redis,
  config: WorkerConfig,
  jobId: string,
  stageAttempt: number
): Promise<void> {
  const job = await getJobById(pool, jobId);
  if (!job) {
    return;
  }

  const emptyWriteResult: WriteBackResult = {
    outputUrl: "",
    committedUnits: 0,
    committed_slide_indexes: [],
    failed_slide_indexes: [],
    slide_results: [],
    warnings: [],
  };
  let slideResults = initializeJobSlideResults([]);

  try {
    await updateJobStatus(pool, jobId, "translating", {
      currentStage: "layout_semantics",
      stageStatus: "running",
    });
    await setJobProgress(redis, jobId, {
      status: "translating",
      progress_percent: 20,
      current_step: "layout_semantics",
      details: "Preparing layout analysis",
    });
    await assertNotCanceled(pool, redis, job, emptyWriteResult, 0);

    const pageIndices = asNumberArray(job.stage_payload.selected_slide_indices);
    const extraction = await extractSlides(
      job.source_doc_id,
      pageIndices.length > 0 ? pageIndices : resolvePageIndices(job),
      {
        pool,
        jobId,
      }
    );
    const notesPresentSlideIndices = asNumberArray(job.stage_payload.notes_present_slide_indices);
    slideResults = initializeJobSlideResults(
      extraction.extracted_slides,
      { notesPresentSlideIndices }
    );
    for (const slideIndex of asNumberArray(job.stage_payload.excluded_slide_indices)) {
      markSlideExcludedUnsafe(slideResults, slideIndex);
    }

    const safeSlideIndexSet = new Set(asNumberArray(job.stage_payload.safe_slide_indices));
    const safeSlides = extraction.extracted_slides.filter((slide) => safeSlideIndexSet.has(slide.slide_index));
    const completedSlideIndices = new Set(asNumberArray(job.stage_cursor.completed_slide_indices));
    const pendingSlides = safeSlides.filter((slide) => !completedSlideIndices.has(slide.slide_index));
    const route = selectRoute(config, job.user_id as string);
    const thumbnailCache = new Map();

    for (let offset = 0; offset < pendingSlides.length; offset += 3) {
      const batch = pendingSlides.slice(offset, offset + 3);
      await Promise.all(
        batch.map(async (slide) => {
          const thumbnail = await buildSingleSlideStoryboardFrame(job.source_doc_id, slide, {
            size: "LARGE",
            cache: thumbnailCache,
            pool,
            jobId,
          });
          const [input] = buildLayoutSemanticInputs(slide ? [slide] : [], {
            frames: [thumbnail],
          });
          if (!input) {
            completedSlideIndices.add(slide.slide_index);
            return;
          }
          try {
            const rawHints = await runProviderCallWithRetry(
              `layout_semantics_slide_${input.slide_index + 1}`,
              () =>
                requestSlideLayoutSemanticsWithVertexGemini(config, {
                  model: route.model,
                  ...input,
                  debugLabel: `layout_semantics:slide_${input.slide_index + 1}`,
                })
            );
            const validatedHints = validateSlideLayoutHints(
              input,
              Array.isArray(rawHints) ? rawHints : []
            );
            await replaceJobLayoutSemanticHintsForSlide(
              pool,
              jobId,
              input.slide_index,
              validatedHints
            );
          } catch (error) {
            console.warn(
              `Layout semantics persisted fallback applied for slide ${input.slide_index + 1}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
            await replaceJobLayoutSemanticHintsForSlide(pool, jobId, input.slide_index, []);
          }
          completedSlideIndices.add(input.slide_index);
        })
      );

      await heartbeatJobStage(
        pool,
        jobId,
        "layout_semantics",
        stageAttempt,
        getStageLeaseSeconds("layout_semantics")
      );
      await updateJobStatus(pool, jobId, "translating", {
        stageCursor: {
          completed_slide_indices: [...completedSlideIndices].sort((a, b) => a - b),
          completed_slide_count: completedSlideIndices.size,
          total_slide_count: safeSlides.length,
        },
      });
      await setJobProgress(redis, jobId, {
        status: "translating",
        progress_percent: 20 + Math.round((completedSlideIndices.size / Math.max(safeSlides.length, 1)) * 20),
        current_step: "layout_semantics",
        details: `Analyzed layout for ${completedSlideIndices.size}/${safeSlides.length} safe slide(s)`,
      });
    }

    const client = await pool.connect();
    try {
      await upsertJobSlideResults(client, jobId, listJobSlideResults(slideResults));
    } finally {
      client.release();
    }
    await scheduleNextStage(pool, config, jobId, "authority", stageAttempt + 1, {
      ...job.stage_payload,
      layout_slide_count: safeSlides.length,
    });
    await setJobProgress(redis, jobId, {
      status: "queued",
      progress_percent: 40,
      current_step: "authority_pass",
      details: `Queued deck-level authority translation for ${safeSlides.length} safe slide(s)`,
    });
  } catch (error) {
    if (error instanceof CancellationRequestedError) {
      await finalizeCanceledJob(pool, redis, job, jobId, emptyWriteResult, 0, slideResults);
      return;
    }

    const safeMessage = toSafePipelineMessage(error, "Layout analysis stage failed before translation started.");
    await finalizeFailedJob(
      pool,
      redis,
      job,
      jobId,
      emptyWriteResult,
      [],
      0,
      slideResults,
      toSlideFailureReasonCode(error),
      safeMessage
    );
  }
}

async function scheduleNextStage(
  pool: Pool,
  config: WorkerConfig,
  jobId: string,
  nextStage: JobExecutionStage,
  nextStageAttempt: number,
  stagePayload: Record<string, unknown>
): Promise<void> {
  await updateJobStatus(pool, jobId, "queued", {
    currentStage: nextStage,
    stageStatus: "queued",
    stageAttempt: nextStageAttempt,
    stagePayload,
    stageCursor: {},
    stageLeaseExpiresAt: null,
    stageLastHeartbeatAt: null,
    queuedTaskName: null,
  });
  const queuedTaskName = await enqueueStageTask(config, jobId, nextStage, nextStageAttempt);
  await updateJobStatus(pool, jobId, "queued", {
    queuedTaskName,
  });
}

function resolvePageIndices(
  job: NonNullable<Awaited<ReturnType<typeof getJobById>>>
): number[] | null {
  if (job.range_mode === "custom" && job.range_expression) {
    const pageIndices = parsePageRange(job.range_expression);
    if (!pageIndices) {
      throw new PipelineError("INVALID_RANGE", "Failed to parse range expression");
    }
    return pageIndices;
  }

  if (job.range_mode === "current" && job.range_expression) {
    const parsed = parseInt(job.range_expression, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return [parsed];
    }
  }

  return null;
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "number" ? item : Number.parseInt(String(item), 10)))
    .filter((item) => Number.isInteger(item) && item >= 0);
}

function getStageLeaseSeconds(stage: JobExecutionStage): number {
  switch (stage) {
    case "extract":
      return 600;
    case "layout_semantics":
      return 900;
    case "authority":
      return 1800;
    case "finalize":
      return 300;
  }
}

async function withAuthorityChunkHeartbeat<T>(
  pool: Pool,
  jobId: string,
  stageAttempt: number,
  nodes: readonly { readonly node_id: string }[],
  run: () => Promise<T>
): Promise<T> {
  await heartbeatJobStage(
    pool,
    jobId,
    "authority",
    stageAttempt,
    getStageLeaseSeconds("authority")
  );

  let heartbeatInFlight: Promise<void> | null = null;
  const interval = setInterval(() => {
    if (heartbeatInFlight) {
      return;
    }
    heartbeatInFlight = heartbeatJobStage(
      pool,
      jobId,
      "authority",
      stageAttempt,
      getStageLeaseSeconds("authority")
    )
      .catch((error) => {
        console.warn(
          `Authority heartbeat loop failed for job ${jobId} while processing ${nodes.length} node(s): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      })
      .finally(() => {
        heartbeatInFlight = null;
      });
  }, AUTHORITY_CHUNK_HEARTBEAT_INTERVAL_MS);

  try {
    return await run();
  } finally {
    clearInterval(interval);
    await heartbeatJobStage(
      pool,
      jobId,
      "authority",
      stageAttempt,
      getStageLeaseSeconds("authority")
    );
  }
}

function isTerminalStatus(status: string): boolean {
  return (
    status === "completed" ||
    status === "completed_with_warnings" ||
    status === "failed" ||
    status === "canceled" ||
    status === "rolled_back"
  );
}

/**
 * Text-dependent authority/materialization/write segment.
 * This stage intentionally keeps deck-level authority + downstream delivery in
 * one execution segment so we never persist translated plaintext between tasks.
 */
async function runAuthorityStage(
  pool: Pool,
  redis: Redis,
  config: WorkerConfig,
  payload: TaskPayload
): Promise<void> {
  const { job_id } = payload;

  // Step 0: Load job metadata
  const job = await getJobById(pool, job_id);
  if (!job) {
    console.error(`Job ${job_id} not found in database`);
    return;
  }

  if (isTerminalStatus(job.status)) {
    console.log(`Job ${job_id} already finalized with status ${job.status}, skipping authority`);
    return;
  }

  const route = selectRoute(config, job.user_id as string);
  const targetLangCode =
    job.target_language_code ??
    matchPresetLanguage(job.target_language_input) ??
    job.target_language_input;
  const targetLanguageForModel = resolveModelTargetLanguage(job.target_language_input);
  console.log(`Job ${job_id} route selected: ${route.provider}/${route.model}`);
  // The llm_debug_outputs table and its raw-output capture path were removed;
  // debug capture is permanently disabled.
  const llmDebugCapture: LlmDebugCaptureFn | undefined = undefined;
  let writeResult: WriteBackResult = {
    outputUrl: "",
    committedUnits: 0,
    committed_slide_indexes: [],
    failed_slide_indexes: [],
    slide_results: [],
    warnings: [],
  };
  const pipelineWarnings: JobWarning[] = [];
  const provisionallyBilledSlideIndexes = new Set<number>();
  let provisionallyBilledUnits = 0;
  let slideResults = initializeJobSlideResults([]);
  let nodeResults: JobNodeExecutionResultMap | undefined;

  try {
    await assertNotCanceled(pool, redis, job, writeResult, provisionallyBilledUnits);

    // --- EXTRACTING ---
    console.log(`Job ${job_id} entering extracting stage`);
    await updateJobStatus(pool, job_id, "extracting", {
      providerRoute: { provider: route.provider, model: route.model, strategy: route.strategy },
    });
    await setJobProgress(redis, job_id, {
      status: "extracting",
      progress_percent: 10,
      current_step: "extracting_content",
      details: "Extracting presentation content",
    });
    await assertNotCanceled(pool, redis, job, writeResult, provisionallyBilledUnits);

    if (job.host_type !== "slides") {
      throw new PipelineError(
        "HOST_ADAPTER_ERROR",
        `Host type "${job.host_type}" is not yet supported`
      );
    }

    // Resolve page range
    let pageIndices: number[] | null = null;
    if (job.range_mode === "custom" && job.range_expression) {
      pageIndices = parsePageRange(job.range_expression);
      if (!pageIndices) {
        throw new PipelineError("INVALID_RANGE", "Failed to parse range expression");
      }
    } else if (job.range_mode === "current" && job.range_expression) {
      // Current slide: range_expression contains single page number
      const parsed = parseInt(job.range_expression, 10);
      if (!isNaN(parsed) && parsed > 0) {
        pageIndices = [parsed];
      }
    }
    // range_mode === "entire" → pageIndices stays null (all slides)

    const extraction = await extractSlides(job.source_doc_id, pageIndices, {
      pool,
      jobId: job_id,
    });
    console.log(
      `Job ${job_id} extraction completed: ${extraction.extracted_slides.length} slides, ${extraction.all_nodes.length} nodes`
    );

    if (extraction.all_nodes.length === 0) {
      throw new PipelineError(
        "HOST_ADAPTER_ERROR",
        "No translatable text found in the selected slides"
      );
    }

    const preparedSlides = prepareSlidesForDecoupledNotes(extraction.extracted_slides);
    const bodyPromptInjectionScan = scanSlidesForPromptInjectionRisk(
      preparedSlides
        .filter((slide) => slide.body_nodes.length > 0)
        .map((slide) => ({
          slide_index: slide.slide_index,
          slide_object_id: extraction.extracted_slides.find(
            (item) => item.slide_index === slide.slide_index
          )?.slide_object_id ?? `slide_${slide.slide_index}`,
          nodes: [...slide.body_nodes],
        }))
    );
    const notesPresentSlideIndices = extraction.extracted_slides
      .filter((slide) => slide.nodes.some((node) => node.element_type === "speaker_notes"))
      .map((slide) => slide.slide_index);
    slideResults = initializeJobSlideResults(
      extraction.extracted_slides,
      { notesPresentSlideIndices }
    );
    nodeResults = initializeJobNodeResults(extraction.extracted_slides);
    for (const slideIndex of bodyPromptInjectionScan.hard_block_slide_indices) {
      markSlideExcludedUnsafe(slideResults, slideIndex);
    }
    const excludedSlideIndices = new Set(bodyPromptInjectionScan.hard_block_slide_indices);
    const safeSlides = preparedSlides
      .filter(
        (slide) =>
          !excludedSlideIndices.has(slide.slide_index) &&
          slide.body_nodes.length > 0
      )
      .map((slide) => ({
        slide_index: slide.slide_index,
        slide_object_id: extraction.extracted_slides.find(
          (item) => item.slide_index === slide.slide_index
        )?.slide_object_id ?? `slide_${slide.slide_index}`,
        nodes: [...slide.body_nodes],
      }));
    const notesReadySlides = preparedSlides.filter(
      (slide) => slide.truncated_note_nodes.length > 0
    );
    pipelineWarnings.push(
      ...buildUnsafeSlideExcludedWarnings(extraction.extracted_slides, bodyPromptInjectionScan.hard_block_slide_indices)
    );
    if (safeSlides.length === 0 && notesReadySlides.length === 0) {
      const slideLabels = bodyPromptInjectionScan.hard_block_slide_indices.map((slideIndex) => slideIndex + 1);
      throw new PipelineError(
        "UNSAFE_LLM_INPUT",
        `All selected slides were excluded due to prompt-injection risk: ${slideLabels.join(", ")}`
      );
    }

    const extractionForTranslation = {
      ...extraction,
      extracted_slides: safeSlides,
      all_nodes: safeSlides.flatMap((slide) => slide.nodes),
      full_context_text: buildDeckPlaintextContext(safeSlides),
    };
    const totalSafeSlides = extractionForTranslation.extracted_slides.length;
    await assertNotCanceled(pool, redis, job, writeResult, provisionallyBilledUnits);

    // --- TRANSLATING ---
    console.log(`Job ${job_id} entering translating stage`);
    await updateJobStatus(pool, job_id, "translating");
    await setJobProgress(redis, job_id, {
      status: "translating",
      progress_percent: 30,
      current_step: "translating_segments",
      details:
        excludedSlideIndices.size > 0
          ? `Excluded ${excludedSlideIndices.size} risky slide(s); translating ${extractionForTranslation.all_nodes.length} text segments from ${totalSafeSlides} safe slide(s)`
          : `Translating ${extractionForTranslation.all_nodes.length} text segments`,
    });

    // Resolve target language code
    const deckPlaintextContext = extractionForTranslation.full_context_text;
    const providerRequestIds: string[] = [];
    const thumbnailCache = new Map();
    await heartbeatJobStage(pool, job_id, "authority", job.stage_attempt, getStageLeaseSeconds("authority"));
    const persistedLayoutHints = await listJobLayoutSemanticHints(pool, job_id);
    const slidesWithLayoutHints = persistedLayoutHints.length > 0
      ? annotateSlidesWithPersistedLayoutHints(
          extractionForTranslation.extracted_slides,
          persistedLayoutHints
        )
      : await annotateSlidesWithLayoutSemanticsBestEffortOnDemand(
          extractionForTranslation.extracted_slides,
          (slide) =>
            buildSingleSlideStoryboardFrame(job.source_doc_id, slide, {
              size: "LARGE",
              cache: thumbnailCache,
              pool,
              jobId: job_id,
            }),
          async (input) =>
            runProviderCallWithRetry(
              `layout_semantics_slide_${input.slide_index + 1}`,
              () =>
                requestSlideLayoutSemanticsWithVertexGemini(config, {
                  model: route.model,
                  ...input,
                  debugCapture: llmDebugCapture,
                  debugLabel: `layout_semantics:slide_${input.slide_index + 1}`,
                })
            )
        );
    const extractionWithLayoutHints = {
      ...extractionForTranslation,
      extracted_slides: slidesWithLayoutHints,
      all_nodes: slidesWithLayoutHints.flatMap((slide) => slide.nodes),
    };
    const glossaryCandidates = extractGlossaryCandidates(extractionWithLayoutHints.all_nodes);

    await setJobProgress(redis, job_id, {
      status: "translating",
      progress_percent: 38,
      current_step: "authority_pass",
      details: `Building authoritative deck translation for ${extractionWithLayoutHints.all_nodes.length} nodes`,
    });
    await assertNotCanceled(pool, redis, job, writeResult, provisionallyBilledUnits);

    let authorityResult: AuthorityTranslationResponse | null = null;
    let authorityNodes: AuthorityTranslationNode[] = [];
    let authorityReadySlides: typeof extractionWithLayoutHints.extracted_slides = [];
    if (extractionWithLayoutHints.all_nodes.length > 0) {
      try {
        const deckOverviewStoryboard = await buildDeckStoryboard(
          job.source_doc_id,
          extractionWithLayoutHints.extracted_slides,
          {
            size: "MEDIUM",
            cache: thumbnailCache,
            pool,
            jobId: job_id,
          }
        );
        authorityResult = await runProviderCallWithRetry("authority_batch_1", () =>
          translateDeckAuthorityWithVertexGemini(config, {
            model: route.model,
            source_language: "auto",
            target_language: targetLanguageForModel,
            deck_title: extractionWithLayoutHints.title,
            deck_plaintext_context: deckPlaintextContext,
            glossary_candidates: glossaryCandidates,
            nodes: projectNodesToAuthoritySourceNodes(extractionWithLayoutHints.all_nodes),
            visual_context: {
              deck_overview_frames: deckOverviewStoryboard.frames,
            },
            build_local_window_frames: async (nodes) => {
              const activeSlideIndices = uniqueSlideIndices(nodes);
              const localSlides = selectSlidingWindowSlides(
                extractionWithLayoutHints.extracted_slides,
                activeSlideIndices
              );
              return Promise.all(
                localSlides.map((slide) =>
                  buildSingleSlideStoryboardFrame(job.source_doc_id, slide, {
                    size: "LARGE",
                    cache: thumbnailCache,
                    pool,
                    jobId: job_id,
                  })
                )
              );
            },
            with_chunk_lifecycle: (nodes, run) =>
              withAuthorityChunkHeartbeat(
                pool,
                job_id,
                job.stage_attempt,
                nodes,
                run
              ),
            debugCapture: llmDebugCapture,
            debugLabel: "authority:deck",
          })
        );
      } catch (error) {
        if (toSlideFailureReasonCode(error) === "VERTEX_QUOTA_EXHAUSTED") {
          throw error;
        }
        console.warn(
          `Authority batch failed; falling back to slide-level recovery: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        console.warn(
          "[pipeline] fallback triggered",
          JSON.stringify({
            job_id: job_id,
            stage: "authority",
            mode: "slide_level_recovery",
            reason_code: toSlideFailureReasonCode(error),
          })
        );
      }
      if (authorityResult) {
        providerRequestIds.push(authorityResult.provider_request_id);
      }

      authorityNodes = [...(authorityResult?.nodes ?? [])];
      for (const authorityNode of authorityNodes) {
        markNodeTranslationSucceeded(nodeResults!, authorityNode.node_id);
      }
      let authorityAudit = auditAuthorityCoverage(extractionWithLayoutHints.all_nodes, authorityNodes);
      if (authorityAudit.missing_nodes.length > 0) {
        await setJobProgress(redis, job_id, {
          status: "translating",
          progress_percent: 45,
          current_step: "gap_fill",
          details: `Filling ${authorityAudit.missing_nodes.length} authority coverage gap(s)`,
        });
        await assertNotCanceled(pool, redis, job, writeResult, provisionallyBilledUnits);

        const missingNodesBySlide = groupNodesBySlide(authorityAudit.missing_nodes);
        const slideByIndex = new Map(
          extractionWithLayoutHints.extracted_slides.map((slide) => [slide.slide_index, slide])
        );
        const gapFilledNodes: AuthorityTranslationNode[] = [];

        for (const [slideIndex, missingNodes] of missingNodesBySlide) {
          const slide = slideByIndex.get(slideIndex);
          if (!slide) {
            for (const missingNode of missingNodes) {
              markNodeTranslationFailed(nodeResults!, missingNode.node_id, "JOB_INTERNAL_ERROR");
            }
            continue;
          }

          let gapFillResult: AuthorityTranslationResponse;
          try {
            const storyboardFrame = await buildSingleSlideStoryboardFrame(
              job.source_doc_id,
              slide,
              {
                size: "LARGE",
                cache: thumbnailCache,
                pool,
                jobId: job_id,
              }
            );
            gapFillResult = await runProviderCallWithRetry(
              `gap_fill_slide_${slideIndex + 1}`,
              () =>
                fillMissingAuthorityWithVertexGemini(config, {
                  model: route.model,
                  source_language: "auto",
                  target_language: targetLanguageForModel,
                  deck_title: extractionWithLayoutHints.title,
                  slide_index: slideIndex,
                  slide_plaintext_context: buildSlidePlaintextContext(slide),
                  glossary_candidates: glossaryCandidates,
                  existing_authority_nodes: authorityNodes,
                  missing_nodes: projectNodesToAuthoritySourceNodes(missingNodes),
                  storyboard_frame: storyboardFrame,
                  debugCapture: llmDebugCapture,
                  debugLabel: `authority_gap_fill:slide_${slideIndex + 1}`,
                })
            );
          } catch (error) {
            const failureReasonCode = toSlideFailureReasonCode(error);
            for (const missingNode of missingNodes) {
              markNodeTranslationFailed(nodeResults!, missingNode.node_id, failureReasonCode);
            }
            continue;
          }
          providerRequestIds.push(gapFillResult.provider_request_id);
          gapFilledNodes.push(...gapFillResult.nodes);
          for (const translatedNode of gapFillResult.nodes) {
            markNodeTranslationSucceeded(nodeResults!, translatedNode.node_id);
          }
          await assertNotCanceled(pool, redis, job, writeResult, provisionallyBilledUnits);
        }

        authorityNodes = mergeAuthorityNodes(authorityNodes, gapFilledNodes);
        authorityAudit = auditAuthorityCoverage(extractionWithLayoutHints.all_nodes, authorityNodes);
      }

      if (authorityAudit.missing_nodes.length > 0) {
        for (const missingNode of authorityAudit.missing_nodes) {
          markNodeTranslationFailed(nodeResults!, missingNode.node_id, "LLM_PROVIDER_ERROR");
        }
      }

      authorityReadySlides = selectSlidesReadyForMaterialization(
        extractionWithLayoutHints.extracted_slides,
        slideResults
      );
      const authorityReadyNodeIds = new Set(
        authorityReadySlides.flatMap((slide) => slide.nodes.map((node) => node.node_id))
      );
      authorityNodes = authorityNodes.filter((node) => authorityReadyNodeIds.has(node.node_id));
    }

    const notesTranslationTasks = startSpeakerNotesTranslationTasks(
      config,
      route.model,
      targetLanguageForModel,
      extractionWithLayoutHints.title,
      glossaryCandidates,
      preparedSlides,
      authorityNodes,
      llmDebugCapture
    );

    const materializationGroups =
      authorityReadySlides.length > 0
        ? buildMaterializationGroups(authorityReadySlides, {
            maxNodesPerGroup: 10,
            maxCharsPerGroup: 2_000,
          })
        : [];
    const translatedNodes: TranslatedNode[] = [];
    const authorityById = new Map(
      authorityNodes.map((node) => [node.node_id, node])
    );
    const materializationQueue = [...materializationGroups];
    const pendingNodeIdsBySlide = buildPendingNodeIdsBySlide(
      authorityReadySlides.flatMap((slide) => slide.nodes)
    );

    for (let groupIndex = 0; groupIndex < materializationQueue.length; groupIndex += 1) {
      const group = materializationQueue[groupIndex];
      if (!group) {
        continue;
      }
      const groupSlideIndices = uniqueSlideIndices(group.node_summaries);
      if (
        groupSlideIndices.some((slideIndex) =>
          !isSlideReadyForMaterialization(slideResults, slideIndex)
        )
      ) {
        continue;
      }

      const authoritySubset = group.node_summaries.map((nodeSummary) => {
        const authorityNode = authorityById.get(nodeSummary.node_id);
        if (!authorityNode) {
          markNodeTranslationFailed(nodeResults!, nodeSummary.node_id, "JOB_INTERNAL_ERROR");
          return null;
        }
        return authorityNode;
      }).filter((node): node is AuthorityTranslationNode => node !== null);

      if (authoritySubset.length !== group.node_summaries.length) {
        continue;
      }

      let groupResult: TranslationResponse;
      try {
        groupResult = await runProviderCallWithRetry(
          `materialization_batch_${groupIndex + 1}`,
          () =>
            materializeTranslatedNodesWithVertexGemini(config, {
              model: route.model,
              source_language: "auto",
              target_language: targetLanguageForModel,
              deck_title: extractionWithLayoutHints.title,
              glossary_candidates: glossaryCandidates,
              node_summaries: group.node_summaries,
              authority_nodes: authoritySubset,
              debugCapture: llmDebugCapture,
              debugLabel: `materialization:batch_${groupIndex + 1}`,
            })
        );
      } catch (error) {
        if (shouldExplodeMaterializationGroup(group, error)) {
          const explodedGroups = explodeMaterializationGroup(group);
          console.warn(
            `Materialization batch ${groupIndex + 1} falling back to ${
              explodedGroups.length
            } single-node request(s): ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          console.warn(
            "[pipeline] fallback triggered",
            JSON.stringify({
              job_id: job_id,
              stage: "materialization",
              mode: "single_node_recovery",
              group_index: groupIndex + 1,
              fallback_request_count: explodedGroups.length,
              reason_code: toSlideFailureReasonCode(error),
            })
          );
          materializationQueue.splice(groupIndex, 1, ...explodedGroups);
          groupIndex -= 1;
          continue;
        }
        const failureReasonCode = toSlideFailureReasonCode(error);
        for (const nodeSummary of group.node_summaries) {
          markNodeMaterializationFailed(nodeResults!, nodeSummary.node_id, failureReasonCode);
        }
        continue;
      }

      try {
        validateTranslatedGroup(group.node_summaries, groupResult.nodes);
      } catch (error) {
        if (shouldExplodeMaterializationGroup(group, error)) {
          const explodedGroups = explodeMaterializationGroup(group);
          console.warn(
            "[pipeline] fallback triggered",
            JSON.stringify({
              job_id: job_id,
              stage: "materialization",
              mode: "single_node_recovery",
              group_index: groupIndex + 1,
              fallback_request_count: explodedGroups.length,
              reason_code: toSlideFailureReasonCode(error),
            })
          );
          materializationQueue.splice(groupIndex, 1, ...explodedGroups);
          groupIndex -= 1;
          continue;
        }
        const failureReasonCode = toSlideFailureReasonCode(error);
        for (const nodeSummary of group.node_summaries) {
          markNodeMaterializationFailed(nodeResults!, nodeSummary.node_id, failureReasonCode);
        }
        continue;
      }
      translatedNodes.push(...groupResult.nodes);
      providerRequestIds.push(groupResult.provider_request_id);
      for (const translatedNode of groupResult.nodes) {
        markNodeMaterializationSucceeded(nodeResults!, translatedNode.node_id);
      }

      const newlyTranslatedSlideIndexes = registerTranslatedNodesBySlide(
        pendingNodeIdsBySlide,
        group.node_summaries
      );
      for (const slideIndex of newlyTranslatedSlideIndexes) {
        markSlideTranslated(slideResults, slideIndex);
      }

      const billedBefore = provisionallyBilledUnits;
      provisionallyBilledUnits = registerBilledSlides(
        provisionallyBilledSlideIndexes,
        newlyTranslatedSlideIndexes
      );
      if (provisionallyBilledUnits !== billedBefore) {
        await updateJobStatus(pool, job_id, "translating", {
          provisionallyBilledUnits,
        });
      }

      const translatedGroupCount = groupIndex + 1;
      const progressPercent =
        50 +
        Math.round((translatedGroupCount / materializationQueue.length) * 20);
      await setJobProgress(redis, job_id, {
        status: "translating",
        progress_percent: progressPercent,
        current_step: "materialization_pass",
        details:
          `Materialized batch ${translatedGroupCount} of ${materializationQueue.length}. ` +
          `${provisionallyBilledUnits} slide(s) have been provisionally billed.`,
      });
      await assertNotCanceled(pool, redis, job, writeResult, provisionallyBilledUnits);
    }

    const bodyLanguageValidation = validateTargetLanguageOutput(
      targetLanguageForModel,
      translatedNodes.map((node) => node.translated_full_text)
    );
    if (!bodyLanguageValidation.ok) {
      throw new PipelineError("TARGET_LANGUAGE_VALIDATION_FAILED", bodyLanguageValidation.reason);
    }

    let writableSlides = selectSlidesReadyForWrite(authorityReadySlides, slideResults, nodeResults!);
    let writableSourceNodes = writableSlides.flatMap((slide) => slide.nodes);
    let orderedTranslatedNodes: TranslatedNode[] = [];
    if (writableSlides.length > 0) {
      try {
        orderedTranslatedNodes = orderTranslatedNodes(
          writableSourceNodes,
          translatedNodes
        );
      } catch (error) {
        markSlideFailures(
          slideResults,
          findSlidesMissingTranslatedNodes(writableSourceNodes, translatedNodes),
          "materialization",
          toSlideFailureReasonCode(error)
        );
        const recoveredWritableSlides = selectSlidesReadyForWrite(authorityReadySlides, slideResults, nodeResults!);
        const recoveredWritableSourceNodes = recoveredWritableSlides.flatMap((slide) => slide.nodes);
        writableSlides = recoveredWritableSlides;
        writableSourceNodes = recoveredWritableSourceNodes;
        if (recoveredWritableSlides.length > 0) {
          orderedTranslatedNodes = orderTranslatedNodes(
            recoveredWritableSourceNodes,
            translatedNodes
          );
        }
      }
    }

    const translationResult = {
      provider_request_id: JSON.stringify(providerRequestIds),
      nodes: orderedTranslatedNodes,
    };
    console.log(
      `Job ${job_id} translation completed: ${translationResult.nodes.length} translated nodes`
    );

    // Node-level materialization failures are already tracked in node truth.
    // Do not fail the full job here when some nodes are intentionally absent.

    await setJobProgress(redis, job_id, {
      status: "translating",
      progress_percent: 70,
      current_step: "translating_segments",
      details:
        writableSlides.length > 0
          ? `Translation complete for ${writableSlides.length} deliverable slide(s), preparing to write back`
          : `Slide body translation complete; preparing speaker notes delivery`,
    });
    await assertNotCanceled(pool, redis, job, writeResult, provisionallyBilledUnits);

    // --- WRITING ---
    console.log(`Job ${job_id} entering writing stage with mode ${job.output_mode}`);
    await updateJobStatus(pool, job_id, "writing");
    await setJobProgress(redis, job_id, {
      status: "writing",
      progress_percent: 80,
      current_step: "writing_back",
      details: `Writing translated content back to ${job.output_mode === "create_new_file" ? "new file" : "presentation"}`,
    });
    await assertNotCanceled(pool, redis, job, writeResult, provisionallyBilledUnits);
    const appliedWriteSlideIndexes = new Set<number>();
    const onContentWriteProgress = async (result: WriteBackResult) => {
      writeResult = result;
      applyWriteResultToSlideResults(
        slideResults,
        result,
        nodeResults!,
        appliedWriteSlideIndexes
      );
      await updateJobStatus(pool, job_id, "writing", {
        provisionallyBilledUnits,
        outputDocumentUrl: result.outputUrl,
      });
      await assertNotCanceled(pool, redis, job, writeResult, provisionallyBilledUnits);
    };

    if (writableSlides.length > 0) {
      try {
        if (job.output_mode === "create_new_file") {
          if (!job.target_doc_id) {
            throw new PipelineError(
              "HOST_ADAPTER_ERROR",
              "Target presentation ID is required for create_new_file"
            );
          }

          writeResult = await writeBackNewFile(
            job.target_doc_id,
            writableSlides,
            translationResult.nodes,
            onContentWriteProgress,
            { pool, jobId: job_id, sourcePresentationId: job.source_doc_id }
          );
        } else {
          writeResult = await writeBackAppend(
            job.source_doc_id,
            writableSlides,
            translationResult.nodes,
            onContentWriteProgress,
            { pool, jobId: job_id }
          );
        }
      } catch (error) {
        applyWriteResultToSlideResults(
          slideResults,
          writeResult,
          nodeResults!,
          appliedWriteSlideIndexes
        );
        throw error;
      }
      console.log(`Job ${job_id} slide body write-back completed`);

      applyWriteResultToSlideResults(
        slideResults,
        writeResult,
        nodeResults!,
        appliedWriteSlideIndexes
      );
    }

    const notesOutcomes = await Promise.all([...notesTranslationTasks.values()]);
    for (const outcome of notesOutcomes) {
      if ("failure_reason_code" in outcome) {
        for (const noteNode of outcome.prepared_slide.note_nodes) {
          markNodeTranslationFailed(nodeResults!, noteNode.node_id, outcome.failure_reason_code);
        }
        markNotesFailure(
          slideResults,
          outcome.slide_index,
          "slide_notes_translation_failed"
        );
        continue;
      }
      const notesLanguageValidation = validateTargetLanguageOutput(
        targetLanguageForModel,
        outcome.translated_nodes.map((node) => node.translated_full_text)
      );
      if (!notesLanguageValidation.ok) {
        for (const noteNode of outcome.prepared_slide.note_nodes) {
          markNodeTranslationFailed(
            nodeResults!,
            noteNode.node_id,
            "TARGET_LANGUAGE_VALIDATION_FAILED"
          );
        }
        markNotesFailure(
          slideResults,
          outcome.slide_index,
          "slide_notes_translation_failed"
        );
        continue;
      }
      providerRequestIds.push(outcome.provider_request_id);
      for (const translatedNode of outcome.translated_nodes) {
        markNodeTranslationSucceeded(nodeResults!, translatedNode.node_id);
      }
      markNotesTranslated(
        slideResults,
        outcome.slide_index,
        outcome.prepared_slide.notes_truncated
      );
    }

    const recomputedProvisionallyBilledUnits = computeProvisionallyBilledUnits(slideResults);
    if (recomputedProvisionallyBilledUnits !== provisionallyBilledUnits) {
      provisionallyBilledUnits = recomputedProvisionallyBilledUnits;
      await updateJobStatus(pool, job_id, "writing", {
        provisionallyBilledUnits,
        outputDocumentUrl: writeResult.outputUrl || undefined,
      });
    }

    const existingSlideTargets = collectExistingSlideWriteTargets(writeResult.slide_results);
    const bodyFailedSlideIndices = new Set(writeResult.failed_slide_indexes);
    const notesExistingSlides: Array<{ slide_index: number; slide_object_id: string; nodes: SlideTextNode[] }> = [];
    const notesAppendOnlySlides: Array<{ slide_index: number; slide_object_id: string; nodes: SlideTextNode[] }> = [];
    const successfulNotesOutcomes = notesOutcomes.filter(
      (outcome): outcome is Extract<NotesTranslationOutcome, { translated_nodes: readonly TranslatedNode[] }> =>
        !("failure_reason_code" in outcome)
    );
    const noteTranslatedNodes = successfulNotesOutcomes.flatMap((outcome) => outcome.translated_nodes);
    const bodyVisibleSlideIndices = new Set(
      listJobSlideResults(slideResults)
        .filter((result) => result.content_output_visible)
        .map((result) => result.slide_index)
    );
    const extractionSlideByIndex = new Map(
      extraction.extracted_slides.map((slide) => [slide.slide_index, slide])
    );

    for (const outcome of successfulNotesOutcomes) {
      const sourceSlide = extractionSlideByIndex.get(outcome.slide_index);
      if (!sourceSlide) {
        for (const noteNode of outcome.prepared_slide.note_nodes) {
          markNodeWriteFailed(nodeResults!, noteNode.node_id, "HOST_ADAPTER_ERROR");
        }
        markNotesFailure(
          slideResults,
          outcome.slide_index,
          "slide_notes_write_failed"
        );
        continue;
      }
      // New-file notes depend on the copied target slide map from body write;
      // append mode can still write notes directly to the original deck.
      if (job.output_mode === "create_new_file" && bodyFailedSlideIndices.has(outcome.slide_index)) {
        for (const noteNode of outcome.prepared_slide.note_nodes) {
          markNodeWriteFailed(nodeResults!, noteNode.node_id, "HOST_ADAPTER_ERROR");
        }
        markNotesFailure(
          slideResults,
          outcome.slide_index,
          "slide_notes_write_failed"
        );
        continue;
      }

      if (job.output_mode === "append_in_file" && !bodyVisibleSlideIndices.has(outcome.slide_index)) {
        notesAppendOnlySlides.push({
          slide_index: outcome.slide_index,
          slide_object_id: sourceSlide.slide_object_id,
          nodes: [...outcome.prepared_slide.truncated_note_nodes],
        });
        continue;
      }

      notesExistingSlides.push({
        slide_index: outcome.slide_index,
        slide_object_id: sourceSlide.slide_object_id,
        nodes: [...outcome.prepared_slide.truncated_note_nodes],
      });
    }

    const appliedNotesWriteSlideIndexes = new Set<number>();
    const onNotesWriteProgress = async (result: WriteBackResult) => {
      applyNotesWriteResultToSlideResults(
        slideResults,
        result,
        nodeResults!,
        appliedNotesWriteSlideIndexes
      );
      writeResult = combineWriteBackResults(writeResult, result);
      await updateJobStatus(pool, job_id, "writing", {
        provisionallyBilledUnits,
        outputDocumentUrl: writeResult.outputUrl,
      });
      await assertNotCanceled(pool, redis, job, writeResult, provisionallyBilledUnits);
    };

    if (notesExistingSlides.length > 0) {
      if (job.output_mode === "create_new_file" && !job.target_doc_id) {
        throw new PipelineError(
          "HOST_ADAPTER_ERROR",
          "Target presentation ID is required for create_new_file"
        );
      }
      const notesExistingTargets =
        job.output_mode === "create_new_file"
          ? notesExistingSlides.map(
              (slide) =>
                existingSlideTargets.get(slide.slide_index) ?? { slide_index: slide.slide_index }
            )
          : notesExistingSlides
              .map((slide) => existingSlideTargets.get(slide.slide_index))
              .filter((target): target is ExistingSlideWriteTarget => Boolean(target));

      const existingResult = await writeBackExistingSlides(
        job.output_mode === "create_new_file" ? job.target_doc_id ?? "" : job.source_doc_id,
        notesExistingSlides,
        noteTranslatedNodes,
        notesExistingTargets,
        onNotesWriteProgress,
        {
          pool,
          jobId: job_id,
          sourcePresentationId:
            job.output_mode === "create_new_file" ? job.source_doc_id : undefined,
          requireTargetObjectMap: job.output_mode === "create_new_file",
        }
      );
      applyNotesWriteResultToSlideResults(
        slideResults,
        existingResult,
        nodeResults!,
        appliedNotesWriteSlideIndexes
      );
      writeResult = combineWriteBackResults(writeResult, existingResult);
    }

    if (notesAppendOnlySlides.length > 0) {
      const appendOnlyResult = await writeBackAppend(
        job.source_doc_id,
        notesAppendOnlySlides,
        noteTranslatedNodes,
        onNotesWriteProgress,
        { pool, jobId: job_id }
      );
      applyNotesWriteResultToSlideResults(
        slideResults,
        appendOnlyResult,
        nodeResults!,
        appliedNotesWriteSlideIndexes
      );
      writeResult = combineWriteBackResults(writeResult, appendOnlyResult);
    }

    console.log(`Job ${job_id} write-back completed`);

    if (
      listJobSlideResults(slideResults).every(
        (result) => !result.content_output_visible && !result.notes_output_visible
      )
    ) {
      throw new PipelineError(
        "JOB_INTERNAL_ERROR",
        "Writer could not commit any deliverable slide or speaker notes output"
      );
    }

    if (writeResult.failed_slide_indexes.length > 0) {
      console.warn(
        `Job ${job_id} completed write stage with partial slide delivery`,
        JSON.stringify({
          committed_slides: writeResult.committed_slide_indexes.length,
          failed_slides: writeResult.failed_slide_indexes.length,
          deliverable_slides: writableSlides.length,
        })
      );
    }

    await finalizeSuccessfulJob(
      pool,
      redis,
      job,
      job_id,
      targetLangCode,
      writeResult,
      pipelineWarnings,
      slideResults,
      provisionallyBilledUnits,
      nodeResults
    );
    console.log(`Job ${job_id} slide results:`, JSON.stringify(listJobSlideResults(slideResults)));
    console.log(`Job ${job_id} completed successfully: ${writeResult.outputUrl}`);
  } catch (err) {
    if (err instanceof CancellationRequestedError) {
      for (const slideResult of listJobSlideResults(slideResults)) {
        if (slideResult.status === "translated" && !slideResult.output_visible) {
          markSlideCanceledAfterTranslation(slideResults, slideResult.slide_index);
        }
      }
      console.log(
        `Job ${job_id} slide results on cancel:`,
        JSON.stringify(listJobSlideResults(slideResults))
      );
      console.log(
        `Job ${job_id} canceled after ${err.writeResult.committedUnits} committed slides`
      );
      await finalizeCanceledJob(
        pool,
        redis,
        job,
        job_id,
        err.writeResult,
        err.billedUnits,
        slideResults,
        nodeResults
      );
      return;
    }

    const error = err as PipelineError | Error;
    const errorCode = toSlideFailureReasonCode(error);
    const safeMessage = toSafeErrorMessage(errorCode);
    console.error(
      `Job ${job_id} internal failure metadata:`,
      JSON.stringify({
        pipeline_error_code: errorCode,
        slide_results: listJobSlideResults(slideResults),
        ...getErrorMetadata(error),
      })
    );

    console.error(`Job ${job_id} failed [${errorCode}]:`, safeMessage);

    try {
      if (shouldFinalizeAsPartialSuccess(errorCode, slideResults)) {
        markUndeliveredSlidesFailedForTerminalError(slideResults, errorCode);
        await finalizeSuccessfulJob(
          pool,
          redis,
          job,
          job_id,
          targetLangCode,
          writeResult,
          pipelineWarnings,
          slideResults,
          provisionallyBilledUnits,
          nodeResults
        );
        return;
      }

      await finalizeFailedJob(
        pool,
        redis,
        job,
        job_id,
        writeResult,
        pipelineWarnings,
        provisionallyBilledUnits,
        slideResults,
        errorCode,
        safeMessage,
        nodeResults
      );
    } catch (updateErr) {
      console.error(
        `Failed to update job ${job_id} status to failed:`,
        (updateErr as Error).message
      );
    }
  }
}

class CancellationRequestedError extends Error {
  constructor(
    public readonly writeResult: WriteBackResult,
    public readonly billedUnits: number
  ) {
    super("Cancellation requested");
    this.name = "CancellationRequestedError";
  }
}

export class StageLeaseBusyError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly stage: JobExecutionStage,
    public readonly leaseExpiresAt: Date | null = null
  ) {
    super(`Stage ${stage} for job ${jobId} is already leased by another worker`);
    this.name = "StageLeaseBusyError";
  }
}

async function assertNotCanceled(
  pool: Pool,
  redis: Redis,
  job: Awaited<ReturnType<typeof getJobById>>,
  writeResult: WriteBackResult,
  billedUnits: number
): Promise<void> {
  if (!job) {
    return;
  }

  const cancelRequested = await redis.get(buildJobCancelKey(job.id));
  if (cancelRequested) {
    throw new CancellationRequestedError(writeResult, billedUnits);
  }

  if (await isCancelRequested(pool, job.id)) {
    throw new CancellationRequestedError(writeResult, billedUnits);
  }

  if (await redis.get(buildJobPauseKey(job.id))) {
    await waitWhilePaused(pool, redis, job, writeResult, billedUnits);
  }
}

async function waitWhilePaused(
  pool: Pool,
  redis: Redis,
  job: NonNullable<Awaited<ReturnType<typeof getJobById>>>,
  writeResult: WriteBackResult,
  billedUnits: number
): Promise<void> {
  const progressKey = `job_progress:${job.id}`;
  const snapshot = await redis.hgetall(progressKey);
  const fallbackStatus = resolvePauseFallbackStatus(job.status, job.current_stage);
  const progressPercent = parseProgressPercent(snapshot.progress_percent, fallbackStatus);
  const resumeStatus = resolvePausedResumeStatus(snapshot.status, fallbackStatus);
  const resumeStep = resolvePausedResumeStep(snapshot.current_step, job.current_stage, fallbackStatus);
  const pauseDetail = "Translation paused. Confirm cancellation or continue to resume.";
  const resumeDetail = "Resuming translation...";

  await setJobProgress(redis, job.id, {
    status: "paused",
    progress_percent: progressPercent,
    current_step: "paused",
    details: pauseDetail,
  });

  let lastHeartbeatAt = 0;
  while (true) {
    if (await redis.get(buildJobCancelKey(job.id))) {
      throw new CancellationRequestedError(writeResult, billedUnits);
    }
    if (await isCancelRequested(pool, job.id)) {
      throw new CancellationRequestedError(writeResult, billedUnits);
    }

    const pauseRequested = await redis.get(buildJobPauseKey(job.id));
    if (!pauseRequested) {
      break;
    }

    if (
      job.current_stage &&
      job.stage_attempt > 0 &&
      Date.now() - lastHeartbeatAt >= PAUSE_HEARTBEAT_INTERVAL_MS
    ) {
      await heartbeatJobStage(
        pool,
        job.id,
        job.current_stage,
        job.stage_attempt,
        getStageLeaseSeconds(job.current_stage)
      );
      lastHeartbeatAt = Date.now();
    }

    await delay(PAUSE_POLL_INTERVAL_MS);
  }

  await setJobProgress(redis, job.id, {
    status: resumeStatus,
    progress_percent: progressPercent,
    current_step: resumeStep,
    details: resumeDetail,
  });
}

function parseProgressPercent(rawValue: string | undefined, fallbackStatus: string): number {
  const parsed = rawValue ? Number.parseInt(rawValue, 10) : Number.NaN;
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  switch (fallbackStatus) {
    case "extracting":
      return 10;
    case "translating":
      return 45;
    case "writing":
      return 80;
    case "queued":
      return 0;
    case "pending":
    default:
      return 0;
  }
}

function resolvePauseFallbackStatus(
  jobStatus: string,
  currentStage: JobExecutionStage | null
): "pending" | "queued" | "extracting" | "translating" | "writing" {
  if (
    jobStatus === "pending" ||
    jobStatus === "queued" ||
    jobStatus === "extracting" ||
    jobStatus === "translating" ||
    jobStatus === "writing"
  ) {
    return jobStatus;
  }

  switch (currentStage) {
    case "extract":
      return "extracting";
    case "layout_semantics":
    case "authority":
      return "translating";
    case "finalize":
      return "writing";
    default:
      return "translating";
  }
}

function resolvePausedResumeStatus(
  snapshotStatus: string | undefined,
  fallbackStatus: "pending" | "queued" | "extracting" | "translating" | "writing"
): "pending" | "queued" | "extracting" | "translating" | "writing" {
  if (
    snapshotStatus === "pending" ||
    snapshotStatus === "queued" ||
    snapshotStatus === "extracting" ||
    snapshotStatus === "translating" ||
    snapshotStatus === "writing"
  ) {
    return snapshotStatus;
  }
  return fallbackStatus;
}

function resolvePausedResumeStep(
  snapshotStep: string | undefined,
  currentStage: JobExecutionStage | null,
  fallbackStatus: "pending" | "queued" | "extracting" | "translating" | "writing"
): string {
  if (snapshotStep && snapshotStep !== "paused" && snapshotStep !== "pausing") {
    return snapshotStep;
  }

  switch (currentStage) {
    case "extract":
      return "extracting_content";
    case "layout_semantics":
      return "layout_semantics";
    case "authority":
      return fallbackStatus === "writing" ? "writing_back" : "authority_pass";
    case "finalize":
      return "finalize";
    default:
      return fallbackStatus;
  }
}

async function finalizeSuccessfulJob(
  pool: Pool,
  redis: Redis,
  job: NonNullable<Awaited<ReturnType<typeof getJobById>>>,
  jobId: string,
  targetLangCode: string,
  writeResult: WriteBackResult,
  pipelineWarnings: readonly JobWarning[],
  slideResults: ReturnType<typeof initializeJobSlideResults>,
  provisionallyBilledUnits: number,
  nodeResults?: JobNodeExecutionResultMap
): Promise<void> {
  const finalWarnings = [...pipelineWarnings, ...writeResult.warnings];
  let completedStatus: "completed" | "completed_with_warnings" = "completed";
  let completionDetail = "Translation completed successfully.";
  const driveCleanupUpdate = await attemptTerminalDriveCleanup(pool, job, jobId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (nodeResults) {
      syncAllSlideResultsWithNodeTruth(slideResults, nodeResults);
    }
    const settlement = await settleSlideBilling(client, job, slideResults, "successful");
    const settledSlideResults = materializeSettledSlideResults(slideResults, settlement);
    const settledSlideResultsMap = new Map(
      settledSlideResults.map((slideResult) => [slideResult.slide_index, slideResult])
    ) as ReturnType<typeof initializeJobSlideResults>;
    completedStatus =
      finalWarnings.length > 0 ||
      hasSlideExecutionWarnings(settledSlideResultsMap) ||
      hasPartialDelivery(settledSlideResultsMap)
        ? "completed_with_warnings"
        : "completed";
    completionDetail = buildSuccessfulCompletionDetail(
      finalWarnings.length,
      settledSlideResultsMap
    );
    await upsertJobSlideResults(client, jobId, settledSlideResults);
    if (nodeResults) {
      await upsertJobNodeResults(client, jobId, listJobNodeResults(nodeResults));
    }

    await updateJobStatus(client, jobId, completedStatus, {
      outputDocumentUrl: writeResult.outputUrl,
      provisionallyBilledUnits,
      grossBilledSlides: settlement.gross_billed_slides,
      refundedSlides: settlement.refunded_slides,
      netBilledSlides: settlement.net_billed_slides,
      totalUnitsBilled: settlement.net_billed_slides,
      targetLangCode,
      warnings: finalWarnings,
      currentStage: null,
      stageStatus: null,
      stageLeaseExpiresAt: null,
      stageLastHeartbeatAt: null,
      queuedTaskName: null,
      ...driveCleanupUpdate,
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr) => {
      console.error(`ROLLBACK failed for job ${jobId}:`, (rollbackErr as Error).message);
    });
    throw err;
  } finally {
    client.release();
  }

  await Promise.all([
    setJobProgress(redis, jobId, {
      status: completedStatus,
      progress_percent: 100,
      current_step: completedStatus,
      details: completionDetail,
    }),
    redis.del(buildJobCancelKey(jobId)),
  ]);
  logTrackDTerminalStatus(jobId, completedStatus, {
    warning_count: finalWarnings.length,
    slide_summary: summarizeSlideExecution(slideResults),
  });
}

function buildSuccessfulCompletionDetail(
  warningCount: number,
  slideResults: ReturnType<typeof initializeJobSlideResults>
): string {
  const slideSummary = summarizeSlideExecution(slideResults);
  if (slideSummary.skipped_slides > 0) {
    return `Translation completed with warnings. Delivered ${slideSummary.committed_slides} slide(s), skipped ${slideSummary.skipped_slides} slide(s), and excluded ${slideSummary.excluded_slides} unsafe slide(s).`;
  }

  if (slideSummary.excluded_slides > 0 && warningCount === 0) {
    return `Translation completed with warnings. Excluded ${slideSummary.excluded_slides} unsafe slide(s) before translation.`;
  }

  if (warningCount > 0 || slideSummary.excluded_slides > 0) {
    return `Translation completed with ${warningCount} warning(s). Review the translated Slides for excluded pages or minor layout issues.`;
  }

  return "Translation completed successfully.";
}

function buildUnsafeSlideExcludedWarnings(
  slides: readonly { readonly slide_index: number; readonly nodes: readonly SlideTextNode[] }[],
  excludedSlideIndices: readonly number[]
): JobWarning[] {
  if (excludedSlideIndices.length === 0) {
    return [];
  }

  const slidesByIndex = new Map(slides.map((slide) => [slide.slide_index, slide]));

  return excludedSlideIndices.map((slideIndex) => {
    const slide = slidesByIndex.get(slideIndex);
    if (!slide) {
      console.error(
        `Prompt-injection scan reported excluded slide ${slideIndex + 1}, but no matching extracted slide metadata was found`
      );
    }
    const primaryNode = slide?.nodes[0];
    return {
      node_id: primaryNode?.node_id ?? `unsafe_slide_${slideIndex + 1}`,
      slide_index: slideIndex,
      archetype: primaryNode?.archetype ?? "plain_text",
      risk_level: "high",
      risk_reason: "unsafe_slide_excluded",
    };
  });
}

async function finalizeCanceledJob(
  pool: Pool,
  redis: Redis,
  job: NonNullable<Awaited<ReturnType<typeof getJobById>>>,
  jobId: string,
  writeResult: WriteBackResult,
  provisionallyBilledUnits: number,
  slideResults: ReturnType<typeof initializeJobSlideResults>,
  nodeResults?: JobNodeExecutionResultMap
): Promise<void> {
  const detail = buildCanceledDetail(provisionallyBilledUnits);
  const driveCleanupUpdate = await attemptTerminalDriveCleanup(pool, job, jobId);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    if (nodeResults) {
      syncAllSlideResultsWithNodeTruth(slideResults, nodeResults);
    }
    const settlement = await settleSlideBilling(client, job, slideResults, "canceled");
    const settledSlideResults = materializeSettledSlideResults(slideResults, settlement);
    await upsertJobSlideResults(client, jobId, settledSlideResults);
    if (nodeResults) {
      await upsertJobNodeResults(client, jobId, listJobNodeResults(nodeResults));
    }

    await updateJobStatus(client, jobId, "canceled", {
      outputDocumentUrl: writeResult.outputUrl || undefined,
      provisionallyBilledUnits,
      grossBilledSlides: settlement.gross_billed_slides,
      refundedSlides: settlement.refunded_slides,
      netBilledSlides: settlement.net_billed_slides,
      totalUnitsBilled: settlement.net_billed_slides,
      currentStage: null,
      stageStatus: null,
      stageLeaseExpiresAt: null,
      stageLastHeartbeatAt: null,
      queuedTaskName: null,
      ...driveCleanupUpdate,
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr) => {
      console.error(`ROLLBACK failed for canceled job ${jobId}:`, (rollbackErr as Error).message);
    });
    throw err;
  } finally {
    client.release();
  }

  await Promise.all([
    setJobProgress(redis, jobId, {
      status: "canceled",
      progress_percent: provisionallyBilledUnits > 0 ? 100 : 0,
      current_step: "canceled",
      details: detail,
    }),
    redis.del(buildJobCancelKey(jobId)),
  ]);
  logTrackDTerminalStatus(jobId, "canceled", {
    provisionally_billed_units: provisionallyBilledUnits,
    slide_summary: summarizeSlideExecution(slideResults),
  });
}

async function finalizeFailedJob(
  pool: Pool,
  redis: Redis,
  job: NonNullable<Awaited<ReturnType<typeof getJobById>>>,
  jobId: string,
  writeResult: WriteBackResult,
  pipelineWarnings: readonly JobWarning[],
  provisionallyBilledUnits: number,
  slideResults: ReturnType<typeof initializeJobSlideResults>,
  errorCode: string,
  safeMessage: string,
  nodeResults?: JobNodeExecutionResultMap
): Promise<void> {
  const finalWarnings = [...pipelineWarnings, ...writeResult.warnings];
  const driveCleanupUpdate = await attemptTerminalDriveCleanup(pool, job, jobId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (nodeResults) {
      syncAllSlideResultsWithNodeTruth(slideResults, nodeResults);
    }
    const settlement = await settleSlideBilling(client, job, slideResults, "failed");
    const settledSlideResults = materializeSettledSlideResults(slideResults, settlement);
    await upsertJobSlideResults(client, jobId, settledSlideResults);
    if (nodeResults) {
      await upsertJobNodeResults(client, jobId, listJobNodeResults(nodeResults));
    }

    await updateJobStatus(client, jobId, "failed", {
      errorCode,
      errorMessage: safeMessage,
      outputDocumentUrl: writeResult.outputUrl || undefined,
      provisionallyBilledUnits,
      grossBilledSlides: settlement.gross_billed_slides,
      refundedSlides: settlement.refunded_slides,
      netBilledSlides: settlement.net_billed_slides,
      totalUnitsBilled: settlement.net_billed_slides,
      warnings: finalWarnings,
      currentStage: null,
      stageStatus: null,
      stageLeaseExpiresAt: null,
      stageLastHeartbeatAt: null,
      queuedTaskName: null,
      ...driveCleanupUpdate,
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr) => {
      console.error(`ROLLBACK failed for failed job ${jobId}:`, (rollbackErr as Error).message);
    });
    throw err;
  } finally {
    client.release();
  }

  await Promise.all([
    setJobProgress(redis, jobId, {
      status: "failed",
      progress_percent: 0,
      current_step: "failed",
      details: safeMessage,
    }),
    redis.del(buildJobCancelKey(jobId)),
  ]);
  logTrackDTerminalStatus(jobId, "failed", {
    error_code: errorCode,
    slide_summary: summarizeSlideExecution(slideResults),
  });
}

function logTrackDTerminalStatus(
  jobId: string,
  status: "completed" | "completed_with_warnings" | "failed" | "canceled",
  extra: Record<string, unknown> = {}
): void {
  console.info(
    "[job-terminal] finalized",
    JSON.stringify({
      job_id: jobId,
      status,
      ...extra,
    })
  );
}

async function attemptTerminalDriveCleanup(
  pool: Pool,
  job: NonNullable<Awaited<ReturnType<typeof getJobById>>>,
  jobId: string
): Promise<TerminalDriveCleanupUpdate> {
  if (job.drive_cleanup_status === "succeeded") {
    // Already successful cleanup is terminal metadata; retries should not mutate it.
    return {};
  }

  if (!job.source_worker_permission_id && !job.target_worker_permission_id) {
    // Existing not-required rows need no terminal update; only stale cleanup rows are corrected.
    if (job.drive_cleanup_status === "pending" || job.drive_cleanup_status === "failed") {
      return {
        driveCleanupStatus: "not_required",
        driveCleanupLastErrorCode: null,
      };
    }
    return {};
  }

  let result: Awaited<ReturnType<typeof cleanupDriveWorkerPermissionsForJob>>;
  try {
    result = await cleanupTerminalDrivePermissions(pool, job);
  } catch (error) {
    console.warn(
      "[drive-cleanup] unexpected cleanup error",
      JSON.stringify({
        job_id: jobId,
        cleanup_status: "failed",
        error_code: "drive_cleanup_unexpected_error",
        error_name: error instanceof Error ? error.name : typeof error,
      })
    );
    return {
      driveCleanupStatus: "failed",
      driveCleanupLastErrorCode: "drive_cleanup_unexpected_error",
      incrementDriveCleanupAttempts: true,
    };
  }
  const logPayload = {
    job_id: jobId,
    cleanup_status: result.status,
    target_count: result.targetCount,
    attempted: result.attempted,
    error_code: result.errorCode,
  };
  if (result.status === "failed") {
    console.warn("[drive-cleanup] permission cleanup failed", JSON.stringify(logPayload));
  } else {
    console.info("[drive-cleanup] permission cleanup finalized", JSON.stringify(logPayload));
  }

  return {
    driveCleanupStatus: result.status,
    driveCleanupLastErrorCode: result.errorCode,
    incrementDriveCleanupAttempts: result.attempted,
  };
}

function markSlideFailures(
  slideResults: ReturnType<typeof initializeJobSlideResults>,
  slideIndices: readonly number[],
  failureStage: "authority" | "materialization" | "write" | "extract",
  failureReasonCode: string
): void {
  for (const slideIndex of slideIndices) {
    markSlideFailure(slideResults, slideIndex, failureStage, failureReasonCode);
  }
}

function applyWriteResultToSlideResults(
  slideResults: ReturnType<typeof initializeJobSlideResults>,
  writeResult: WriteBackResult,
  nodeResults: JobNodeExecutionResultMap,
  appliedSlideIndexes?: Set<number>
): void {
  for (const slideResult of writeResult.slide_results) {
    if (appliedSlideIndexes?.has(slideResult.slide_index)) {
      continue;
    }

    if (slideResult.status === "committed") {
      for (const nodeId of slideResult.committed_node_ids ?? []) {
        markNodeWriteSucceeded(nodeResults, nodeId);
      }
      for (const nodeId of slideResult.failed_node_ids ?? []) {
        markNodeWriteFailed(nodeResults, nodeId, "HOST_ADAPTER_ERROR");
      }
      markSlideCommitted(slideResults, slideResult.slide_index);
      syncSlideResultWithNodeTruth(slideResults, nodeResults, slideResult.slide_index, {
        outputSlideObjectId: slideResult.output_slide_object_id,
        sourceSlideObjectId: slideResult.source_slide_object_id,
      });
    } else {
      for (const nodeId of slideResult.failed_node_ids ?? []) {
        markNodeWriteFailed(nodeResults, nodeId, slideResult.error_code ?? "JOB_INTERNAL_ERROR");
      }
      markSlideFailure(
        slideResults,
        slideResult.slide_index,
        "write",
        slideResult.error_code ?? "JOB_INTERNAL_ERROR"
      );
      syncSlideResultWithNodeTruth(slideResults, nodeResults, slideResult.slide_index, {
        sourceSlideObjectId: slideResult.source_slide_object_id,
      });
    }

    appliedSlideIndexes?.add(slideResult.slide_index);
  }
}

function isSlideReadyForMaterialization(
  slideResults: ReturnType<typeof initializeJobSlideResults>,
  slideIndex: number
): boolean {
  const slideResult = slideResults.get(slideIndex);
  if (!slideResult) {
    return false;
  }

  return (
    slideResult.status === "pending" ||
    slideResult.status === "translated"
  );
}

function selectSlidesReadyForMaterialization<T extends { readonly slide_index: number }>(
  slides: readonly T[],
  slideResults: ReturnType<typeof initializeJobSlideResults>
): T[] {
  return slides.filter((slide) => isSlideReadyForMaterialization(slideResults, slide.slide_index));
}

function selectSlidesReadyForWrite<T extends { readonly slide_index: number }>(
  slides: readonly T[],
  slideResults: ReturnType<typeof initializeJobSlideResults>,
  nodeResults?: JobNodeExecutionResultMap
): T[] {
  return slides.filter((slide) => {
    if (nodeResults) {
      return countSuccessfulBodyNodes(nodeResults, slide.slide_index) > 0;
    }
    return slideResults.get(slide.slide_index)?.status === "translated";
  });
}

function buildCanceledDetail(billedUnits: number): string {
  if (billedUnits > 0) {
    return `Canceled after ${billedUnits} slide(s) were successfully translated. Those slides were counted toward quota even though the job did not finish.`;
  }

  return "Canceled before any slide translation succeeded. No quota was charged.";
}

async function runProviderCallWithRetry<T>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS_PER_BATCH; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.warn(
        `Provider call ${label} failed on attempt ${attempt}/${MAX_PROVIDER_ATTEMPTS_PER_BATCH}:`,
        JSON.stringify(getErrorMetadata(error))
      );
      if (attempt >= MAX_PROVIDER_ATTEMPTS_PER_BATCH || !isRetryableProviderError(error)) {
        throw error;
      }
      await delay(computeProviderRetryDelayMs(attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Provider call ${label} failed`);
}

function shouldExplodeMaterializationGroup(
  group: { readonly node_summaries: readonly { readonly node_id: string }[] },
  error: unknown
): boolean {
  void error;
  return group.node_summaries.length > 1;
}

function registerBilledSlides(
  provisionallyBilledSlideIndexes: Set<number>,
  slideIndexes: readonly number[]
): number {
  for (const slideIndex of slideIndexes) {
    provisionallyBilledSlideIndexes.add(slideIndex);
  }
  return provisionallyBilledSlideIndexes.size;
}

function buildSlideBillingSettlement(
  slideResults: ReturnType<typeof initializeJobSlideResults>,
  mode: SlideBillingSettlementMode
): SlideBillingSettlement {
  const settlement: SlideBillingSettlement = {
    provisionally_billed_units: 0,
    gross_billed_slides: 0,
    refunded_slides: 0,
    net_billed_slides: 0,
    provisional_slide_indices: [],
    refunded_slide_indices: [],
    provisional_units_by_slide: new Map<number, number>(),
    refunded_units_by_slide: new Map<number, number>(),
  };

  for (const slideResult of listJobSlideResults(slideResults)) {
    const provisionalUnits = slideResult.provisional_billed_units ?? (slideResult.provisionally_billed ? 1 : 0);
    if (provisionalUnits <= 0) {
      continue;
    }

    settlement.provisionally_billed_units += provisionalUnits;
    settlement.gross_billed_slides += provisionalUnits;
    settlement.provisional_slide_indices.push(slideResult.slide_index);
    (settlement.provisional_units_by_slide as Map<number, number>).set(slideResult.slide_index, provisionalUnits);

    const refundedUnits = computeRefundedUnits(slideResult, mode);
    if (refundedUnits > 0) {
      settlement.refunded_slides += refundedUnits;
      settlement.refunded_slide_indices.push(slideResult.slide_index);
      (settlement.refunded_units_by_slide as Map<number, number>).set(slideResult.slide_index, refundedUnits);
    }
  }

  settlement.net_billed_slides =
    settlement.gross_billed_slides - settlement.refunded_slides;

  return settlement;
}

function computeRefundedUnits(
  slideResult: ReturnType<typeof listJobSlideResults>[number],
  mode: SlideBillingSettlementMode
): number {
  const provisionalUnits = slideResult.provisional_billed_units ?? (slideResult.provisionally_billed ? 1 : 0);
  if (provisionalUnits <= 0) {
    return 0;
  }

  const finalUnits = slideResult.final_billed_units ?? (
    slideResult.final_billable || slideResult.output_visible ? 1 : 0
  );

  if (mode === "canceled") {
    if (slideResult.status === "canceled_after_translation") {
      return 0;
    }
    return Math.max(0, provisionalUnits - finalUnits);
  }

  if (mode === "failed") {
    if (slideResult.status === "canceled_after_translation") {
      return 0;
    }
    return Math.max(0, provisionalUnits - finalUnits);
  }

  return Math.max(0, provisionalUnits - finalUnits);
}

async function settleSlideBilling(
  client: PoolClient,
  job: NonNullable<Awaited<ReturnType<typeof getJobById>>>,
  slideResults: ReturnType<typeof initializeJobSlideResults>,
  mode: SlideBillingSettlementMode
): Promise<SlideBillingSettlement> {
  const settlement = buildSlideBillingSettlement(slideResults, mode);
  if (settlement.gross_billed_slides === 0) {
    return settlement;
  }

  const periodKey = billingPeriodKey();
  const provisionalLedgerIds = new Map<number, string>();

  for (const slideIndex of settlement.provisional_slide_indices) {
    const ledgerId = await insertUsageLedger(client, {
      userId: job.user_id,
      jobId: job.id,
      hostType: "slides",
      usageUnit: "slides",
      quantity: settlement.provisional_units_by_slide.get(slideIndex) ?? 0,
      periodKey,
      reason: "translate_slides_provisional",
      slideIndex,
      ledgerStage: "provisional",
    });
    provisionalLedgerIds.set(slideIndex, ledgerId);
  }

  for (const slideIndex of settlement.refunded_slide_indices) {
    await insertUsageLedger(client, {
      userId: job.user_id,
      jobId: job.id,
      hostType: "slides",
      usageUnit: "slides",
      quantity: -1 * (settlement.refunded_units_by_slide.get(slideIndex) ?? 0),
      periodKey,
      reason: "translate_slides_refund",
      slideIndex,
      ledgerStage: "refund",
      relatedUsageId: provisionalLedgerIds.get(slideIndex),
    });
  }

  const planType = await getActivePlanForUser(client, job.user_id);
  const planLimit = getHostLimit(getQuotaLimits(planType), "slides");
  const usedBeforeJob = await getUsageBeforeJob(client, {
    userId: job.user_id,
    jobId: job.id,
    hostType: "slides",
    periodKey,
  });
  const planRemainingBeforeJob = Number.isFinite(planLimit)
    ? Math.max(0, planLimit - usedBeforeJob)
    : Number.POSITIVE_INFINITY;
  const creditUnitsToConsume = Math.max(
    0,
    settlement.net_billed_slides - planRemainingBeforeJob
  );
  if (creditUnitsToConsume > 0) {
    await consumeCredits(client, {
      userId: job.user_id,
      jobId: job.id,
      unit: "slides_pages",
      units: creditUnitsToConsume,
      idempotencyKey: `job:${job.id}:slides:${creditUnitsToConsume}`,
    });
  }

  return settlement;
}

function materializeSettledSlideResults(
  slideResults: ReturnType<typeof initializeJobSlideResults>,
  settlement: SlideBillingSettlement
): JobSlideResult[] {
  const refundedSlideIndexes = new Set(settlement.refunded_slide_indices);
  const refundedUnitsBySlide = settlement.refunded_units_by_slide;
  return listJobSlideResults(slideResults).map((slideResult) => ({
    ...slideResult,
    refunded: refundedSlideIndexes.has(slideResult.slide_index),
    refunded_units: refundedUnitsBySlide.get(slideResult.slide_index) ?? 0,
  }));
}

function toSlideFailureReasonCode(error: unknown): string {
  if (error instanceof PipelineError) {
    return error.code;
  }

  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (
      code === "SLIDES_QUOTA_EXHAUSTED" ||
      code === "VERTEX_QUOTA_EXHAUSTED" ||
      code === "UNAUTHORIZED" ||
      code === "ACCESS_DENIED"
    ) {
      return code;
    }

    const status = getPipelineErrorStatus(error);
    if (status === 401 || isUserTokenAuthError(error)) {
      return "UNAUTHORIZED";
    }
    if (status === 403) {
      return "ACCESS_DENIED";
    }
  }

  return "JOB_INTERNAL_ERROR";
}

function hasSlideExecutionWarnings(
  slideResults: ReturnType<typeof initializeJobSlideResults>
): boolean {
  return listJobSlideResults(slideResults).some((slideResult) => {
    return (
      slideResult.status === "excluded_unsafe" ||
      slideResult.status === "skipped_translation_failed" ||
      slideResult.status === "skipped_materialization_failed" ||
      slideResult.status === "skipped_write_failed" ||
      slideResult.refund_required
    );
  });
}

function hasPartialDelivery(
  slideResults: ReturnType<typeof initializeJobSlideResults>
): boolean {
  for (const slideResult of listJobSlideResults(slideResults)) {
    if (!slideResult.output_visible) {
      continue;
    }

    if (slideResult.notes_present) {
      if (Boolean(slideResult.content_output_visible) !== Boolean(slideResult.notes_output_visible)) {
        return true;
      }
    }

    if ((slideResult.body_failed_node_count ?? 0) > 0) {
      return true;
    }
  }

  return false;
}

function summarizeSlideExecution(
  slideResults: ReturnType<typeof initializeJobSlideResults>
): {
  committed_slides: number;
  skipped_slides: number;
  excluded_slides: number;
} {
  let committedSlides = 0;
  let skippedSlides = 0;
  let excludedSlides = 0;

  for (const slideResult of listJobSlideResults(slideResults)) {
    if (slideResult.status === "committed") {
      committedSlides += 1;
      continue;
    }

    if (slideResult.status === "excluded_unsafe") {
      excludedSlides += 1;
      continue;
    }

    if (
      slideResult.status === "skipped_translation_failed" ||
      slideResult.status === "skipped_materialization_failed" ||
      slideResult.status === "skipped_write_failed"
    ) {
      skippedSlides += 1;
    }
  }

  return {
    committed_slides: committedSlides,
    skipped_slides: skippedSlides,
    excluded_slides: excludedSlides,
  };
}

export function __selectSlidesReadyForMaterializationForTests<T extends { readonly slide_index: number }>(
  slides: readonly T[],
  slideResults: ReturnType<typeof initializeJobSlideResults>
): T[] {
  return selectSlidesReadyForMaterialization(slides, slideResults);
}

export function __selectSlidesReadyForWriteForTests<T extends { readonly slide_index: number }>(
  slides: readonly T[],
  slideResults: ReturnType<typeof initializeJobSlideResults>
): T[] {
  return selectSlidesReadyForWrite(slides, slideResults);
}

export function __hasSlideExecutionWarningsForTests(
  slideResults: ReturnType<typeof initializeJobSlideResults>
): boolean {
  return hasSlideExecutionWarnings(slideResults);
}

export function __applyWriteResultToSlideResultsForTests(
  slideResults: ReturnType<typeof initializeJobSlideResults>,
  writeResult: WriteBackResult
): void {
  applyWriteResultToSlideResults(slideResults, writeResult, new Map());
}

export function __summarizeSlideExecutionForTests(
  slideResults: ReturnType<typeof initializeJobSlideResults>
): {
  committed_slides: number;
  skipped_slides: number;
  excluded_slides: number;
} {
  return summarizeSlideExecution(slideResults);
}

export function __buildSlideBillingSettlementForTests(
  slideResults: ReturnType<typeof initializeJobSlideResults>,
  mode: SlideBillingSettlementMode
): SlideBillingSettlement {
  return buildSlideBillingSettlement(slideResults, mode);
}

export function __orderTranslatedNodesForWriteForTests(
  sourceNodes: readonly { readonly node_id: string }[],
  translatedNodes: readonly TranslatedNode[]
): TranslatedNode[] {
  return orderTranslatedNodes(sourceNodes, translatedNodes);
}

export function __resolveModelTargetLanguageForTests(targetLanguageInput: string): string {
  return resolveModelTargetLanguage(targetLanguageInput);
}

export function __validateTargetLanguageOutputForTests(
  targetLanguageInput: string,
  translatedTexts: readonly string[]
) {
  return validateTargetLanguageOutput(targetLanguageInput, translatedTexts);
}

function uniqueSlideIndices(
  items: readonly { readonly slide_index: number }[]
): number[] {
  return [...new Set(items.map((item) => item.slide_index))].sort((left, right) => left - right);
}

function buildPendingNodeIdsBySlide(
  nodes: readonly { readonly slide_index: number; readonly node_id: string }[]
): Map<number, Set<string>> {
  const pendingNodeIdsBySlide = new Map<number, Set<string>>();

  for (const node of nodes) {
    const current = pendingNodeIdsBySlide.get(node.slide_index);
    if (current) {
      current.add(node.node_id);
      continue;
    }

    pendingNodeIdsBySlide.set(node.slide_index, new Set([node.node_id]));
  }

  return pendingNodeIdsBySlide;
}

function registerTranslatedNodesBySlide(
  pendingNodeIdsBySlide: Map<number, Set<string>>,
  nodes: readonly { readonly slide_index: number; readonly node_id: string }[]
): number[] {
  const newlyTranslatedSlideIndexes = new Set<number>();

  for (const node of nodes) {
    const pendingNodeIds = pendingNodeIdsBySlide.get(node.slide_index);
    if (!pendingNodeIds) {
      continue;
    }

    pendingNodeIds.delete(node.node_id);
    if (pendingNodeIds.size === 0) {
      newlyTranslatedSlideIndexes.add(node.slide_index);
    }
  }

  return [...newlyTranslatedSlideIndexes].sort((left, right) => left - right);
}

function findSlidesMissingTranslatedNodes(
  sourceNodes: readonly { readonly node_id: string; readonly slide_index: number }[],
  translatedNodes: readonly TranslatedNode[]
): number[] {
  const translatedNodeIds = new Set(translatedNodes.map((node) => node.node_id));
  const missingSlideIndices = new Set<number>();

  for (const sourceNode of sourceNodes) {
    if (!translatedNodeIds.has(sourceNode.node_id)) {
      missingSlideIndices.add(sourceNode.slide_index);
    }
  }

  return [...missingSlideIndices].sort((left, right) => left - right);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeProviderRetryDelayMs(
  attempt: number,
  random: () => number = Math.random
): number {
  const cappedBaseDelay = Math.min(
    PROVIDER_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    PROVIDER_RETRY_MAX_DELAY_MS
  );
  const jitterMultiplier = 0.7 + random() * 0.6;
  return Math.max(1, Math.round(cappedBaseDelay * jitterMultiplier));
}

export function __computeProviderRetryDelayMsForTests(
  attempt: number,
  randomValue: number
): number {
  return computeProviderRetryDelayMs(attempt, () => randomValue);
}

export function __hasPartialDeliveryForTests(
  slideResults: ReturnType<typeof initializeJobSlideResults>
): boolean {
  return hasPartialDelivery(slideResults);
}

export function __isRetryableProviderErrorForTests(error: unknown): boolean {
  return isRetryableProviderError(error);
}

export function __toSafePipelineMessageForTests(
  error: unknown,
  fallback: string
): string {
  return toSafePipelineMessage(error, fallback);
}

export function __shouldFinalizeAsPartialSuccessForTests(
  errorCode: string,
  slideResults: ReturnType<typeof initializeJobSlideResults>
): boolean {
  return shouldFinalizeAsPartialSuccess(errorCode, slideResults);
}

export async function __attemptTerminalDriveCleanupForTests(
  pool: Pool,
  job: NonNullable<Awaited<ReturnType<typeof getJobById>>>,
  jobId: string
): Promise<TerminalDriveCleanupUpdate> {
  return attemptTerminalDriveCleanup(pool, job, jobId);
}

export async function __finalizeSuccessfulJobForTests(
  pool: Pool,
  redis: Redis,
  job: NonNullable<Awaited<ReturnType<typeof getJobById>>>,
  jobId: string,
  writeResult: WriteBackResult,
  slideResults: ReturnType<typeof initializeJobSlideResults>
): Promise<void> {
  await finalizeSuccessfulJob(
    pool,
    redis,
    job,
    jobId,
    "de",
    writeResult,
    [],
    slideResults,
    0
  );
}

export async function __finalizeCanceledJobForTests(
  pool: Pool,
  redis: Redis,
  job: NonNullable<Awaited<ReturnType<typeof getJobById>>>,
  jobId: string,
  writeResult: WriteBackResult,
  slideResults: ReturnType<typeof initializeJobSlideResults>
): Promise<void> {
  await finalizeCanceledJob(pool, redis, job, jobId, writeResult, 0, slideResults);
}

export async function __finalizeFailedJobForTests(
  pool: Pool,
  redis: Redis,
  job: NonNullable<Awaited<ReturnType<typeof getJobById>>>,
  jobId: string,
  writeResult: WriteBackResult,
  slideResults: ReturnType<typeof initializeJobSlideResults>
): Promise<void> {
  await finalizeFailedJob(
    pool,
    redis,
    job,
    jobId,
    writeResult,
    [],
    0,
    slideResults,
    "JOB_INTERNAL_ERROR",
    "Test failure"
  );
}

export function __setTerminalDriveCleanupHookForTests(
  hook: typeof cleanupDriveWorkerPermissionsForJob
): void {
  if (isProductionLikeNodeEnv()) {
    throw new Error("Terminal Drive cleanup test hooks are disabled in production-like environments");
  }
  cleanupTerminalDrivePermissions = hook;
}

export function __resetTerminalDriveCleanupHookForTests(): void {
  if (isProductionLikeNodeEnv()) {
    throw new Error("Terminal Drive cleanup test hooks are disabled in production-like environments");
  }
  cleanupTerminalDrivePermissions = cleanupDriveWorkerPermissionsForJob;
}

function isProductionLikeNodeEnv(): boolean {
  return process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging";
}

function isRetryableProviderError(error: unknown): boolean {
  if (toSlideFailureReasonCode(error) === "VERTEX_QUOTA_EXHAUSTED") {
    return false;
  }

  const status = extractProviderHttpStatus(error);
  if (status !== null) {
    return status === 408 || status === 429 || status >= 500;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    error.name === "AbortError" ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("socket hang up")
  );
}

function extractProviderHttpStatus(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const directStatus = (error as Error & { status?: unknown }).status;
  if (typeof directStatus === "number" && Number.isInteger(directStatus)) {
    return directStatus;
  }

  const match = error.message.match(/\bstatus\s+(\d{3})\b/i);
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(parsed) ? parsed : null;
}

class PipelineError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

function toSafeErrorMessage(code: string): string {
  switch (code) {
    case "INVALID_RANGE":
      return "The selected slide range is invalid.";
    case "UNAUTHORIZED":
      return "Google Slides™ authentication expired or is no longer valid. Please retry from the add-on.";
    case "ACCESS_DENIED":
      return "The Google Slides™ document could not be accessed with the current account permissions.";
    case "HOST_ADAPTER_ERROR":
      return "Failed to access or update the Google Slides™ document.";
    case "SLIDES_QUOTA_EXHAUSTED":
      return "Google Slides™ API quota was temporarily exhausted. Please retry shortly.";
    case "LLM_PROVIDER_ERROR":
      return "The translation provider returned an invalid response.";
    case "TARGET_LANGUAGE_VALIDATION_FAILED":
      return "The translated output did not match the requested target language. Please retry.";
    case "VERTEX_QUOTA_EXHAUSTED":
      return "Vertex AI quota was temporarily exhausted. Please retry shortly.";
    case "UNSAFE_LLM_INPUT":
      return "All selected slides were excluded due to prompt-injection risk. Remove the risky slide from the translation range and try again.";
    case "JOB_INTERNAL_ERROR":
    default:
      return "The translation job failed due to an internal error.";
  }
}

function getPipelineErrorStatus(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const candidate = error as Error & {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  const status = [candidate.status, candidate.response?.status, candidate.code].find(
    (value) => typeof value === "number"
  );
  return typeof status === "number" ? status : null;
}

function toSafePipelineMessage(error: unknown, fallback: string): string {
  const code = toSlideFailureReasonCode(error);
  if (code !== "JOB_INTERNAL_ERROR") {
    return toSafeErrorMessage(code);
  }

  if (error instanceof CancellationRequestedError) {
    return "Cancellation requested.";
  }

  return fallback;
}

function shouldFinalizeAsPartialSuccess(
  errorCode: string,
  slideResults: ReturnType<typeof initializeJobSlideResults>
): boolean {
  return (
    (errorCode === "SLIDES_QUOTA_EXHAUSTED" || errorCode === "VERTEX_QUOTA_EXHAUSTED") &&
    listJobSlideResults(slideResults).some((slideResult) => slideResult.output_visible)
  );
}

function markUndeliveredSlidesFailedForTerminalError(
  slideResults: ReturnType<typeof initializeJobSlideResults>,
  errorCode: string
): void {
  for (const slideResult of listJobSlideResults(slideResults)) {
    if (slideResult.status === "excluded_unsafe" || slideResult.output_visible) {
      continue;
    }
    if (slideResult.status === "pending" || slideResult.status === "translated") {
      markSlideFailure(slideResults, slideResult.slide_index, "write", errorCode);
    }
  }
}

function getErrorMetadata(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { error_type: typeof error };
  }

  const candidate = error as Error & {
    code?: string;
    status?: number;
    response?: {
      status?: number;
      data?: {
        error?: {
          code?: number;
          message?: string;
          status?: string;
          errors?: Array<{ reason?: string; message?: string }>;
        };
      };
    };
  };

  return {
    error_name: candidate.name,
    error_code: candidate.code,
    error_status: candidate.status ?? candidate.response?.status,
    google_error_code: candidate.response?.data?.error?.code,
    google_error_status: candidate.response?.data?.error?.status,
    google_error_reason: candidate.response?.data?.error?.errors?.[0]?.reason,
    transport_code: candidate.code,
  };
}

function groupNodesBySlide<T extends { slide_index: number }>(
  nodes: readonly T[]
): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const node of nodes) {
    const existing = grouped.get(node.slide_index);
    if (existing) {
      existing.push(node);
      continue;
    }
    grouped.set(node.slide_index, [node]);
  }
  return grouped;
}

function prepareSlidesForDecoupledNotes(
  slides: readonly {
    readonly slide_index: number;
    readonly nodes: readonly SlideTextNode[];
  }[]
): NotesTranslationPreparedSlide[] {
  return slides.map((slide) => {
    const bodyNodes = slide.nodes.filter((node) => node.element_type !== "speaker_notes");
    const noteNodes = slide.nodes.filter((node) => node.element_type === "speaker_notes");
    const notesPromptScan = scanNodesForPromptInjectionRisk(noteNodes);
    const truncated = truncateSpeakerNotesNodes(noteNodes, SPEAKER_NOTES_MAX_CHARS_PER_SLIDE);
    return {
      slide_index: slide.slide_index,
      body_nodes: bodyNodes,
      note_nodes: noteNodes,
      truncated_note_nodes: notesPromptScan.blocked ? [] : truncated.nodes,
      notes_truncated: truncated.truncated,
      notes_prompt_blocked: notesPromptScan.blocked,
    };
  });
}

function truncateSpeakerNotesNodes(
  nodes: readonly SlideTextNode[],
  maxChars: number
): { readonly nodes: readonly SlideTextNode[]; readonly truncated: boolean } {
  const truncatedNodes: SlideTextNode[] = [];
  let remaining = maxChars;
  let truncated = false;

  for (const node of nodes) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    if (node.full_text.length <= remaining) {
      truncatedNodes.push(node);
      remaining -= node.full_text.length;
      continue;
    }

    const truncatedNode = truncateSlideTextNode(node, remaining);
    if (truncatedNode) {
      truncatedNodes.push(truncatedNode);
    }
    truncated = true;
    remaining = 0;
    break;
  }

  return { nodes: truncatedNodes, truncated };
}

function truncateSlideTextNode(
  node: SlideTextNode,
  maxChars: number
): SlideTextNode | null {
  if (maxChars <= 0) {
    return null;
  }

  const paragraphs: typeof node.paragraphs = [];
  let remaining = maxChars;
  let consumed = 0;

  for (let paragraphIndex = 0; paragraphIndex < node.paragraphs.length && remaining > 0; paragraphIndex += 1) {
    const paragraph = node.paragraphs[paragraphIndex]!;
    const newlineBudget = paragraphIndex > 0 ? 1 : 0;
    if (newlineBudget > 0) {
      if (remaining <= newlineBudget) {
        break;
      }
      remaining -= newlineBudget;
      consumed += newlineBudget;
    }

    const paragraphText = paragraph.text.slice(0, remaining);
    if (!paragraphText) {
      break;
    }

    const runs: typeof paragraph.runs = [];
    let paragraphRemaining = paragraphText.length;
    let runOffset = 0;
    for (const run of paragraph.runs) {
      if (paragraphRemaining <= 0) {
        break;
      }
      const runText = run.text.slice(0, paragraphRemaining);
      if (!runText) {
        continue;
      }
      runs.push({
        ...run,
        text: runText,
        start_index: runOffset,
        end_index: runOffset + runText.length,
      });
      runOffset += runText.length;
      paragraphRemaining -= runText.length;
    }

    paragraphs.push({
      ...paragraph,
      text: paragraphText,
      start_index: consumed,
      end_index: consumed + paragraphText.length,
      runs,
    });
    consumed += paragraphText.length;
    remaining -= paragraphText.length;

    if (paragraphText.length < paragraph.text.length) {
      break;
    }
  }

  if (paragraphs.length === 0) {
    return null;
  }

  const fullText = paragraphs.map((paragraph) => paragraph.text).join("\n");
  return {
    ...node,
    text: fullText,
    full_text: fullText,
    paragraphs,
  };
}

function startSpeakerNotesTranslationTasks(
  config: WorkerConfig,
  model: string,
  targetLanguage: string,
  deckTitle: string,
  glossaryCandidates: readonly TranslationContextGlossaryCandidate[],
  preparedSlides: readonly NotesTranslationPreparedSlide[],
  authorityNodes: readonly AuthorityTranslationNode[],
  debugCapture?: LlmDebugCaptureFn
): Map<number, Promise<NotesTranslationOutcome>> {
  const authorityBySlide = groupNodesBySlide(authorityNodes);
  const tasks = new Map<number, Promise<NotesTranslationOutcome>>();

  for (const preparedSlide of preparedSlides) {
    if (preparedSlide.note_nodes.length === 0) {
      continue;
    }

    if (preparedSlide.notes_prompt_blocked) {
      tasks.set(
        preparedSlide.slide_index,
        Promise.resolve({
          slide_index: preparedSlide.slide_index,
          translated_nodes: [],
          prepared_slide: preparedSlide,
          failure_reason_code: "UNSAFE_LLM_INPUT",
          blocked: true,
        })
      );
      continue;
    }

    if (preparedSlide.truncated_note_nodes.length === 0) {
      continue;
    }

    tasks.set(
      preparedSlide.slide_index,
      (async (): Promise<NotesTranslationOutcome> => {
        try {
          const result = await runProviderCallWithRetry(
            `speaker_notes_slide_${preparedSlide.slide_index + 1}`,
            () =>
              translateSpeakerNotesWithVertexGemini(config, {
                model,
                source_language: "auto",
                target_language: targetLanguage,
                deck_title: deckTitle,
                slide_index: preparedSlide.slide_index,
                glossary_candidates: glossaryCandidates,
                slide_plaintext_context: buildSlidePlaintextContext({
                  slide_index: preparedSlide.slide_index,
                  nodes: preparedSlide.body_nodes,
                }),
                slide_authority_nodes: authorityBySlide.get(preparedSlide.slide_index) ?? [],
                note_node_summaries: projectNodesToContextSummaries(
                  preparedSlide.truncated_note_nodes
                ),
                note_source_nodes: preparedSlide.truncated_note_nodes.map((node) => ({
                  node_id: node.node_id,
                  text: node.full_text,
                })),
                notes_truncated: preparedSlide.notes_truncated,
                debugCapture,
                debugLabel: `speaker_notes:slide_${preparedSlide.slide_index + 1}`,
              })
          );
          return {
            slide_index: preparedSlide.slide_index,
            translated_nodes: result.nodes,
            prepared_slide: preparedSlide,
            provider_request_id: result.provider_request_id,
          };
        } catch (error) {
          return {
            slide_index: preparedSlide.slide_index,
            translated_nodes: [],
            prepared_slide: preparedSlide,
            failure_reason_code: toSlideFailureReasonCode(error),
            blocked: false,
          };
        }
      })()
    );
  }

  return tasks;
}

function computeProvisionallyBilledUnits(
  slideResults: ReturnType<typeof initializeJobSlideResults>
): number {
  return listJobSlideResults(slideResults).reduce(
    (sum, slideResult) => sum + (slideResult.provisional_billed_units ?? 0),
    0
  );
}

function collectExistingSlideWriteTargets(
  slideResults: readonly {
    readonly slide_index: number;
    readonly status: string;
    readonly output_slide_object_id?: string;
    readonly object_id_map?: Readonly<Record<string, string>>;
  }[]
): Map<number, ExistingSlideWriteTarget> {
  const targets = new Map<number, ExistingSlideWriteTarget>();
  for (const slideResult of slideResults) {
    if (slideResult.status !== "committed") {
      continue;
    }
    targets.set(slideResult.slide_index, {
      slide_index: slideResult.slide_index,
      output_slide_object_id: slideResult.output_slide_object_id,
      object_id_map: slideResult.object_id_map,
    });
  }
  return targets;
}

function applyNotesWriteResultToSlideResults(
  slideResults: ReturnType<typeof initializeJobSlideResults>,
  writeResult: WriteBackResult,
  nodeResults: JobNodeExecutionResultMap,
  appliedSlideIndexes: Set<number>
): void {
  for (const slideWriteResult of writeResult.slide_results) {
    if (appliedSlideIndexes.has(slideWriteResult.slide_index)) {
      continue;
    }

    if (slideWriteResult.status === "committed") {
      for (const nodeId of slideWriteResult.committed_node_ids ?? []) {
        markNodeWriteSucceeded(nodeResults, nodeId);
      }
      for (const nodeId of slideWriteResult.failed_node_ids ?? []) {
        markNodeWriteFailed(nodeResults, nodeId, "HOST_ADAPTER_ERROR");
      }
      markNotesCommitted(slideResults, slideWriteResult.slide_index);
      syncSlideResultWithNodeTruth(slideResults, nodeResults, slideWriteResult.slide_index, {
        outputSlideObjectId: slideWriteResult.output_slide_object_id,
        sourceSlideObjectId: slideWriteResult.source_slide_object_id,
      });
    } else {
      for (const nodeId of slideWriteResult.failed_node_ids ?? []) {
        markNodeWriteFailed(
          nodeResults,
          nodeId,
          slideWriteResult.error_code ?? "JOB_INTERNAL_ERROR"
        );
      }
      markNotesFailure(
        slideResults,
        slideWriteResult.slide_index,
        "slide_notes_write_failed"
      );
      syncSlideResultWithNodeTruth(slideResults, nodeResults, slideWriteResult.slide_index, {
        sourceSlideObjectId: slideWriteResult.source_slide_object_id,
      });
    }
    appliedSlideIndexes.add(slideWriteResult.slide_index);
  }
}

function combineWriteBackResults(
  left: WriteBackResult,
  right: WriteBackResult
): WriteBackResult {
  const slideResults = new Map<number, WriteBackResult["slide_results"][number]>();
  for (const slideResult of left.slide_results) {
    slideResults.set(slideResult.slide_index, slideResult);
  }
  for (const slideResult of right.slide_results) {
    const existing = slideResults.get(slideResult.slide_index);
    slideResults.set(slideResult.slide_index, { ...existing, ...slideResult });
  }

  const committedSlideIndexes = [...new Set([
    ...left.committed_slide_indexes,
    ...right.committed_slide_indexes,
  ])].sort((a, b) => a - b);
  const committedSet = new Set(committedSlideIndexes);
  const failedSlideIndexes = [...new Set([
    ...left.failed_slide_indexes,
    ...right.failed_slide_indexes,
  ])]
    .filter((slideIndex) => !committedSet.has(slideIndex))
    .sort((a, b) => a - b);

  return {
    outputUrl: right.outputUrl || left.outputUrl,
    committedUnits: committedSlideIndexes.length,
    committed_slide_indexes: committedSlideIndexes,
    failed_slide_indexes: failedSlideIndexes,
    slide_results: [...slideResults.values()].sort(
      (first, second) => first.slide_index - second.slide_index
    ),
    warnings: [...left.warnings, ...right.warnings],
  };
}

function syncSlideResultWithNodeTruth(
  slideResults: ReturnType<typeof initializeJobSlideResults>,
  nodeResults: JobNodeExecutionResultMap,
  slideIndex: number,
  options?: {
    readonly outputSlideObjectId?: string;
    readonly sourceSlideObjectId?: string;
  }
): void {
  const current = slideResults.get(slideIndex);
  if (!current) {
    return;
  }

  const bodyTranslatedNodeCount = countSuccessfulBodyNodes(nodeResults, slideIndex);
  const notesTranslatedNodeCount = countSuccessfulNotesNodes(nodeResults, slideIndex);
  const bodyWrittenNodeCount = countWrittenBodyNodes(nodeResults, slideIndex);
  const notesWrittenNodeCount = countWrittenNotesNodes(nodeResults, slideIndex);
  const bodyFailedNodeCount = countFailedBodyNodes(nodeResults, slideIndex);
  const notesFailedNodeCount = countFailedNotesNodes(nodeResults, slideIndex);
  const notesPresent = Boolean(current.notes_present) || (current.notes_node_count ?? 0) > 0;
  const contentOutputVisible = bodyWrittenNodeCount > 0;
  const notesOutputVisible = notesWrittenNodeCount > 0;
  const outputVisible = contentOutputVisible || notesOutputVisible;
  const bodyNodeCount = current.body_node_count ?? 0;
  const notesNodeCount = current.notes_node_count ?? 0;
  const bodyFullyDelivered =
    bodyNodeCount > 0 &&
    bodyWrittenNodeCount === bodyNodeCount &&
    bodyFailedNodeCount === 0;
  const notesFullyDelivered =
    notesPresent &&
    notesNodeCount > 0 &&
    notesWrittenNodeCount === notesNodeCount &&
    notesFailedNodeCount === 0;
  const finalBilledUnits = roundBillingUnitsForSync(
    (bodyFullyDelivered ? (notesPresent ? 0.5 : 1) : 0) +
      (notesFullyDelivered ? 0.5 : 0)
  );
  const warningCodes = reconcilePartialWarningCodesForSync(
    current.warning_codes,
    contentOutputVisible && notesPresent && !notesOutputVisible
      ? "slide_partial_content_only"
      : !contentOutputVisible && notesPresent && notesOutputVisible
        ? "slide_partial_notes_only"
        : null
  );

  slideResults.set(slideIndex, {
    ...current,
    source_slide_object_id: options?.sourceSlideObjectId ?? current.source_slide_object_id,
    output_slide_object_id: options?.outputSlideObjectId ?? current.output_slide_object_id,
    status:
      current.status === "excluded_unsafe"
        ? current.status
        : outputVisible
          ? "committed"
          : current.status,
    warning_codes: warningCodes,
    output_visible: outputVisible,
    content_translated: bodyTranslatedNodeCount > 0,
    notes_translated: notesTranslatedNodeCount > 0,
    content_output_visible: contentOutputVisible,
    notes_output_visible: notesOutputVisible,
    body_translated_node_count: bodyTranslatedNodeCount,
    notes_translated_node_count: notesTranslatedNodeCount,
    body_failed_node_count: bodyFailedNodeCount,
    notes_failed_node_count: notesFailedNodeCount,
    body_written_node_count: bodyWrittenNodeCount,
    notes_written_node_count: notesWrittenNodeCount,
    final_billable: finalBilledUnits > 0,
    final_billed_units: finalBilledUnits,
    refund_required:
      current.status !== "canceled_after_translation" &&
      (current.provisional_billed_units ?? 0) > finalBilledUnits,
  });
}

function reconcilePartialWarningCodesForSync(
  warningCodes: readonly string[],
  keep: "slide_partial_content_only" | "slide_partial_notes_only" | null
): readonly string[] {
  const filtered = warningCodes.filter(
    (code) => code !== "slide_partial_content_only" && code !== "slide_partial_notes_only"
  );
  if (!keep || filtered.includes(keep)) {
    return filtered;
  }
  return [...filtered, keep];
}

function roundBillingUnitsForSync(value: number): number {
  return Math.round(value * 10) / 10;
}

function syncAllSlideResultsWithNodeTruth(
  slideResults: ReturnType<typeof initializeJobSlideResults>,
  nodeResults: JobNodeExecutionResultMap
): void {
  for (const slideIndex of slideResults.keys()) {
    syncSlideResultWithNodeTruth(slideResults, nodeResults, slideIndex);
  }
}

function buildDeckPlaintextContext(
  slides: readonly {
    readonly slide_index: number;
    readonly nodes: readonly { full_text: string }[];
  }[]
): string {
  return slides.map((slide) => buildSlidePlaintextContext(slide)).join("\n");
}

function buildSlidePlaintextContext(slide: {
  readonly slide_index: number;
  readonly nodes: readonly { full_text: string }[];
}): string {
  return [
    `[Slide ${slide.slide_index + 1}]`,
    ...slide.nodes.map((node) => node.full_text),
  ].join("\n");
}

function orderTranslatedNodes(
  sourceNodes: readonly { node_id: string }[],
  translatedNodes: readonly TranslatedNode[]
): TranslatedNode[] {
  const translatedById = new Map(translatedNodes.map((node) => [node.node_id, node]));
  return sourceNodes.flatMap((sourceNode) => {
    const translatedNode = translatedById.get(sourceNode.node_id);
    return translatedNode ? [translatedNode] : [];
  });
}

function validateTranslatedGroup(
  group: readonly { node_id: string }[],
  translatedNodes: readonly TranslatedNode[]
): void {
  if (translatedNodes.length !== group.length) {
    throw new PipelineError(
      "LLM_PROVIDER_ERROR",
      `Translation returned ${translatedNodes.length} nodes for a group of ${group.length}`
    );
  }

  for (let index = 0; index < group.length; index += 1) {
    const expectedNode = group[index];
    const translatedNode = translatedNodes[index];

    if (!expectedNode || !translatedNode || translatedNode.node_id !== expectedNode.node_id) {
      throw new PipelineError(
        "LLM_PROVIDER_ERROR",
        `Translation node mismatch at group index ${index}`
      );
    }
  }
}
