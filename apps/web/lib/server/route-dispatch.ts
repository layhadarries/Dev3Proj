import { applicationHandlers } from "./application";

export function notFound(): Response {
  return Response.json({ error: "Not found" }, {
    status: 404,
    headers: { "cache-control": "no-store" },
  });
}

export function dispatchApiRoute(route: string, request: Request): Promise<Response> {
  const handlers = new Map<string, (request: Request) => Promise<Response>>([
    ["session/challenge", applicationHandlers.challenge],
    ["session", applicationHandlers.signIn],
    ["session/logout", applicationHandlers.logout],
    ["parse", applicationHandlers.parse],
    ["stage", applicationHandlers.stage],
    ["confirm", applicationHandlers.confirm],
    ["build", applicationHandlers.build],
    ["explain", applicationHandlers.explain],
    ["acknowledge", applicationHandlers.acknowledge],
    ["handoff", applicationHandlers.handoff],
    ["submit", applicationHandlers.submit],
  ]);
  const handler = handlers.get(route);
  if (!handler) return Promise.resolve(notFound());
  return handler(request);
}
