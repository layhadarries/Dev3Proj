export function createSecurityHeaders(
  nonce: string,
  requestUrl: URL,
  isProduction: boolean,
): Headers {
  const scriptSources = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  const connectSources = ["'self'"];

  if (!isProduction) {
    scriptSources.push("'unsafe-eval'");
    const websocketProtocol = requestUrl.protocol === "https:" ? "wss:" : "ws:";
    connectSources.push(`${websocketProtocol}//${requestUrl.host}`);
  }

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'none'",
    "script-src-attr 'none'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectSources.join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    "worker-src 'self'",
  ];

  const headers = new Headers({
    "content-security-policy": directives.join("; "),
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "bluetooth=()",
      "accelerometer=()",
      "gyroscope=()",
      "magnetometer=()",
      "fullscreen=()",
    ].join(", "),
  });

  if (isProduction && requestUrl.protocol === "https:") {
    headers.set("strict-transport-security", "max-age=31536000");
    headers.set("content-security-policy", `${directives.join("; ")}; upgrade-insecure-requests`);
  }

  return headers;
}
