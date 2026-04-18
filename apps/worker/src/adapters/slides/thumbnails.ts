import type { Pool } from "pg";
import {
  getSlidesClient,
  getSlidesClientForJob,
  getSlidesAccessToken,
  isUserTokenAuthError,
} from "./auth";
import { getSlidesCallBudget, type SlidesCallBudget } from "./call-budget";
import type { SlideExtractionResult } from "./types";

export interface SlideThumbnail {
  readonly slide_index: number;
  readonly slide_object_id: string;
  readonly mime_type: string;
  /** @internal MUST NOT be persisted, logged, or cached — zero-content-persistence rule. */
  readonly base64_data: string;
}

export type SlideThumbnailCache = Map<string, Promise<SlideThumbnail>>;

const DEFAULT_THUMBNAIL_MIME_TYPE = "PNG";
const DEFAULT_THUMBNAIL_SIZE = "LARGE";
const THUMBNAIL_FETCH_TIMEOUT_MS = 45_000;
const ALLOWED_THUMBNAIL_HOSTS = new Set(["docs.google.com", "googleusercontent.com"]);
export const THUMBNAIL_SIZES = ["SMALL", "MEDIUM", "LARGE"] as const;
export type ThumbnailSize = (typeof THUMBNAIL_SIZES)[number];

export function normalizeThumbnailMimeType(rawMimeType?: string | null): string {
  if (!rawMimeType) {
    return "image/png";
  }

  const normalized = rawMimeType.trim();
  if (!normalized) {
    return "image/png";
  }

  if (normalized.includes("/")) {
    return normalized.toLowerCase();
  }

  switch (normalized.toUpperCase()) {
    case "PNG":
      return "image/png";
    case "JPEG":
    case "JPG":
      return "image/jpeg";
    case "WEBP":
      return "image/webp";
    case "GIF":
      return "image/gif";
    default:
      return `image/${normalized.toLowerCase()}`;
  }
}

export async function fetchSlideThumbnails(
  presentationId: string,
  slides: readonly SlideExtractionResult[],
  options: {
    readonly size?: ThumbnailSize;
    readonly cache?: SlideThumbnailCache;
    readonly budget?: SlidesCallBudget;
    readonly pool?: Pool;
    readonly jobId?: string;
  } = {}
): Promise<SlideThumbnail[]> {
  const size = options.size ?? DEFAULT_THUMBNAIL_SIZE;
  const thumbnails: SlideThumbnail[] = [];
  for (const slide of slides) {
    thumbnails.push(await fetchSlideThumbnail(presentationId, slide, {
      size,
      cache: options.cache,
      budget: options.budget,
      pool: options.pool,
      jobId: options.jobId,
    }));
  }
  return thumbnails;
}

export async function fetchSlideThumbnail(
  presentationId: string,
  slide: SlideExtractionResult,
  options: {
    readonly size?: ThumbnailSize;
    readonly cache?: SlideThumbnailCache;
    readonly budget?: SlidesCallBudget;
    readonly pool?: Pool;
    readonly jobId?: string;
  } = {}
): Promise<SlideThumbnail> {
  const cacheKey = `${presentationId}:${slide.slide_object_id}:${options.size ?? DEFAULT_THUMBNAIL_SIZE}`;
  if (options.cache?.has(cacheKey)) {
    return options.cache.get(cacheKey)!;
  }

  const pending = fetchSlideThumbnailUncached(presentationId, slide, options);
  if (options.cache) {
    options.cache.set(cacheKey, pending);
  }
  try {
    return await pending;
  } catch (error) {
    options.cache?.delete(cacheKey);
    throw error;
  }
}

async function fetchSlideThumbnailUncached(
  presentationId: string,
  slide: SlideExtractionResult,
  options: {
    readonly size?: ThumbnailSize;
    readonly budget?: SlidesCallBudget;
    readonly pool?: Pool;
    readonly jobId?: string;
  }
): Promise<SlideThumbnail> {
  const authContext =
    options.pool && options.jobId
      ? await getSlidesClientForJob(options.jobId, options.pool)
      : null;
  const getSlidesApi = () => authContext?.slides ?? getSlidesClient().slides;
  const getCurrentBearerToken = () =>
    getSlidesAccessToken(authContext?.auth ?? getSlidesClient().auth);
  const budget = options.budget ?? getSlidesCallBudget();
  const response = await budget.expensiveRead(
    () =>
      (getSlidesApi().presentations.pages as unknown as {
        getThumbnail(args: Record<string, unknown>): Promise<{
          data?: { contentUrl?: string; mimeType?: string };
        }>;
      }).getThumbnail({
        presentationId,
        pageObjectId: slide.slide_object_id,
        "thumbnailProperties.mimeType": DEFAULT_THUMBNAIL_MIME_TYPE,
        "thumbnailProperties.thumbnailSize": options.size ?? DEFAULT_THUMBNAIL_SIZE,
      }),
    {
      jobId: options.jobId,
      opName: "slides.presentations.pages.getThumbnail",
      authContext: authContext ?? undefined,
    }
  );

  const contentUrl = response.data?.contentUrl;
  const mimeType = normalizeThumbnailMimeType(response.data?.mimeType);
  if (!contentUrl) {
    throw new Error(`Thumbnail URL missing for slide ${slide.slide_index}`);
  }

  let imageResponse: Response;
  try {
    const bearerToken = await getCurrentBearerToken();
    imageResponse = await fetchThumbnailContent(contentUrl, bearerToken);
  } catch (error) {
    const errorStatus =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : null;
    if (
      authContext &&
      authContext.source === "user" &&
      (errorStatus === 401 || errorStatus === 403 || isUserTokenAuthError(error))
    ) {
      await authContext.fallbackToServiceAccount("slides_thumbnail_content_auth_error", error);
      const fallbackBearerToken = await getCurrentBearerToken();
      imageResponse = await fetchThumbnailContent(contentUrl, fallbackBearerToken);
    } else {
      throw error;
    }
  }
  return {
    slide_index: slide.slide_index,
    slide_object_id: slide.slide_object_id,
    mime_type: mimeType,
    base64_data: Buffer.from(await imageResponse.arrayBuffer()).toString("base64"),
  };
}

async function fetchThumbnailContent(
  contentUrl: string,
  bearerToken: string | null | undefined
): Promise<Response> {
  const validatedUrl = validateThumbnailContentUrl(contentUrl);
  const directResponse = await fetchWithTimeout(validatedUrl, {
    redirect: "manual",
  });
  if (directResponse.ok) {
    return directResponse;
  }

  if (!bearerToken) {
    throw Object.assign(new Error(`Failed to fetch slide thumbnail: ${directResponse.status}`), {
      status: directResponse.status,
    });
  }

  const authorizedResponse = await fetchWithTimeout(validatedUrl, {
    redirect: "manual",
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  if (!authorizedResponse.ok) {
    throw Object.assign(
      new Error(`Failed to fetch slide thumbnail: ${authorizedResponse.status}`),
      {
        status: authorizedResponse.status,
      }
    );
  }

  return authorizedResponse;
}

function validateThumbnailContentUrl(contentUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(contentUrl);
  } catch {
    throw new Error("Slides thumbnail URL is invalid");
  }

  const hostname = parsed.hostname.toLowerCase();
  const allowedHost =
    ALLOWED_THUMBNAIL_HOSTS.has(hostname) || hostname.endsWith(".googleusercontent.com");
  if (parsed.protocol !== "https:" || !allowedHost) {
    throw new Error("Slides thumbnail URL host is not allowed");
  }

  return parsed.toString();
}

async function fetchWithTimeout(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), THUMBNAIL_FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
