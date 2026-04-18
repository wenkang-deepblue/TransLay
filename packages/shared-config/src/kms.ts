import { KeyManagementServiceClient } from "@google-cloud/kms";

type KmsClientLike = Pick<KeyManagementServiceClient, "encrypt" | "decrypt">;

let client: KmsClientLike | null = null;

function getNodeEnv(): string {
  return process.env.NODE_ENV ?? "development";
}

function getKmsKeyName(): string | null {
  return process.env.KMS_KEY_NAME ?? null;
}

function isProductionLike(): boolean {
  const nodeEnv = getNodeEnv();
  return nodeEnv === "production" || nodeEnv === "staging";
}

function getClient(): KmsClientLike {
  if (!client) {
    client = new KeyManagementServiceClient();
  }
  return client;
}

function assertPlaintext(input: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (typeof input === "string") {
    return Buffer.from(input, "utf8");
  }
  return Buffer.from(input);
}

export async function kmsEncrypt(
  plaintext: Buffer | Uint8Array | string
): Promise<Buffer> {
  const keyName = getKmsKeyName();
  const normalizedPlaintext = assertPlaintext(plaintext);

  if (!keyName) {
    if (isProductionLike()) {
      throw new Error("KMS_KEY_NAME is required when encrypting OAuth tokens in production-like environments");
    }
    return normalizedPlaintext;
  }

  const [response] = await getClient().encrypt({
    name: keyName,
    plaintext: normalizedPlaintext,
  });
  if (!response.ciphertext) {
    throw new Error("KMS encrypt response did not include ciphertext");
  }
  return Buffer.from(response.ciphertext);
}

export async function kmsDecrypt(
  ciphertext: Buffer | Uint8Array | string
): Promise<string> {
  const keyName = getKmsKeyName();
  const normalizedCiphertext =
    typeof ciphertext === "string" ? Buffer.from(ciphertext, "base64") : assertPlaintext(ciphertext);

  if (!keyName) {
    if (isProductionLike()) {
      throw new Error("KMS_KEY_NAME is required when decrypting OAuth tokens in production-like environments");
    }
    return normalizedCiphertext.toString("utf8");
  }

  const [response] = await getClient().decrypt({
    name: keyName,
    ciphertext: normalizedCiphertext,
  });
  if (!response.plaintext) {
    throw new Error("KMS decrypt response did not include plaintext");
  }
  return Buffer.from(response.plaintext).toString("utf8");
}

export function __setKmsClientForTests(nextClient: KmsClientLike | null): void {
  if (isProductionLike()) {
    throw new Error("KMS test hooks are disabled in production-like environments");
  }
  client = nextClient;
}
