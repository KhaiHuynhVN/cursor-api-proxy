import * as http from "node:http";

export function extractBearerToken(req: http.IncomingMessage): string | undefined {
  // Check Authorization: Bearer first
  const h = req.headers["authorization"];
  if (h) {
    const val = Array.isArray(h) ? h[0] : h;
    const match = val.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1];
  }
  // Fallback: x-api-key header (used by Anthropic SDK / CLIProxyAPI)
  const xKey = req.headers["x-api-key"];
  if (xKey) return Array.isArray(xKey) ? xKey[0] : xKey;
  return undefined;
}

export function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: http.OutgoingHttpHeaders,
) {
  res.writeHead(status, {
    ...extraHeaders,
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(body));
}

export function writeSseHeaders(
  res: http.ServerResponse,
  extraHeaders?: http.OutgoingHttpHeaders,
): void {
  res.writeHead(200, {
    ...extraHeaders,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

export async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
