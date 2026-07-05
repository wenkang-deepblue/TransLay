import { GoogleAuth } from "google-auth-library";

type KmsClientLike = {
  readonly encrypt: (request: {
    readonly name: string;
    readonly plaintext?: Buffer;
  }) => Promise<readonly [{ readonly ciphertext?: Buffer | Uint8Array | string | null }]>;
  readonly decrypt: (request: {
    readonly name: string;
    readonly ciphertext?: Buffer;
  }) => Promise<readonly [{ readonly plaintext?: Buffer | Uint8Array | string | null }]>;
};

let client: KmsClientLike | null = null;
let auth: GoogleAuth | null = null;

const CLOUD_KMS_API_BASE_URL = "https://cloudkms.googleapis.com/v1";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

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
    client = {
      encrypt: async ({ name, plaintext }) => {
        const response = await kmsFetch(name, "encrypt", {
          plaintext: Buffer.from(plaintext ?? Buffer.alloc(0)).toString("base64"),
        });
        return [{ ciphertext: readBase64Response(response, "ciphertext", "encrypt") }];
      },
      decrypt: async ({ name, ciphertext }) => {
        const response = await kmsFetch(name, "decrypt", {
          ciphertext: Buffer.from(ciphertext ?? Buffer.alloc(0)).toString("base64"),
        });
        return [{ plaintext: readBase64Response(response, "plaintext", "decrypt") }];
      },
    };
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

  if (!keyName) {
    if (isProductionLike()) {
      throw new Error("KMS_KEY_NAME is required when decrypting OAuth tokens in production-like environments");
    }
    if (typeof ciphertext === "string") {
      return ciphertext;
    }
    return assertPlaintext(ciphertext).toString("utf8");
  }

  const normalizedCiphertext =
    typeof ciphertext === "string" ? Buffer.from(ciphertext, "base64") : assertPlaintext(ciphertext);

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

async function kmsFetch(
  keyName: string,
  method: "encrypt" | "decrypt",
  body: Readonly<Record<string, string>>
): Promise<Record<string, unknown>> {
  const token = await getAccessToken();
  const response = await fetch(`${kmsResourceUrl(keyName)}:${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await readErrorMessage(response);
    throw new Error(
      `KMS ${method} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`
    );
  }

  return (await response.json()) as Record<string, unknown>;
}

function kmsResourceUrl(keyName: string): string {
  return `${CLOUD_KMS_API_BASE_URL}/${keyName
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

function readBase64Response(
  response: Readonly<Record<string, unknown>>,
  field: "ciphertext" | "plaintext",
  operation: "encrypt" | "decrypt"
): Buffer {
  const value = response[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`KMS ${operation} response did not include ${field}`);
  }
  return Buffer.from(value, "base64");
}

async function getAccessToken(): Promise<string> {
  if (!auth) {
    auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
  }

  const authClient = await auth.getClient();
  const accessToken = await authClient.getAccessToken();
  const token = typeof accessToken === "string" ? accessToken : accessToken?.token;
  if (!token) {
    throw new Error("Google auth did not return an access token for KMS");
  }
  return token;
}

async function readErrorMessage(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  if (!body) {
    return "";
  }

  try {
    const parsed = JSON.parse(body) as { readonly error?: { readonly message?: string } };
    return parsed.error?.message ?? body;
  } catch {
    return body;
  }
}
