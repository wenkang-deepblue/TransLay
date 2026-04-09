#!/usr/bin/env node
import pg from "pg";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const queryBase64 = requireEnv("SQL_QUERY_B64");
const query = Buffer.from(queryBase64, "base64").toString("utf8");

const client = new pg.Client({
  host: process.env.DB_HOST || "127.0.0.1",
  port: parseInt(process.env.DB_PORT || "5432", 10),
  database: process.env.DB_NAME || "translay",
  user: process.env.DB_USER || "translay_app",
  password: requireEnv("DB_PASSWORD"),
});

try {
  await client.connect();
  const result = await client.query(query);
  if (result.command === "SELECT") {
    console.log(JSON.stringify(result.rows, null, 2));
  } else {
    console.log(
      JSON.stringify(
        {
          command: result.command,
          rowCount: result.rowCount ?? 0,
        },
        null,
        2
      )
    );
  }
} finally {
  await client.end().catch(() => {});
}
