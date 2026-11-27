import { dispatchApiRoute, notFound } from "../../../lib/server/route-dispatch";

export const runtime = "nodejs";


export async function POST(request: Request, context: { params: Promise<{ path?: unknown }> }) {
  const { path } = await context.params;
  if (!Array.isArray(path) || path.length === 0 ||
      path.some((segment) => typeof segment !== "string" || segment.length === 0)) {
    return notFound();
  }
  return dispatchApiRoute(path.join("/"), request);
}
