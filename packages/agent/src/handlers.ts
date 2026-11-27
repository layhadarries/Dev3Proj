import { serializeReport, type BuiltTransaction, type Intent, type SecurityReport } from "@solguard/shared";
import { z } from "zod";
import { buildTransfer, type BlockhashProvider } from "./builder.js";
import { explainReport } from "./explain.js";
import type { LlmClient } from "./llm.js";
import { parseTransfer } from "./parser.js";

const ParseRequest = z.object({ message: z.string() }).strict();
const BuildRequest = z.object({ confirmationId: z.string().uuid() }).strict();

/**
 * The part of the security package's confirmation gateway that `build` needs, already bound to the
 * request's authenticated session. The agent cannot stage or confirm anything.
 */
export interface Confirmations {
  intent(id: string): Intent;
  inspect(id: string, proposal: BuiltTransaction): Promise<SecurityReport>;
}

export interface AgentDependencies {
  rpc: BlockhashProvider;
  llm?: LlmClient | undefined;
  /** Resolve the session from server state (cookie or store), never from the request body. */
  confirmations: (request: Request) => Confirmations;
}

/** Gateway errors that mean the user has to start over. */
const REJECTED = /^(INTENT_NOT_CONFIRMED|INVALID_CONFIRMATION|INVALID_CONFIRMATION_PHASE|CONFIRMATION_EXPIRED|AUTHENTICATED_DEVNET_SESSION_REQUIRED)$/;
class NotConfirmed extends Error {}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const invalid = () => json({ error: "Invalid request" }, 400);

async function readJson(request: Request): Promise<unknown> {
  // Requiring a JSON content type stops simple cross-site form posts.
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error();
  return request.json();
}

async function handle<S extends z.ZodType>(request: Request, schema: S, run: (input: z.infer<S>) => Promise<unknown>) {
  let input: z.infer<S>;
  try {
    input = schema.parse(await readJson(request));
  } catch {
    return invalid();
  }
  try {
    return json(await run(input));
  } catch (error) {
    if (error instanceof NotConfirmed || (error instanceof Error && REJECTED.test(error.message))) {
      return json({ error: "Confirmation is missing or no longer valid. Start again." }, 409);
    }
    // No internal details: errors can contain RPC URLs with keys.
    return json({ error: "Could not complete the request" }, 502);
  }
}

/**
 * The agent's whole surface: parse, build, explain. There is no sign or submit operation.
 * Each handler is a standard (Request) => Response, so a Next.js route can export it as POST.
 */
export function agentHandlers({ rpc, llm, confirmations }: AgentDependencies) {
  return {
    parse: (request: Request) => handle(request, ParseRequest, ({ message }) => parseTransfer(message, llm)),
    /** Builds from the server-held intent and has it verified. Returns no signable approval. */
    build: (request: Request) =>
      handle(request, BuildRequest, async ({ confirmationId }) => {
        const gateway = confirmations(request);
        const intent = gateway.intent(confirmationId);
        // The gateway refuses unconfirmed drafts; checked again in case another one is plugged in.
        if (intent.confirmedAt <= 0) throw new NotConfirmed();
        const transaction = await buildTransfer(intent, rpc);
        const report = await gateway.inspect(confirmationId, transaction);
        return { transaction, report: serializeReport(report) };
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
