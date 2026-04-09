import { google } from "googleapis";

let clients:
  | {
      slides: ReturnType<typeof google.slides>;
    }
  | null = null;

/** Get authenticated Slides API client using default credentials. */
export function getSlidesClient(): {
  slides: ReturnType<typeof google.slides>;
} {
  if (clients) {
    return clients;
  }

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/presentations"],
  });

  clients = {
    slides: google.slides({ version: "v1", auth }),
  };

  return clients;
}
