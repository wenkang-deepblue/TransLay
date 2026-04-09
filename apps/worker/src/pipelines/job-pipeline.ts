import type { Pool } from "pg";
import type Redis from "ioredis";
import type { WorkerConfig } from "@translay/shared-config";
import type {
  TaskPayload,
  TranslationRequest,
  TranslationNode,
} from "@translay/shared-contracts";
import {
  matchPresetLanguage,
  billingPeriodKey,
  parsePageRange,
  buildJobCancelKey,
} from "@translay/shared-domain";
import { getJobById, isCancelRequested, updateJobStatus } from "../repositories/job-repo";
import { insertUsageLedger } from "../repositories/usage-repo";
import { setJobProgress } from "../cache/job-progress";
import { extractSlides } from "../adapters/slides";
import { writeBackAppend, writeBackNewFile, type WriteBackResult } from "../adapters/slides";
import { selectRoute, translate } from "../providers/router";

/**
 * Main job pipeline: extract → translate → write-back.
 * Updates job status and Redis progress at each step.
 * On failure, marks job as failed with error details.
 * On success, writes usage ledger in a transaction.
 */
export async function runJobPipeline(
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

  // Guard: only process pending/queued jobs
  if (job.status !== "pending" && job.status !== "queued") {
    console.log(`Job ${job_id} already in status ${job.status}, skipping`);
    return;
  }

  const route = selectRoute(config, job.user_id as string);
  console.log(`Job ${job_id} route selected: ${route.provider}/${route.model}`);
  let writeResult: WriteBackResult = { outputUrl: "", committedUnits: 0 };

  try {
    await assertNotCanceled(pool, redis, job, writeResult);

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
    await assertNotCanceled(pool, redis, job, writeResult);

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

    const extraction = await extractSlides(job.source_doc_id, pageIndices);
    console.log(
      `Job ${job_id} extraction completed: ${extraction.extracted_slides.length} slides, ${extraction.all_nodes.length} nodes`
    );

    if (extraction.all_nodes.length === 0) {
      throw new PipelineError(
        "HOST_ADAPTER_ERROR",
        "No translatable text found in the selected slides"
      );
    }

    const totalSlides = extraction.extracted_slides.length;
    await assertNotCanceled(pool, redis, job, writeResult);

    // --- TRANSLATING ---
    console.log(`Job ${job_id} entering translating stage`);
    await updateJobStatus(pool, job_id, "translating");
    await setJobProgress(redis, job_id, {
      status: "translating",
      progress_percent: 30,
      current_step: "translating_segments",
      details: `Translating ${extraction.all_nodes.length} text segments`,
    });

    // Resolve target language code
    const targetLangCode =
      job.target_language_code ??
      matchPresetLanguage(job.target_language_input) ??
      job.target_language_input;

    const translationNodes: TranslationNode[] = extraction.all_nodes.map(
      (n) => ({ node_id: n.node_id, text: n.text })
    );

    // Build context: use full document text if within token budget.
    // Rough estimate: 1 token ≈ 4 chars for mixed-language content.
    const contextText = truncateToTokenBudget(
      extraction.full_context_text,
      config.vertex.maxInputTokens
    );

    const translationRequest: TranslationRequest = {
      provider: route.provider,
      model: route.model,
      source_language: "auto",
      target_language: targetLangCode,
      nodes: translationNodes,
      context_text: contextText || undefined,
    };

    const translationResult = await translate(config, translationRequest);
    console.log(
      `Job ${job_id} translation completed: ${translationResult.nodes.length} translated nodes`
    );

    // Validate response integrity
    if (translationResult.nodes.length !== translationNodes.length) {
      throw new PipelineError(
        "LLM_PROVIDER_ERROR",
        `Translation returned ${translationResult.nodes.length} nodes, expected ${translationNodes.length}`
      );
    }

    await setJobProgress(redis, job_id, {
      status: "translating",
      progress_percent: 70,
      current_step: "translating_segments",
      details: "Translation complete, preparing to write back",
    });
    await assertNotCanceled(pool, redis, job, writeResult);

    // --- WRITING ---
    console.log(`Job ${job_id} entering writing stage with mode ${job.output_mode}`);
    await updateJobStatus(pool, job_id, "writing");
    await setJobProgress(redis, job_id, {
      status: "writing",
      progress_percent: 80,
      current_step: "writing_back",
      details: `Writing translated content back to ${job.output_mode === "create_new_file" ? "new file" : "presentation"}`,
    });
    await assertNotCanceled(pool, redis, job, writeResult);

    const onCommitted = async (result: WriteBackResult) => {
      writeResult = result;
      await updateJobStatus(pool, job_id, "writing", {
        totalUnitsBilled: result.committedUnits,
        outputDocumentUrl: result.outputUrl,
      });
      await assertNotCanceled(pool, redis, job, writeResult);
    };

    if (job.output_mode === "create_new_file") {
      if (!job.target_doc_id) {
        throw new PipelineError(
          "HOST_ADAPTER_ERROR",
          "Target presentation ID is required for create_new_file"
        );
      }

      writeResult = await writeBackNewFile(
        job.target_doc_id,
        extraction.extracted_slides,
        translationResult.nodes,
        onCommitted
      );
    } else {
      writeResult = await writeBackAppend(
        job.source_doc_id,
        extraction.extracted_slides,
        translationResult.nodes,
        onCommitted
      );
    }
    console.log(`Job ${job_id} write-back completed`);

    if (writeResult.committedUnits !== totalSlides) {
      throw new PipelineError(
        "JOB_INTERNAL_ERROR",
        `Committed ${writeResult.committedUnits} slides, expected ${totalSlides}`
      );
    }

    await finalizeSuccessfulJob(pool, redis, job, job_id, targetLangCode, writeResult);
    console.log(`Job ${job_id} completed successfully: ${writeResult.outputUrl}`);
  } catch (err) {
    if (err instanceof CancellationRequestedError) {
      console.log(
        `Job ${job_id} canceled after ${err.writeResult.committedUnits} committed slides`
      );
      await finalizeCanceledJob(pool, redis, job, job_id, err.writeResult);
      return;
    }

    const error = err as PipelineError | Error;
    const errorCode =
      error instanceof PipelineError ? error.code : "JOB_INTERNAL_ERROR";
    const safeMessage = toSafeErrorMessage(errorCode);
    console.error(
      `Job ${job_id} internal failure metadata:`,
      JSON.stringify({
        pipeline_error_code: errorCode,
        ...getErrorMetadata(error),
      })
    );

    console.error(`Job ${job_id} failed [${errorCode}]:`, safeMessage);

    try {
      await updateJobStatus(pool, job_id, "failed", {
        errorCode,
        errorMessage: safeMessage,
      });

      await setJobProgress(redis, job_id, {
        status: "failed",
        progress_percent: 0,
        current_step: "failed",
        details: safeMessage,
      });
      await redis.del(buildJobCancelKey(job_id));
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
    public readonly writeResult: WriteBackResult
  ) {
    super("Cancellation requested");
    this.name = "CancellationRequestedError";
  }
}

async function assertNotCanceled(
  pool: Pool,
  redis: Redis,
  job: Awaited<ReturnType<typeof getJobById>>,
  writeResult: WriteBackResult
): Promise<void> {
  if (!job) {
    return;
  }

  const cancelRequested = await redis.get(buildJobCancelKey(job.id));
  if (cancelRequested) {
    throw new CancellationRequestedError(writeResult);
  }

  if (await isCancelRequested(pool, job.id)) {
    throw new CancellationRequestedError(writeResult);
  }
}

async function finalizeSuccessfulJob(
  pool: Pool,
  redis: Redis,
  job: NonNullable<Awaited<ReturnType<typeof getJobById>>>,
  jobId: string,
  targetLangCode: string,
  writeResult: WriteBackResult
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await updateJobStatus(client, jobId, "completed", {
      outputDocumentUrl: writeResult.outputUrl,
      totalUnitsBilled: writeResult.committedUnits,
      targetLangCode,
    });

    if (writeResult.committedUnits > 0) {
      await insertUsageLedger(client, {
        userId: job.user_id,
        jobId: job.id,
        hostType: "slides",
        usageUnit: "slides",
        quantity: writeResult.committedUnits,
        periodKey: billingPeriodKey(),
        reason: "translate_slides",
      });
    }

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
      status: "completed",
      progress_percent: 100,
      current_step: "completed",
      details: "Translation completed successfully.",
    }),
    redis.del(buildJobCancelKey(jobId)),
  ]);
}

async function finalizeCanceledJob(
  pool: Pool,
  redis: Redis,
  job: NonNullable<Awaited<ReturnType<typeof getJobById>>>,
  jobId: string,
  writeResult: WriteBackResult
): Promise<void> {
  const client = await pool.connect();
  const detail = buildCanceledDetail(job.output_mode, writeResult.committedUnits);

  try {
    await client.query("BEGIN");

    await updateJobStatus(client, jobId, "canceled", {
      outputDocumentUrl: writeResult.outputUrl || undefined,
      totalUnitsBilled: writeResult.committedUnits,
    });

    if (writeResult.committedUnits > 0) {
      await insertUsageLedger(client, {
        userId: job.user_id,
        jobId: job.id,
        hostType: "slides",
        usageUnit: "slides",
        quantity: writeResult.committedUnits,
        periodKey: billingPeriodKey(),
        reason: "translate_slides",
      });
    }

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
      progress_percent: writeResult.committedUnits > 0 ? 100 : 0,
      current_step: "canceled",
      details: detail,
    }),
    redis.del(buildJobCancelKey(jobId)),
  ]);
}

function buildCanceledDetail(outputMode: string, committedUnits: number): string {
  if (outputMode === "create_new_file") {
    if (committedUnits > 0) {
      return `Canceled after generating the translated presentation. ${committedUnits} slides were billed.`;
    }
    return "Canceled before the translated presentation was generated. No quota was charged.";
  }

  if (committedUnits > 0) {
    return `Canceled after writing ${committedUnits} translated slides. Only visible slides were billed.`;
  }

  return "Canceled before any translated slides were written. No quota was charged.";
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
    case "HOST_ADAPTER_ERROR":
      return "Failed to access or update the Google Slides™ document.";
    case "LLM_PROVIDER_ERROR":
      return "The translation provider returned an invalid response.";
    case "JOB_INTERNAL_ERROR":
    default:
      return "The translation job failed due to an internal error.";
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
    error_message: candidate.message,
  };
}

/**
 * Truncate context text to fit within the token budget.
 * Uses a conservative 1 token ≈ 4 chars estimate for mixed-language content.
 * Returns empty string if context would exceed budget.
 */
function truncateToTokenBudget(text: string, maxTokens: number): string {
  // Mixed-language slides often land between Chinese and Latin token densities,
  // so we keep the 4-char heuristic as a conservative cross-language budget.
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  // Truncate at last complete line within budget
  const truncated = text.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  return lastNewline > 0
    ? truncated.slice(0, lastNewline) + "\n[...context truncated]"
    : truncated + "\n[...context truncated]";
}
