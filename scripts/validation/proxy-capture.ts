/**
 * proxy-capture.ts (validation copy)
 *
 * Adapted from the historical research proxy-capture script to use env-var-configurable
 * paths so validation runs do not clobber the historical cch-captures.md.
 *
 * Defaults write to scripts/validation/cch-validation-2026-04-11.md and
 * generate certs in scripts/validation/proxy-certs/ (separate from the
 * historical .omc/research/proxy-certs/ used by the prior session).
 *
 * Env vars:
 *   CCH_CAPTURES_FILE   absolute path for capture markdown (default: dated file in this dir)
 *   CCH_CERT_DIR        absolute path for ephemeral CA + server certs (default: ./proxy-certs in this dir)
 *   CCH_LISTEN_PORT     proxy listen port (default: 9091)
 *
 * Run:
 *   bun scripts/validation/proxy-capture.ts
 *   # then in another terminal, set HTTPS_PROXY=http://127.0.0.1:9091 and run claude
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http, { type IncomingMessage, type Server } from "node:http";
import net, { type Socket } from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

interface ProxyCerts {
    key: Buffer;
    cert: Buffer;
}

interface CaptureRecord {
    method: string;
    url: string;
    headers: Record<string, string>;
    bodySnippet: string | null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LISTEN_PORT = parseInt(process.env.CCH_LISTEN_PORT ?? "9091", 10);
const CAPTURES_FILE = process.env.CCH_CAPTURES_FILE ?? path.join(__dirname, "cch-validation-2026-04-11.md");
const CERT_DIR = process.env.CCH_CERT_DIR ?? path.join(__dirname, "proxy-certs");
const CERT_ALT_NAMES = "DNS:*.anthropic.com,DNS:api.anthropic.com,DNS:claude.ai";

export function shouldMitmHost(hostname: string): boolean {
    return hostname === "claude.ai" || hostname.endsWith(".anthropic.com");
}

export function shouldUseBunRuntime(
    versions: { bun?: string; node?: string } | NodeJS.ProcessVersions = process.versions,
): boolean {
    return typeof versions.bun === "string";
}

function ensureBunRuntime(): void {
    if (!import.meta.main || shouldUseBunRuntime()) {
        return;
    }

    console.error("[proxy] This capture helper must run under Bun to preserve Claude Code runtime/TLS parity.");
    process.exit(1);
}

function ensureCerts(): ProxyCerts {
    if (!fs.existsSync(CERT_DIR)) {
        fs.mkdirSync(CERT_DIR, { recursive: true });
    }

    const caKey = path.join(CERT_DIR, "ca.key");
    const caCert = path.join(CERT_DIR, "ca.crt");
    const srvKey = path.join(CERT_DIR, "srv.key");
    const srvCert = path.join(CERT_DIR, "srv.crt");
    const srvCsr = path.join(CERT_DIR, "srv.csr");
    const extCnf = path.join(CERT_DIR, "ext.cnf");

    const hasCa = fs.existsSync(caKey) && fs.existsSync(caCert);
    const desiredExtConfig = `[ext]\nsubjectAltName=${CERT_ALT_NAMES}\n`;
    const shouldRegenerateServer =
        !fs.existsSync(srvKey) ||
        !fs.existsSync(srvCert) ||
        !fs.existsSync(extCnf) ||
        fs.readFileSync(extCnf, "utf8") !== desiredExtConfig;

    if (!hasCa) {
        console.log(`[proxy] Generating ephemeral CA in ${CERT_DIR}`);
        execFileSync("openssl", ["genrsa", "-out", caKey, "2048"]);
        execFileSync("openssl", [
            "req",
            "-new",
            "-x509",
            "-days",
            "365",
            "-key",
            caKey,
            "-out",
            caCert,
            "-subj",
            "/CN=ProxyCapture-Validation CA",
        ]);
    }

    if (shouldRegenerateServer) {
        console.log(`[proxy] Generating server certificate in ${CERT_DIR}`);
        execFileSync("openssl", ["genrsa", "-out", srvKey, "2048"]);
        execFileSync("openssl", ["req", "-new", "-key", srvKey, "-out", srvCsr, "-subj", "/CN=api.anthropic.com"]);
        fs.writeFileSync(extCnf, desiredExtConfig);
        execFileSync("openssl", [
            "x509",
            "-req",
            "-days",
            "365",
            "-in",
            srvCsr,
            "-CA",
            caCert,
            "-CAkey",
            caKey,
            "-CAcreateserial",
            "-out",
            srvCert,
            "-extfile",
            extCnf,
            "-extensions",
            "ext",
        ]);
    }

    return {
        key: fs.readFileSync(srvKey),
        cert: fs.readFileSync(srvCert),
    };
}

let captureCount = 0;

function writeCapture({ method, url, headers, bodySnippet }: CaptureRecord): void {
    captureCount += 1;
    const timestamp = new Date().toISOString();
    const cch = headers["x-anthropic-cch"] || "(not in headers)";

    let billingHeader = "(not found in body)";
    let cchFromBody: string | null = null;
    if (bodySnippet) {
        const billingMatch = bodySnippet.match(/x-anthropic-billing-header:[^"\\]*/);
        if (billingMatch) {
            billingHeader = billingMatch[0];
        }
        const cchMatch = bodySnippet.match(/cch=([0-9a-f]{5})/);
        if (cchMatch) {
            cchFromBody = cchMatch[1] ?? null;
        }
    }

    const isApiCall = url.includes("/v1/") || url.includes("/api/");
    if (!isApiCall) {
        return;
    }

    let entry = `\n## Capture #${captureCount} — ${timestamp}\n\n`;
    entry += `**Method/URL:** \`${method} ${url}\`\n\n`;
    entry += `**x-anthropic-cch (header):** \`${cch}\`\n\n`;
    if (cchFromBody) {
        entry += `**cch (from body):** \`${cchFromBody}\` *** FOUND ***\n\n`;
    }
    entry += `**billing-header (from body):** \`${billingHeader}\`\n\n`;
    entry += `**All anthropic request headers:**\n\`\`\`\n`;
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase().startsWith("x-anthropic") || key.toLowerCase().startsWith("anthropic")) {
            entry += `${key}: ${value}\n`;
        }
    }
    entry += `\`\`\`\n`;
    if (bodySnippet && cchFromBody) {
        entry += `\n**Full request body:**\n\`\`\`json\n${bodySnippet}\n\`\`\`\n`;
    }
    entry += `\n---\n`;

    fs.appendFileSync(CAPTURES_FILE, entry);
    const marker = cchFromBody ? ` *** CCH=${cchFromBody} ***` : "";
    console.log(`[proxy] #${captureCount}${marker}  ${method} ${url}`);
}

function startRawTunnel(clientSocket: Socket, hostname: string, port: number, head: Buffer): void {
    const upstream = net.connect(port, hostname, () => {
        clientSocket.write("HTTP/1.1 200 Connection established\r\n\r\n");
        if (head.length > 0) {
            upstream.write(head);
        }
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
    });

    upstream.on("error", (error: Error) => {
        console.error(`[proxy] tunnel upstream ${hostname}:${port}:`, error.message);
        clientSocket.destroy();
    });
    clientSocket.on("error", () => {
        upstream.destroy();
    });
}

function startMitmTunnel(clientSocket: Socket, hostname: string, port: number, certs: ProxyCerts): void {
    clientSocket.write("HTTP/1.1 200 Connection established\r\n\r\n");

    const tlsSocket = new tls.TLSSocket(clientSocket, {
        isServer: true,
        key: certs.key,
        cert: certs.cert,
        rejectUnauthorized: false,
    });

    let rawBuffer = Buffer.alloc(0);
    let state: "headers" | "body" | "done" = "headers";
    let method = "";
    let requestPath = "";
    const headers: Record<string, string> = {};
    let contentLength = 0;
    let headerEndIndex = 0;
    const queuedChunks: Buffer[] = [];
    let upstreamReady = false;

    const upstream = tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false }, () => {
        upstreamReady = true;
        for (const chunk of queuedChunks.splice(0)) {
            upstream.write(chunk);
        }
    });

    tlsSocket.on("error", (error: Error) => console.error("[proxy] client tls:", error.message));
    upstream.on("error", (error: Error) => console.error("[proxy] upstream:", error.message));
    upstream.on("data", (chunk: Buffer) => {
        tlsSocket.write(chunk);
    });
    upstream.on("end", () => {
        tlsSocket.destroy();
    });
    tlsSocket.on("end", () => {
        upstream.destroy();
    });

    function processFirstRequest(): boolean {
        const bodyBuffer = rawBuffer.slice(headerEndIndex);
        if (contentLength > 0 && bodyBuffer.length < contentLength) {
            return false;
        }

        const bodySnippet = bodyBuffer.length > 0 ? bodyBuffer.toString("utf8", 0, 100000) : null;
        writeCapture({
            method,
            url: `https://${hostname}:${port}${requestPath}`,
            headers,
            bodySnippet,
        });
        return true;
    }

    tlsSocket.on("data", (chunk: Buffer | string) => {
        const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

        if (state !== "done") {
            rawBuffer = Buffer.concat([rawBuffer, bufferChunk]);

            if (state === "headers") {
                const payload = rawBuffer.toString("binary");
                const separatorIndex = payload.indexOf("\r\n\r\n");
                if (separatorIndex !== -1) {
                    const headerSection = payload.slice(0, separatorIndex);
                    const lines = headerSection.split("\r\n");
                    const requestLine = lines[0] ?? "";
                    [method, requestPath] = requestLine.split(" ");

                    for (const line of lines.slice(1)) {
                        const colonIndex = line.indexOf(":");
                        if (colonIndex > 0) {
                            headers[line.slice(0, colonIndex).trim().toLowerCase()] = line.slice(colonIndex + 1).trim();
                        }
                    }

                    contentLength = parseInt(headers["content-length"] || "0", 10);
                    headerEndIndex = Buffer.byteLength(headerSection, "binary") + 4;
                    state = "body";
                }
            }

            if (state === "body" && processFirstRequest()) {
                state = "done";
            }
        }

        if (upstreamReady) {
            upstream.write(bufferChunk);
            return;
        }

        queuedChunks.push(bufferChunk);
    });
}

function getConnectTarget(req: IncomingMessage): { hostname: string; port: number } {
    const hostValue = Array.isArray(req.headers.host) ? req.headers.host[0] : (req.headers.host ?? req.url ?? "");
    const [hostname, portString] = hostValue.split(":");
    return {
        hostname,
        port: parseInt(portString || "443", 10),
    };
}

function createServer(): Server {
    const certs = ensureCerts();
    const server = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end("proxy ok");
    });

    server.on("connect", (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
        const { hostname, port } = getConnectTarget(req);
        console.log(`[proxy] CONNECT ${hostname}:${port}`);

        if (shouldMitmHost(hostname)) {
            startMitmTunnel(clientSocket, hostname, port, certs);
            return;
        }

        console.log(`[proxy] TUNNEL ${hostname}:${port}`);
        startRawTunnel(clientSocket, hostname, port, head);
    });

    return server;
}

function main(): void {
    fs.writeFileSync(
        CAPTURES_FILE,
        `# CCH Validation Captures — ${new Date().toISOString()}\n\nGenerated by scripts/validation/proxy-capture.ts\n\nThis file is for the cch validation run. The historical cch-captures.md from CC 2.1.98 lives at .omc/research/cch-captures.md and is not touched.\n`,
    );

    const server = createServer();
    server.listen(LISTEN_PORT, "127.0.0.1", () => {
        console.log(`[proxy] Ready on 127.0.0.1:${LISTEN_PORT}  captures -> ${CAPTURES_FILE}`);
        console.log(`[proxy] Cert dir: ${CERT_DIR}`);
        console.log(
            `[proxy] To capture CC: HTTPS_PROXY=http://127.0.0.1:${LISTEN_PORT} BUN_TLS_REJECT_UNAUTHORIZED=0 NODE_TLS_REJECT_UNAUTHORIZED=0 claude --print "<prompt>"`,
        );
    });
}

if (import.meta.main) {
    ensureBunRuntime();
    main();
}
