import { Pool } from "pg";
import type { AppConfig } from "@translay/shared-config";

let pool: Pool | null = null;

export function getPool(config: AppConfig): Pool {
  if (!pool) {
    pool = new Pool({
      host: config.db.host,
      port: config.db.port,
      database: config.db.name,
      user: config.db.user,
      password: config.db.password,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    pool.on("error", (err) => {
      console.error("Unexpected PostgreSQL pool error:", err.message);
    });
  }
  return pool;
}

export async function shutdownPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
