import test from "node:test";
import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import { replaceJobLayoutSemanticHintsForSlide } from "./job-layout-semantic-hint-repo";

test("replaceJobLayoutSemanticHintsForSlide treats PoolClient as an already-connected client", async () => {
  const queryCalls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queryCalls.push({ sql, values: values ?? [] });
      return { rowCount: 1 };
    },
    release: () => undefined,
    connect: async () => {
      throw new Error("connect should not be called for PoolClient");
    },
  } as unknown as PoolClient;

  await replaceJobLayoutSemanticHintsForSlide(client, "job-1", 2, [
    {
      node_id: "node-1",
      visual_role: "body",
      cluster_id: "cluster-1",
      line_policy: "allow_wrap",
      scale_sync: "independent",
      confidence: 0.9,
    },
  ]);

  assert.equal(queryCalls.length, 2);
  assert.match(queryCalls[0]?.sql ?? "", /DELETE FROM job_layout_semantic_hints/);
  assert.match(queryCalls[1]?.sql ?? "", /INSERT INTO job_layout_semantic_hints/);
});

test("replaceJobLayoutSemanticHintsForSlide wraps Pool calls in a transaction", async () => {
  const queryCalls: Array<{ sql: string; values: unknown[] }> = [];
  let released = false;
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queryCalls.push({ sql, values: values ?? [] });
      return { rowCount: 1 };
    },
    release: () => {
      released = true;
    },
  } as unknown as PoolClient;

  const pool = {
    connect: async () => client,
  } as unknown as Pool;

  await replaceJobLayoutSemanticHintsForSlide(pool, "job-2", 0, []);

  assert.deepEqual(
    queryCalls.map((call) => call.sql),
    [
      "BEGIN",
      `DELETE FROM job_layout_semantic_hints
     WHERE job_id = $1
       AND slide_index = $2`,
      "COMMIT",
    ]
  );
  assert.equal(released, true);
});
