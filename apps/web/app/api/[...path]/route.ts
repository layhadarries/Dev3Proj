import { applicationHandlers } from "../../../lib/server/application";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const route = path.join("/");
  const handler = {
    "session/challenge": applicationHandlers.challenge,
    session: applicationHandlers.signIn,
    parse: applicationHandlers.parse,
    stage: applicationHandlers.stage,
    confirm: applicationHandlers.confirm,
    build: applicationHandlers.build,
    explain: applicationHandlers.explain,
    acknowledge: applicationHandlers.acknowledge,
    handoff: applicationHandlers.handoff,
    submit: applicationHandlers.submit,
  }[route];
  if (!handler) {
    return Response.json({ error: "Not found" }, {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }
  return handler(request);
}
