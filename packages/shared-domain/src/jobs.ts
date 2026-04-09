/**
 * Redis key used to fan out cooperative cancellation signals between the
 * control-plane and worker without duplicating key format logic.
 */
export function buildJobCancelKey(jobId: string): string {
  return `job_cancel:${jobId}`;
}
