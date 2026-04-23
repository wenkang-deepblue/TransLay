/**
 * Redis key used to fan out cooperative cancellation signals between the
 * control-plane and worker without duplicating key format logic.
 */
export function buildJobCancelKey(jobId: string): string {
  return `job_cancel:${jobId}`;
}

/**
 * Redis key used for cooperative pause / resume signals between the control
 * plane and the worker while preserving in-memory pipeline state.
 */
export function buildJobPauseKey(jobId: string): string {
  return `job_pause:${jobId}`;
}
