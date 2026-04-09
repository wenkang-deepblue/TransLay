import express, { type Request, type Response, type NextFunction } from "express";
import { loadWorkerConfig } from "@translay/shared-config";
import { getPool, shutdownPool } from "./db/pool";
import { getRedis, shutdownRedis } from "./cache/redis";
import { taskHandler } from "./handlers/task-handler";

const config = loadWorkerConfig();
const app = express();
const pool = getPool(config);
const redis = getRedis(config);

app.use(express.json({ limit: "1mb" }));
app.set("trust proxy", 1);

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "worker", time: new Date().toISOString() });
});

// Cloud Tasks entry point
app.post("/tasks/translate", taskHandler(pool, redis, config));

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled worker error:", err.message || "unknown");
  res.status(500).json({ error: "INTERNAL_ERROR" });
});

const server = app.listen(config.port, () => {
  console.log(`TransLay worker listening on port ${config.port}`);
});

server.on("error", (err) => {
  console.error("Worker server failed to start:", err.message || "unknown");
  process.exit(1);
});

async function shutdown() {
  console.log("Worker shutting down...");
  server.close();
  await Promise.allSettled([shutdownPool(), shutdownRedis()]);
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
