// Standalone Bun TLS proxy — run with: bun dist/bun-proxy.mjs [port]
// Forwards requests using Bun's native fetch (BoringSSL TLS fingerprint).

const debug = process.env.OPENCODE_ANTHROPIC_DEBUG === "1";

const PORT = parseInt(process.argv[2] || "48372", 10);

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/__health") {
      return new Response("ok");
    }

    const targetUrl = req.headers.get("x-proxy-url");
    if (!targetUrl) {
      return new Response("Missing x-proxy-url", { status: 400 });
    }

    const headers = new Headers(req.headers);
    headers.delete("x-proxy-url");
    headers.delete("host");
    headers.delete("connection");

    const body = req.method !== "GET" && req.method !== "HEAD" ? await req.arrayBuffer() : undefined;

    // Log full request for comparison debugging
    if (debug && targetUrl.includes("/v1/messages") && !targetUrl.includes("count_tokens")) {
      const logHeaders: Record<string, string> = {};
      headers.forEach((v, k) => {
        logHeaders[k] = k === "authorization" ? "Bearer ***" : v;
      });
      let systemPreview = "";
      if (body) {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(body));
          if (Array.isArray(parsed.system)) {
            systemPreview = JSON.stringify(
              parsed.system.slice(0, 3).map((b: any) => ({
                text: typeof b.text === "string" ? b.text.slice(0, 200) : "(non-text)",
                cache_control: b.cache_control,
              })),
              null,
              2,
            );
          }
        } catch {
          /* ignore */
        }
      }
      console.error(`\n[bun-proxy] === /v1/messages REQUEST ===`);
      console.error(`[bun-proxy] URL: ${targetUrl}`);
      console.error(`[bun-proxy] Headers: ${JSON.stringify(logHeaders, null, 2)}`);
      if (systemPreview) console.error(`[bun-proxy] System blocks (first 3): ${systemPreview}`);
      console.error(`[bun-proxy] ===========================\n`);
    }

    try {
      const resp = await fetch(targetUrl, {
        method: req.method,
        headers,
        body,
      });

      const respHeaders = new Headers(resp.headers);
      respHeaders.delete("transfer-encoding");
      respHeaders.delete("content-encoding");

      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: respHeaders,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(msg, { status: 502 });
    }
  },
});

console.log(`BUN_PROXY_PORT=${server.port}`);
