import { GoogleAuth } from "google-auth-library";

const CLOUD_TASKS_API_BASE_URL = "https://cloudtasks.googleapis.com/v2";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

let auth: GoogleAuth | null = null;

export interface CloudTasksHttpTaskOptions {
  readonly parent: string;
  readonly name: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly payload: unknown;
  readonly serviceAccountEmail: string;
  readonly audience?: string;
  readonly dispatchDeadlineSeconds?: number;
  readonly scheduleTime?: Date;
}

export function buildCloudTasksQueueName(
  projectId: string,
  location: string,
  queueName: string
): string {
  return `projects/${projectId}/locations/${location}/queues/${queueName}`;
}

export function buildCloudTaskName(
  projectId: string,
  location: string,
  queueName: string,
  taskId: string
): string {
  return `${buildCloudTasksQueueName(projectId, location, queueName)}/tasks/${taskId}`;
}

export async function createCloudTasksHttpTask(
  options: CloudTasksHttpTaskOptions
): Promise<void> {
  const task: Record<string, unknown> = {
    name: options.name,
    httpRequest: {
      httpMethod: "POST",
      url: options.url,
      headers: options.headers ?? {},
      body: Buffer.from(JSON.stringify(options.payload)).toString("base64"),
      oidcToken: {
        serviceAccountEmail: options.serviceAccountEmail,
        ...(options.audience ? { audience: options.audience } : {}),
      },
    },
  };

  if (options.dispatchDeadlineSeconds !== undefined) {
    task.dispatchDeadline = `${options.dispatchDeadlineSeconds}s`;
  }
  if (options.scheduleTime) {
    task.scheduleTime = options.scheduleTime.toISOString();
  }

  const response = await cloudTasksFetch(`${resourceUrl(options.parent)}/tasks`, {
    method: "POST",
    body: JSON.stringify({ task }),
  });

  if (response.ok || response.status === 409) {
    return;
  }

  throw await buildCloudTasksError(response, "create task");
}

export async function deleteCloudTask(name: string): Promise<void> {
  const response = await cloudTasksFetch(resourceUrl(name), { method: "DELETE" });

  if (response.ok || response.status === 404) {
    return;
  }

  throw await buildCloudTasksError(response, "delete task");
}

function resourceUrl(resourceName: string): string {
  return `${CLOUD_TASKS_API_BASE_URL}/${resourceName
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

async function cloudTasksFetch(
  url: string,
  init: { readonly method: "POST" | "DELETE"; readonly body?: string }
): Promise<Response> {
  const token = await getAccessToken();
  return fetch(url, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body,
  });
}

async function getAccessToken(): Promise<string> {
  if (!auth) {
    auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
  }

  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();
  const token = typeof accessToken === "string" ? accessToken : accessToken?.token;
  if (!token) {
    throw new Error("Google auth did not return an access token for Cloud Tasks");
  }
  return token;
}

async function buildCloudTasksError(response: Response, action: string): Promise<Error> {
  const detail = await readErrorMessage(response);
  return new Error(
    `Cloud Tasks ${action} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`
  );
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
