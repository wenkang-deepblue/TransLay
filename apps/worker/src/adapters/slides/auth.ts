import { google } from "googleapis";

let clients:
  | {
      auth: InstanceType<typeof google.auth.GoogleAuth>;
      slides: ReturnType<typeof google.slides>;
    }
  | null = null;

/** Get authenticated Slides API client using default credentials. */
export function getSlidesClient(): {
  auth: InstanceType<typeof google.auth.GoogleAuth>;
  slides: ReturnType<typeof google.slides>;
} {
  if (clients) {
    return clients;
  }

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/presentations"],
  });

  clients = {
    auth,
    slides: google.slides({ version: "v1", auth }),
  };

  return clients;
}

export function getSlidesAuth(): InstanceType<typeof google.auth.GoogleAuth> {
  return getSlidesClient().auth;
}
