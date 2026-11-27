/** A text-in, text-out model. It gets no tools, keys or chain access. */
export interface LlmClient {
  complete(system: string, user: string): Promise<string>;
}

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function openAiCompatibleClient(options: OpenAiCompatibleOptions): LlmClient {
  const doFetch = options.fetch ?? fetch;
  return {
    async complete(system, user) {
      const response = await doFetch(`${options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        // A redirect would send the user's text to a destination nobody configured.
        redirect: "error",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          model: options.model,
          temperature: 0,
          // The expected reply is one short JSON object.
          max_tokens: 300,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
      // The response body is deliberately left out of the error: it can echo request data.
      if (!response.ok) throw new Error(`LLM request failed with HTTP ${response.status}`);
      const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("LLM response had no text content");
      return content;
    },
  };
}

/** Returns undefined unless all three variables are set. */
export function llmFromEnv(env: Record<string, string | undefined>): LlmClient | undefined {
  const { LLM_BASE_URL: baseUrl, LLM_API_KEY: apiKey, LLM_MODEL: model } = env;
  return baseUrl && apiKey && model ? openAiCompatibleClient({ baseUrl, apiKey, model }) : undefined;
}
