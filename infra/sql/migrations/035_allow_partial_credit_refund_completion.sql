-- 035: Allow a refund request to record provider-side partial completion.
-- This is only for rare provider/API partial failures after one or more
-- underlying Paddle adjustments have already been created.

ALTER TABLE credit_refund_requests
    DROP CONSTRAINT IF EXISTS chk_credit_refund_requests_status;

ALTER TABLE credit_refund_requests
    ADD CONSTRAINT chk_credit_refund_requests_status
        CHECK (status IN (
            'submitted',
            'approved',
            'rejected',
            'completed',
            'partially_completed',
            'canceled'
        ));
