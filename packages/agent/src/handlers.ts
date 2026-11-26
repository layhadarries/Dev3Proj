import { AddressSchema, BaseUnitsSchema, IntentSchema, SecurityReportSchema } from "@solguard/shared";
import { z } from "zod";
import { buildTransfer, confirmIntent, type BlockhashProvider } from "./builder";
import { explainReport } from "./explain";
import type { LlmClient } from "./llm";
import { parseTransfer } from "./parser";

const ParseRequest = z.strictObject({ message: z.string() });
const BuildRequest = z.strictObject({
  draft: z.strictObject({ recipient: AddressSchema, amountBaseUnits: z.string().refine((s) => BaseUnitsSchema.safeParse(s).success) }),
  payer: AddressSchema,
  confirmed: z.literal(true),
});

export interface AgentDependencies {
  rpc: BlockhashProvider;
  llm?: LlmClient;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function handle<T>(request: Request, schema: z.ZodType<T>, run: (input: T) => Promise<unknown>) {
  let input: T;
  try {
    // Requiring a JSON content type stops simple cross-site form posts.
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error();
    input = schema.parse(await request.json());
  } catch {
    return json({ error: "Invalid request" }, 400);
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
        return { intent: z.encode(IntentSchema, intent), transaction: await buildTransfer(intent, rpc) };
      }),
    explain: (request: Request) =>
      handle(
        request,
        z.custom<Parameters<typeof explainReport>[0]>((v) => SecurityReportSchema.safeParse(v).success),
        async (report) => explainReport(report),
      ),
  };
}
