/** Same-origin JSON calls to the app's routes. */
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
      throw new Error(typeof error === "string" ? error : `${route} failed (HTTP ${response.status})`);
    }
    return data as T;
  };
