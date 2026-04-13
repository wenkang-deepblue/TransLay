import type { Pool } from "pg";
import type Redis from "ioredis";
import type { WorkerConfig } from "@translay/shared-config";
import type {
  AuthorityTranslationResponse,
  AuthorityTranslationNode,
  JobWarning,
  TaskPayload,
  TranslationResponse,
  TranslatedNode,
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
import { extractSlides, type SlideTextNode } from "../adapters/slides";
import { annotateSlidesWithLayoutSemanticsBestEffort } from "../adapters/slides/layout-semantics";
import { buildDeckStoryboard } from "../adapters/slides/storyboard";
import { writeBackAppend, writeBackNewFile, type WriteBackResult } from "../adapters/slides";
import { selectRoute } from "../providers/router";
import {
  fillMissingAuthorityWithVertexGemini,
  materializeTranslatedNodesWithVertexGemini,
  translateDeckAuthorityWithVertexGemini,
} from "../providers/vertex-gemini-authority";
import { requestSlideLayoutSemanticsWithVertexGemini } from "../providers/vertex-gemini-layout";
import { scanSlidesForPromptInjectionRisk } from "../providers/llm-prompt-safety";
import {
  extractGlossaryCandidates,
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
  markSlideCanceledAfterTranslation,
  markSlideExcludedUnsafe,
  markSlideFailure,
  markSlideCommitted,
  markSlideTranslated,
} from "./slide-results";

const MAX_PROVIDER_ATTEMPTS_PER_BATCH = 3;

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
  let writeResult: WriteBackResult = {
    outputUrl: "",
    committedUnits: 0,
    committed_slide_indexes: [],
    failed_slide_indexes: [],
    slide_results: [],
    warnings: [],
  };
  const pipelineWarnings: JobWarning[] = [];
  const billedSlideIndexes = new Set<number>();
  let translatedUnitsBilled = 0;
  let slideResults = initializeJobSlideResults([]);

  try {
    await assertNotCanceled(pool, redis, job, writeResult, translatedUnitsBilled);

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
    await assertNotCanceled(pool, redis, job, writeResult, translatedUnitsBilled);

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

    const promptInjectionScan = scanSlidesForPromptInjectionRisk(extraction.extracted_slides);
    slideResults = initializeJobSlideResults(
      extraction.extracted_slides.map((slide) => slide.slide_index)
    );
    for (const slideIndex of promptInjectionScan.hard_block_slide_indices) {
      markSlideExcludedUnsafe(slideResults, slideIndex);
    }
    const excludedSlideIndices = new Set(promptInjectionScan.hard_block_slide_indices);
    const safeSlides = extraction.extracted_slides.filter(
      (slide) => !excludedSlideIndices.has(slide.slide_index)
    );
    pipelineWarnings.push(
      ...buildUnsafeSlideExcludedWarnings(extraction.extracted_slides, promptInjectionScan.hard_block_slide_indices)
    );
    if (safeSlides.length === 0) {
      const slideLabels = promptInjectionScan.hard_block_slide_indices.map((slideIndex) => slideIndex + 1);
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
    await assertNotCanceled(pool, redis, job, writeResult, translatedUnitsBilled);

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
    const targetLangCode =
      job.target_language_code ??
      matchPresetLanguage(job.target_language_input) ??
      job.target_language_input;

    const deckPlaintextContext = extractionForTranslation.full_context_text;
    const providerRequestIds: string[] = [];
    const storyboard = await buildDeckStoryboard(job.source_doc_id, extractionForTranslation.extracted_slides);
    await setJobProgress(redis, job_id, {
      status: "translating",
      progress_percent: 35,
      current_step: "layout_semantics",
      details: `Analyzing layout semantics for ${extractionForTranslation.extracted_slides.length} safe slide(s)`,
    });
    await assertNotCanceled(pool, redis, job, writeResult, translatedUnitsBilled);

    const slidesWithLayoutHints = await annotateSlidesWithLayoutSemanticsBestEffort(
      extractionForTranslation.extracted_slides,
      storyboard,
      async (input) =>
        runProviderCallWithRetry(
          `layout_semantics_slide_${input.slide_index + 1}`,
          () =>
            requestSlideLayoutSemanticsWithVertexGemini(config, {
              model: route.model,
              ...input,
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
    await assertNotCanceled(pool, redis, job, writeResult, translatedUnitsBilled);

    let authorityResult: AuthorityTranslationResponse | null = null;
    try {
      authorityResult = await runProviderCallWithRetry("authority_batch_1", () =>
        translateDeckAuthorityWithVertexGemini(config, {
          model: route.model,
          source_language: "auto",
          target_language: targetLangCode,
          deck_title: extractionWithLayoutHints.title,
          deck_plaintext_context: deckPlaintextContext,
          glossary_candidates: glossaryCandidates,
          nodes: projectNodesToAuthoritySourceNodes(extractionWithLayoutHints.all_nodes),
          storyboard,
        })
      );
    } catch (error) {
      console.warn(
        `Authority batch failed; falling back to slide-level recovery: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    if (authorityResult) {
      providerRequestIds.push(authorityResult.provider_request_id);
    }

    let authorityNodes = authorityResult?.nodes ?? [];
    let authorityAudit = auditAuthorityCoverage(extractionWithLayoutHints.all_nodes, authorityNodes);
    if (authorityAudit.missing_nodes.length > 0) {
      await setJobProgress(redis, job_id, {
        status: "translating",
        progress_percent: 45,
        current_step: "gap_fill",
        details: `Filling ${authorityAudit.missing_nodes.length} authority coverage gap(s)`,
      });
      await assertNotCanceled(pool, redis, job, writeResult, translatedUnitsBilled);

      const missingNodesBySlide = groupNodesBySlide(authorityAudit.missing_nodes);
      const slideByIndex = new Map(
        extractionWithLayoutHints.extracted_slides.map((slide) => [slide.slide_index, slide])
      );
      const frameBySlideIndex = new Map(
        storyboard.frames.map((frame) => [frame.slide_index, frame])
      );
      const gapFilledNodes: AuthorityTranslationNode[] = [];

      for (const [slideIndex, missingNodes] of missingNodesBySlide) {
        const slide = slideByIndex.get(slideIndex);
        if (!slide) {
          markSlideFailure(slideResults, slideIndex, "authority", "JOB_INTERNAL_ERROR");
          console.warn(
            `Skipping slide ${slideIndex + 1} during authority gap-fill because extracted slide context is missing`
          );
          continue;
        }

        let gapFillResult: AuthorityTranslationResponse;
        try {
          gapFillResult = await runProviderCallWithRetry(
            `gap_fill_slide_${slideIndex + 1}`,
            () =>
              fillMissingAuthorityWithVertexGemini(config, {
                model: route.model,
                source_language: "auto",
                target_language: targetLangCode,
                deck_title: extractionWithLayoutHints.title,
                slide_index: slideIndex,
                slide_plaintext_context: buildSlidePlaintextContext(slide),
                glossary_candidates: glossaryCandidates,
                existing_authority_nodes: authorityNodes,
                missing_nodes: projectNodesToAuthoritySourceNodes(missingNodes),
                storyboard_frame: frameBySlideIndex.get(slideIndex),
              })
          );
        } catch (error) {
          markSlideFailure(
            slideResults,
            slideIndex,
            "authority",
            toSlideFailureReasonCode(error)
          );
          continue;
        }
        providerRequestIds.push(gapFillResult.provider_request_id);
        gapFilledNodes.push(...gapFillResult.nodes);
        await assertNotCanceled(pool, redis, job, writeResult, translatedUnitsBilled);
      }

      authorityNodes = mergeAuthorityNodes(authorityNodes, gapFilledNodes);
      authorityAudit = auditAuthorityCoverage(extractionWithLayoutHints.all_nodes, authorityNodes);
    }

    if (authorityAudit.missing_nodes.length > 0) {
      markSlideFailures(
        slideResults,
        uniqueSlideIndices(authorityAudit.missing_nodes),
        "authority",
        "LLM_PROVIDER_ERROR"
      );
    }

    const authorityReadySlides = selectSlidesReadyForMaterialization(
      extractionWithLayoutHints.extracted_slides,
      slideResults
    );
    if (authorityReadySlides.length === 0) {
      throw new PipelineError(
        "LLM_PROVIDER_ERROR",
        "Authority translation could not recover any safe slide"
      );
    }

    const authorityReadyNodeIds = new Set(
      authorityReadySlides.flatMap((slide) => slide.nodes.map((node) => node.node_id))
    );
    authorityNodes = authorityNodes.filter((node) => authorityReadyNodeIds.has(node.node_id));

    const materializationGroups = buildMaterializationGroups(
      authorityReadySlides,
      {
        maxNodesPerGroup: 10,
        maxCharsPerGroup: 2_000,
      }
    );
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
          markSlideFailure(
            slideResults,
            nodeSummary.slide_index,
            "authority",
            "JOB_INTERNAL_ERROR"
          );
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
              target_language: targetLangCode,
              deck_title: extractionWithLayoutHints.title,
              glossary_candidates: glossaryCandidates,
              node_summaries: group.node_summaries,
              authority_nodes: authoritySubset,
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
          materializationQueue.splice(groupIndex, 1, ...explodedGroups);
          groupIndex -= 1;
          continue;
        }
        markSlideFailures(
          slideResults,
          groupSlideIndices,
          "materialization",
          toSlideFailureReasonCode(error)
        );
        continue;
      }

      try {
        validateTranslatedGroup(group.node_summaries, groupResult.nodes);
      } catch (error) {
        markSlideFailures(
          slideResults,
          groupSlideIndices,
          "materialization",
          toSlideFailureReasonCode(error)
        );
        continue;
      }
      translatedNodes.push(...groupResult.nodes);
      providerRequestIds.push(groupResult.provider_request_id);

      const newlyTranslatedSlideIndexes = registerTranslatedNodesBySlide(
        pendingNodeIdsBySlide,
        group.node_summaries
      );
      for (const slideIndex of newlyTranslatedSlideIndexes) {
        markSlideTranslated(slideResults, slideIndex);
      }

      const billedBefore = translatedUnitsBilled;
      translatedUnitsBilled = registerBilledSlides(
        billedSlideIndexes,
        newlyTranslatedSlideIndexes
      );
      if (translatedUnitsBilled !== billedBefore) {
        await updateJobStatus(pool, job_id, "translating", {
          totalUnitsBilled: translatedUnitsBilled,
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
          `${translatedUnitsBilled} slide(s) already count toward quota.`,
      });
      await assertNotCanceled(pool, redis, job, writeResult, translatedUnitsBilled);
    }

    let writableSlides = selectSlidesReadyForWrite(
      authorityReadySlides,
      slideResults
    );
    let writableSourceNodes = writableSlides.flatMap((slide) => slide.nodes);
    if (writableSlides.length === 0) {
      throw new PipelineError(
        "LLM_PROVIDER_ERROR",
        "Materialization could not produce any deliverable slide"
      );
    }

    let orderedTranslatedNodes: TranslatedNode[];
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
      const recoveredWritableSlides = selectSlidesReadyForWrite(authorityReadySlides, slideResults);
      const recoveredWritableSourceNodes = recoveredWritableSlides.flatMap((slide) => slide.nodes);
      if (recoveredWritableSlides.length === 0) {
        throw new PipelineError(
          "LLM_PROVIDER_ERROR",
          "Materialization could not recover any deliverable slide"
        );
      }
      writableSlides = recoveredWritableSlides;
      writableSourceNodes = recoveredWritableSourceNodes;
      orderedTranslatedNodes = orderTranslatedNodes(
        recoveredWritableSourceNodes,
        translatedNodes
      );
    }

    const translationResult = {
      provider_request_id: JSON.stringify(providerRequestIds),
      nodes: orderedTranslatedNodes,
    };
    console.log(
      `Job ${job_id} translation completed: ${translationResult.nodes.length} translated nodes`
    );

    // Validate response integrity
    if (translationResult.nodes.length !== writableSourceNodes.length) {
      throw new PipelineError(
        "LLM_PROVIDER_ERROR",
        `Translation returned ${translationResult.nodes.length} nodes, expected ${writableSourceNodes.length}`
      );
    }

    await setJobProgress(redis, job_id, {
      status: "translating",
      progress_percent: 70,
      current_step: "translating_segments",
      details: `Translation complete for ${writableSlides.length} deliverable slide(s), preparing to write back`,
    });
    await assertNotCanceled(pool, redis, job, writeResult, translatedUnitsBilled);

    // --- WRITING ---
    console.log(`Job ${job_id} entering writing stage with mode ${job.output_mode}`);
    await updateJobStatus(pool, job_id, "writing");
    await setJobProgress(redis, job_id, {
      status: "writing",
      progress_percent: 80,
      current_step: "writing_back",
      details: `Writing translated content back to ${job.output_mode === "create_new_file" ? "new file" : "presentation"}`,
    });
    await assertNotCanceled(pool, redis, job, writeResult, translatedUnitsBilled);
    const appliedWriteSlideIndexes = new Set<number>();
    const onWriteProgress = async (result: WriteBackResult) => {
      writeResult = result;
      applyWriteResultToSlideResults(
        slideResults,
        result,
        appliedWriteSlideIndexes
      );
      await updateJobStatus(pool, job_id, "writing", {
        totalUnitsBilled: translatedUnitsBilled,
        outputDocumentUrl: result.outputUrl,
      });
      await assertNotCanceled(pool, redis, job, writeResult, translatedUnitsBilled);
    };

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
          onWriteProgress
        );
      } else {
        writeResult = await writeBackAppend(
          job.source_doc_id,
          writableSlides,
          translationResult.nodes,
          onWriteProgress
        );
      }
    } catch (error) {
      applyWriteResultToSlideResults(
        slideResults,
        writeResult,
        appliedWriteSlideIndexes
      );
      throw error;
    }
    console.log(`Job ${job_id} write-back completed`);

    applyWriteResultToSlideResults(
      slideResults,
      writeResult,
      appliedWriteSlideIndexes
    );

    if (writeResult.committedUnits === 0) {
      throw new PipelineError(
        "JOB_INTERNAL_ERROR",
        "Writer could not commit any deliverable slide"
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
      translatedUnitsBilled
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
      await finalizeCanceledJob(pool, redis, job, job_id, err.writeResult, err.billedUnits);
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
        slide_results: listJobSlideResults(slideResults),
        ...getErrorMetadata(error),
      })
    );

    console.error(`Job ${job_id} failed [${errorCode}]:`, safeMessage);

    try {
      await finalizeFailedJob(
        pool,
        redis,
        job,
        job_id,
        writeResult,
        pipelineWarnings,
        translatedUnitsBilled,
        errorCode,
        safeMessage
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
  billedUnits: number
): Promise<void> {
  const client = await pool.connect();
  const finalWarnings = [...pipelineWarnings, ...writeResult.warnings];
  const completedStatus = finalWarnings.length > 0 || hasSlideExecutionWarnings(slideResults)
    ? "completed_with_warnings"
    : "completed";
  const completionDetail = buildSuccessfulCompletionDetail(finalWarnings.length, slideResults);
  try {
    await client.query("BEGIN");

    await updateJobStatus(client, jobId, completedStatus, {
      outputDocumentUrl: writeResult.outputUrl,
      totalUnitsBilled: billedUnits,
      targetLangCode,
      warnings: finalWarnings,
    });

    if (billedUnits > 0) {
      await insertUsageLedger(client, {
        userId: job.user_id,
        jobId: job.id,
        hostType: "slides",
        usageUnit: "slides",
        quantity: billedUnits,
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
      status: completedStatus,
      progress_percent: 100,
      current_step: completedStatus,
      details: completionDetail,
    }),
    redis.del(buildJobCancelKey(jobId)),
  ]);
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
  billedUnits: number
): Promise<void> {
  const client = await pool.connect();
  const detail = buildCanceledDetail(billedUnits);

  try {
    await client.query("BEGIN");

    await updateJobStatus(client, jobId, "canceled", {
      outputDocumentUrl: writeResult.outputUrl || undefined,
      totalUnitsBilled: billedUnits,
    });

    if (billedUnits > 0) {
      await insertUsageLedger(client, {
        userId: job.user_id,
        jobId: job.id,
        hostType: "slides",
        usageUnit: "slides",
        quantity: billedUnits,
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
      progress_percent: billedUnits > 0 ? 100 : 0,
      current_step: "canceled",
      details: detail,
    }),
    redis.del(buildJobCancelKey(jobId)),
  ]);
}

async function finalizeFailedJob(
  pool: Pool,
  redis: Redis,
  job: NonNullable<Awaited<ReturnType<typeof getJobById>>>,
  jobId: string,
  writeResult: WriteBackResult,
  pipelineWarnings: readonly JobWarning[],
  billedUnits: number,
  errorCode: string,
  safeMessage: string
): Promise<void> {
  const client = await pool.connect();
  const finalWarnings = [...pipelineWarnings, ...writeResult.warnings];
  try {
    await client.query("BEGIN");

    await updateJobStatus(client, jobId, "failed", {
      errorCode,
      errorMessage: safeMessage,
      outputDocumentUrl: writeResult.outputUrl || undefined,
      totalUnitsBilled: billedUnits,
      warnings: finalWarnings,
    });

    if (billedUnits > 0) {
      await insertUsageLedger(client, {
        userId: job.user_id,
        jobId: job.id,
        hostType: "slides",
        usageUnit: "slides",
        quantity: billedUnits,
        periodKey: billingPeriodKey(),
        reason: "translate_slides",
      });
    }

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
  appliedSlideIndexes?: Set<number>
): void {
  for (const slideResult of writeResult.slide_results) {
    if (appliedSlideIndexes?.has(slideResult.slide_index)) {
      continue;
    }

    if (slideResult.status === "committed") {
      markSlideCommitted(slideResults, slideResult.slide_index);
    } else {
      markSlideFailure(
        slideResults,
        slideResult.slide_index,
        "write",
        slideResult.error_code ?? "JOB_INTERNAL_ERROR"
      );
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
  slideResults: ReturnType<typeof initializeJobSlideResults>
): T[] {
  return slides.filter((slide) => slideResults.get(slide.slide_index)?.status === "translated");
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
        error instanceof Error ? error.message : String(error)
      );
      if (attempt >= MAX_PROVIDER_ATTEMPTS_PER_BATCH || !isRetryableProviderError(error)) {
        throw error;
      }
      await delay(attempt * 500);
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
  return (
    group.node_summaries.length > 1 &&
    error instanceof Error &&
    /paragraph count does not match source structure|bullet_list paragraph count mismatch|paragraph_id mismatch/i.test(
      error.message
    )
  );
}

function registerBilledSlides(
  billedSlideIndexes: Set<number>,
  slideIndexes: readonly number[]
): number {
  for (const slideIndex of slideIndexes) {
    billedSlideIndexes.add(slideIndex);
  }
  return billedSlideIndexes.size;
}

function toSlideFailureReasonCode(error: unknown): string {
  return error instanceof PipelineError ? error.code : "JOB_INTERNAL_ERROR";
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
  applyWriteResultToSlideResults(slideResults, writeResult);
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

function isRetryableProviderError(error: unknown): boolean {
  const status = extractProviderHttpStatus(error);
  if (status !== null) {
    return status === 408 || status === 429 || status === 500 || status === 503 || status >= 500;
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
    case "HOST_ADAPTER_ERROR":
      return "Failed to access or update the Google Slides™ document.";
    case "LLM_PROVIDER_ERROR":
      return "The translation provider returned an invalid response.";
    case "UNSAFE_LLM_INPUT":
      return "All selected slides were excluded due to prompt-injection risk. Remove the risky slide from the translation range and try again.";
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
  return sourceNodes.map((sourceNode) => {
    const translatedNode = translatedById.get(sourceNode.node_id);
    if (!translatedNode) {
      throw new PipelineError(
        "LLM_PROVIDER_ERROR",
        `Translated node missing for ${sourceNode.node_id}`
      );
    }
    return translatedNode;
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

