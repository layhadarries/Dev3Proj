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

/** Far above a 300-token reply with its envelope. */
export const MAX_REPLY_BYTES = 64 * 1024;

async function readBounded(response: Response): Promise<string> {
  // Count the bytes as they arrive, because Content-Length may be missing or wrong.
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    // Leaving the loop cancels the rest of the stream.
    if (size > MAX_REPLY_BYTES) throw new Error("LLM response was too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
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
        // A small model on a busy laptop CPU can take longer than half a minute.
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      });
      // The response body is deliberately left out of the error: it can echo request data.
      if (!response.ok) throw new Error(`LLM request failed with HTTP ${response.status}`);
      const body = JSON.parse(await readBounded(response)) as { choices?: { message?: { content?: unknown } }[] };
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
