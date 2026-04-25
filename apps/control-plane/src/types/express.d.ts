import type { AuthContext } from "@translay/shared-contracts";

declare global {
  namespace Express {
    interface Request {
      authContext?: AuthContext;
      rawBody?: Buffer;
      portalSession?: {
        userId: string;
        createdAt: string;
        avatarUrl?: string;
      };
    }
  }
}
