import test from "node:test";
import assert from "node:assert/strict";
import {
  __setKmsClientForTests,
  kmsDecrypt,
  kmsEncrypt,
} from "./index";

test("kms helpers pass through plaintext in development without KMS", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalKeyName = process.env.KMS_KEY_NAME;
  delete process.env.KMS_KEY_NAME;
  process.env.NODE_ENV = "development";

  try {
    const encrypted = await kmsEncrypt("plain-token");
    assert.equal(encrypted.toString("utf8"), "plain-token");
    assert.equal(await kmsDecrypt("plain-token"), "plain-token");
    assert.equal(await kmsDecrypt(encrypted), "plain-token");
  } finally {
    __setKmsClientForTests(null);
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalKeyName === undefined) {
      delete process.env.KMS_KEY_NAME;
    } else {
      process.env.KMS_KEY_NAME = originalKeyName;
    }
  }
});

test("kms helpers use configured KMS client in development", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalKeyName = process.env.KMS_KEY_NAME;
  process.env.NODE_ENV = "development";
  process.env.KMS_KEY_NAME = "projects/test/locations/global/keyRings/ring/cryptoKeys/key";

  const fakeClient = {
    async encrypt({
      plaintext,
    }: {
      readonly name: string;
      readonly plaintext?: Buffer;
    }) {
      return [
        { ciphertext: Buffer.from(`enc:${plaintext?.toString("utf8") ?? ""}`, "utf8") },
        undefined,
        undefined,
      ] as [unknown, undefined, undefined];
    },
    async decrypt({
      ciphertext,
    }: {
      readonly name: string;
      readonly ciphertext?: Buffer;
    }) {
      const raw = ciphertext?.toString("utf8") ?? "";
      return [
        { plaintext: Buffer.from(raw.replace(/^enc:/, ""), "utf8") },
        undefined,
        undefined,
      ] as [unknown, undefined, undefined];
    },
  } as unknown as NonNullable<Parameters<typeof __setKmsClientForTests>[0]>;

  try {
    __setKmsClientForTests(fakeClient);
    const encrypted = await kmsEncrypt("secret-token");
    assert.equal(encrypted.toString("utf8"), "enc:secret-token");
    assert.equal(await kmsDecrypt(encrypted), "secret-token");
    assert.equal(
      await kmsDecrypt(Buffer.from(encrypted).toString("base64")),
      "secret-token"
    );
  } finally {
    __setKmsClientForTests(null);
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalKeyName === undefined) {
      delete process.env.KMS_KEY_NAME;
    } else {
      process.env.KMS_KEY_NAME = originalKeyName;
    }
  }
});
