# TransLay Redis Key Specifications

> This document defines all Redis keys used by the system.
> Redis is hot-state only — never business truth.

## Keys

### `job_progress:{job_id}`

- **Type**: Hash
- **Fields**: `status`, `progress_percent`, `current_step`, `details`
- **TTL**: 24h
- **Writer**: Worker
- **Reader**: Control plane (job status polling)

### `portal_ticket:{ticket}`

- **Type**: Hash
- **Fields**: `user_id`, `redirect_path`, `reason`, `consumed`
- **TTL**: 60s
- **Writer**: Control plane (session/start)
- **Reader**: Control plane (session/consume)
- **Security**: One-time use. Mark `consumed=1` atomically on read. Never reuse.

### `portal_session:{session_id}`

- **Type**: Hash
- **Fields**: `user_id`, `created_at`, `expires_at`
- **TTL**: 7d (or per product policy)
- **Writer**: Control plane (session/consume)
- **Reader**: Control plane (session/me, authenticated Portal requests)
- **Security**: session_id is a CSPRNG-generated opaque token, stored in HttpOnly cookie only.

### `entitlement:{user_id}`

- **Type**: String (JSON-serialized EntitlementResponse)
- **TTL**: 300s (frozen decision per internal project guidance)
- **Writer**: Control plane (after computing entitlement from DB)
- **Reader**: Control plane (GET /api/entitlement, before DB query)
- **Invalidation**: Delete on subscription change (webhook processing).

### `ratelimit:{scope}:{identifier}`

- **Type**: String (counter)
- **TTL**: Per window (e.g. 60s for per-minute limits)
- **Scopes**: `api`, `checkout`, `webhook`, `job_create`
- **Identifiers**: `google_subject_id`, `ip`
- **Security**: Applied before any business logic to prevent abuse.

### `lang_norm:{input_hash}`

- **Type**: String (normalized language code)
- **TTL**: 30d
- **Writer**: Worker (after successful normalization)
- **Reader**: Worker (before calling LLM for normalization)
