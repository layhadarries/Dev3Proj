import { Base58PubkeySchema, serializeIntent } from "@solguard/shared";
import { z } from "zod";
import { buildTransfer, confirmIntent, type BlockhashProvider } from "./builder.js";
import { explainReport } from "./explain.js";
import type { LlmClient } from "./llm.js";
import { parseTransfer } from "./parser.js";

const ParseRequest = z.object({ message: z.string() }).strict();
const BuildRequest = z
  .object({
    draft: z.object({ recipient: Base58PubkeySchema, amountBaseUnits: z.string().regex(/^[1-9]\d{0,19}$/) }).strict(),
    payer: Base58PubkeySchema,
    confirmed: z.literal(true),
  })
  .strict();

export interface AgentDependencies {
  rpc: BlockhashProvider;
  llm?: LlmClient | undefined;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const invalid = () => json({ error: "Invalid request" }, 400);

async function readJson(request: Request): Promise<unknown> {
  // Requiring a JSON content type stops simple cross-site form posts.
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error();
  return request.json();
}

async function handle<S extends z.ZodTypeAny>(request: Request, schema: S, run: (input: z.infer<S>) => Promise<unknown>) {
  let input: z.infer<S>;
  try {
    input = schema.parse(await readJson(request));
  } catch {
    return invalid();
  }
  try {
    return json(await run(input));
  } catch {
    // No internal details: errors can contain RPC URLs with keys.
    return json({ error: "Could not complete the request" }, 502);
  }
}

/**
 * The agent's whole surface: parse, build, explain. There is no sign or submit operation.
 * Each handler is a standard (Request) => Response, so a Next.js route can export it as POST.
 */
export function agentHandlers({ rpc, llm }: AgentDependencies) {
  return {
    parse: (request: Request) => handle(request, ParseRequest, ({ message }) => parseTransfer(message, llm)),
    build: (request: Request) =>
      handle(request, BuildRequest, async ({ draft, payer }) => {
        const intent = confirmIntent(draft, payer);
        return { intent: serializeIntent(intent), transaction: await buildTransfer(intent, rpc) };
      }),
    explain: async (request: Request) => {
      try {
        return json(explainReport(await readJson(request)));
      } catch {
        return invalid();
      }
    },
  };
}
