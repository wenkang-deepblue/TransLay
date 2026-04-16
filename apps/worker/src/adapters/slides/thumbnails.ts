import { getSlidesAuth, getSlidesClient } from "./auth";
import type { SlideExtractionResult } from "./types";

export interface SlideThumbnail {
  readonly slide_index: number;
  readonly slide_object_id: string;
  readonly mime_type: string;
  /** @internal MUST NOT be persisted, logged, or cached — zero-content-persistence rule. */
  readonly base64_data: string;
}

const DEFAULT_THUMBNAIL_MIME_TYPE = "PNG";
const DEFAULT_THUMBNAIL_SIZE = "LARGE";
const THUMBNAIL_FETCH_TIMEOUT_MS = 45_000;
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
  } = {}
): Promise<SlideThumbnail[]> {
  const size = options.size ?? DEFAULT_THUMBNAIL_SIZE;
  const thumbnails: SlideThumbnail[] = [];
  for (const slide of slides) {
    thumbnails.push(await fetchSlideThumbnail(presentationId, slide, { size }));
  }
  return thumbnails;
}

export async function fetchSlideThumbnail(
  presentationId: string,
  slide: SlideExtractionResult,
  options: {
    readonly size?: ThumbnailSize;
  } = {}
): Promise<SlideThumbnail> {
  const { slides: slidesClient } = getSlidesClient();
  const auth = getSlidesAuth();
  const authClient = await auth.getClient();
  const accessToken = await authClient.getAccessToken();
  const bearerToken =
    typeof accessToken === "string" ? accessToken : accessToken?.token ?? undefined;
  const response = await (slidesClient.presentations.pages as unknown as {
    getThumbnail(args: Record<string, unknown>): Promise<{
      data?: { contentUrl?: string; mimeType?: string };
    }>;
  }).getThumbnail({
    presentationId,
    pageObjectId: slide.slide_object_id,
    "thumbnailProperties.mimeType": DEFAULT_THUMBNAIL_MIME_TYPE,
    "thumbnailProperties.thumbnailSize": options.size ?? DEFAULT_THUMBNAIL_SIZE,
  });

  const contentUrl = response.data?.contentUrl;
  const mimeType = normalizeThumbnailMimeType(response.data?.mimeType);
  if (!contentUrl) {
    throw new Error(`Thumbnail URL missing for slide ${slide.slide_index}`);
  }

  const imageResponse = await fetchThumbnailContent(contentUrl, bearerToken);
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
  const directResponse = await fetchWithTimeout(contentUrl);
  if (directResponse.ok) {
    return directResponse;
  }

  if (!bearerToken) {
    throw new Error(`Failed to fetch slide thumbnail: ${directResponse.status}`);
  }

  const authorizedResponse = await fetchWithTimeout(contentUrl, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  if (!authorizedResponse.ok) {
    throw new Error(`Failed to fetch slide thumbnail: ${authorizedResponse.status}`);
  }

  return authorizedResponse;
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
