#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

async function run() {
  const statusOnly = process.argv.includes("--status");

  // Fail fast if DB_PASSWORD is not set
  if (!process.env.DB_PASSWORD) {
    console.error("Error: DB_PASSWORD environment variable is required.");
    process.exit(1);
  }

  const portRaw = parseInt(process.env.DB_PORT || "5432", 10);
  if (isNaN(portRaw)) {
    console.error(`Error: DB_PORT is not a valid number: ${process.env.DB_PORT}`);
    process.exit(1);
  }

  // Cloud SQL connections from Cloud Run use Unix socket (no SSL needed).
  // Local dev connects via Cloud SQL Auth Proxy on 127.0.0.1 (also no SSL needed).
  // Direct-IP production connections should use the proxy sidecar pattern instead
  // of rejectUnauthorized:false, which is vulnerable to MITM.
  const client = new pg.Client({
    host: process.env.DB_HOST || "127.0.0.1",
    port: portRaw,
    database: process.env.DB_NAME || "translay",
    user: process.env.DB_USER || "translay_app",
    password: process.env.DB_PASSWORD,
  });

  try {
    await client.connect();
  } catch (err) {
    console.error("Failed to connect to database:", err.message);
    process.exit(1);
  }

  try {
    // Ensure tracker table exists
    const trackerSql = await readFile(
      join(MIGRATIONS_DIR, "000_migrations_tracker.sql"),
      "utf-8"
    );
    await client.query(trackerSql);

    // List applied migrations
    const { rows: applied } = await client.query(
      "SELECT filename FROM _migrations ORDER BY id"
    );
    const appliedSet = new Set(applied.map((r) => r.filename));

    // Read migration files
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql") && f !== "000_migrations_tracker.sql")
      .sort();

    if (statusOnly) {
      console.log("Migration status:");
      for (const f of files) {
        const mark = appliedSet.has(f) ? "[applied]" : "[pending]";
        console.log(`  ${mark} ${f}`);
      }
      return;
    }

    let count = 0;
    for (const file of files) {
      if (appliedSet.has(file)) continue;

      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8");
      console.log(`Applying: ${file}`);

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO _migrations (filename) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        count++;
      } catch (migrationErr) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackErr) {
          console.error(`ROLLBACK also failed:`, rollbackErr.message);
        }
        console.error(`Failed on ${file}:`, migrationErr.message);
        process.exit(1);
      }
    }

    console.log(
      count > 0
        ? `Done. Applied ${count} migration(s).`
        : "All migrations already applied."
    );
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error("Migration error:", err);
  process.exit(1);
});
