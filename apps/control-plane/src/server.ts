import express, { type Request, type Response, type NextFunction } from "express";

const app = express();

const portRaw = parseInt(process.env.PORT ?? "8080", 10);
if (isNaN(portRaw) || portRaw < 1 || portRaw > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}
const PORT = portRaw;

app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Global error handler — returns structured JSON, never raw stack traces.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({
    error: "JOB_INTERNAL_ERROR",
    message: "Internal server error",
  });
});

const server = app.listen(PORT, () => {
  console.log(`TransLay control-plane listening on port ${PORT}`);
});

server.on("error", (err) => {
  console.error("Server failed to start:", err);
  process.exit(1);
});
