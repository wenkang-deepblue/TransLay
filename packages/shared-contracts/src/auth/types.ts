/** Branded type to prevent accidental ID swapping. */
type Brand<T, B extends string> = T & { readonly __brand: B };

export type UserId = Brand<string, "UserId">;
export type GoogleSubjectId = Brand<string, "GoogleSubjectId">;
export type JobId = Brand<string, "JobId">;

/** Minimal user identity shape shared across API responses. */
export interface UserSummary {
  readonly google_subject_id: string;
  readonly email: string | null;
  readonly display_name: string | null;
}

/** Verified Google identity extracted from token validation. */
export interface GoogleIdentity {
  readonly google_subject_id: GoogleSubjectId;
  readonly email: string | null;
  readonly display_name: string | null;
}

/** Authenticated request context attached after token verification. */
export interface AuthContext {
  readonly identity: GoogleIdentity;
  readonly user_id: UserId;
}
