import { NextResponse, type NextRequest } from "next/server";
import { createSecurityHeaders } from "./lib/server/security-headers";

export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const headers = createSecurityHeaders(nonce, request.nextUrl, process.env.NODE_ENV === "production");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", headers.get("content-security-policy") ?? "");

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  headers.forEach((value, key) => response.headers.set(key, value));
  return response;
}

export const config = {
  matcher: ["/:path*"],
};
