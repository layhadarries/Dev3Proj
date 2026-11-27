/** Same-origin JSON calls to the app's routes. */
/** A refusal or failure reported by the server. A lost response is a plain Error instead. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True when the reply carried the app's own error message. */
    readonly explained = true,
  ) {
    super(message);
  }
}

export type Api = <T>(route: string, body: unknown) => Promise<T>;

export const createApi = (send: typeof fetch = (...args) => fetch(...args)): Api =>
  async <T>(route: string, body: unknown) => {
    const response = await send(`/api/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok || data === null) {
      const error = (data as { error?: unknown } | null)?.error;
      const explained = typeof error === "string";
      throw new ApiError(explained ? error : `${route} failed (HTTP ${response.status})`, response.status, explained);
    }
    return data as T;
  };
