import Redis from "ioredis";
import type { AppConfig } from "@translay/shared-config";

let client: Redis | null = null;

export function getRedis(config: AppConfig): Redis {
  if (!client) {
    client = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });

    client.on("error", (err) => {
      console.error("Redis connection error:", err.message);
    });

    // I12: Explicitly connect since lazyConnect is enabled
    client.connect().catch((err) => {
      console.error("Redis initial connect failed:", err.message);
    });
  }
  return client;
}

export async function shutdownRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
