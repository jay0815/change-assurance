import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvalRun, validatePastedOutput } from "./artifacts.js";

const DEFAULT_PORT = 4177;
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "../public");

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  payload: string,
): void {
  response.writeHead(statusCode, { "content-type": contentType });
  response.end(payload);
}

function contentTypeFor(path: string): string {
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function safePublicPath(pathname: string): string {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = resolve(PUBLIC_DIR, relativePath);
  if (!resolved.startsWith(PUBLIC_DIR) || extname(resolved) === "") {
    return join(PUBLIC_DIR, "index.html");
  }
  return resolved;
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = "";
    request.setEncoding("utf-8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) {
        request.destroy(new Error("Request body too large"));
      }
    });
    request.on("end", () => resolveBody(body));
    request.on("error", reject);
  });
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  if (request.method === "GET" && url.pathname === "/api/run") {
    const outputDir = url.searchParams.get("outputDir");
    if (!outputDir) {
      sendJson(response, 400, { error: "outputDir is required" });
      return;
    }
    try {
      sendJson(response, 200, loadEvalRun(outputDir));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/validate") {
    try {
      const body = JSON.parse(await readRequestBody(request)) as { text?: string };
      sendJson(response, 200, validatePastedOutput(body.text ?? ""));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

export function createEvalWebServer() {
  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url);
        return;
      }

      try {
        const filePath = safePublicPath(url.pathname);
        sendText(response, 200, contentTypeFor(filePath), readFileSync(filePath, "utf-8"));
      } catch {
        sendJson(response, 404, { error: "Not found" });
      }
    })();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  createEvalWebServer().listen(port, "127.0.0.1", () => {
    console.log(`Eval web console: http://localhost:${port}`);
  });
}
