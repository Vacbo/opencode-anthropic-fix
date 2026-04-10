// ---------------------------------------------------------------------------
// Bun TLS proxy manager — spawns a single Bun subprocess for BoringSSL TLS.
// Hardened: health checks, auto-restart, single-instance guarantee.
// ---------------------------------------------------------------------------

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

let proxyPort: number | null = null;
let proxyProcess: ReturnType<typeof spawn> | null = null;
let starting: Promise<number | null> | null = null;
let healthCheckFails = 0;

const FIXED_PORT = 48372;
const PID_FILE = join(tmpdir(), "opencode-bun-proxy.pid");
const MAX_HEALTH_FAILS = 2;

// Kill proxy when parent process exits — use multiple hooks for reliability
let exitHandlerRegistered = false;
function registerExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  const cleanup = () => {
    if (proxyProcess && !proxyProcess.killed) {
      try {
        proxyProcess.kill("SIGKILL");
      } catch {
        /* */
      }
    }
    try {
      killStaleProxy();
    } catch {
      /* */
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGHUP", () => {
    cleanup();
    process.exit(0);
  });
  // beforeExit fires when the event loop empties (graceful shutdown)
  process.on("beforeExit", cleanup);
}

function findProxyScript(): string | null {
  const dir = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(dir, "bun-proxy.mjs"),
    join(dir, "..", "dist", "bun-proxy.mjs"),
    join(dir, "bun-proxy.ts"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

let _hasBun: boolean | null = null;
function hasBun(): boolean {
  if (_hasBun !== null) return _hasBun;
  try {
    execFileSync("which", ["bun"], { stdio: "ignore" });
    _hasBun = true;
  } catch {
    _hasBun = false;
  }
  return _hasBun;
}

function killStaleProxy(): void {
  try {
    const raw = readFileSync(PID_FILE, "utf-8").trim();
    const pid = parseInt(raw, 10);
    if (pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already dead */
      }
    }
    unlinkSync(PID_FILE);
  } catch {
    // No PID file or already cleaned
  }
}

async function isProxyHealthy(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/__health`, {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function spawnProxy(debug: boolean): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    const script = findProxyScript();
    if (!script || !hasBun()) {
      resolve(null);
      return;
    }

    // Kill any stale instance first
    killStaleProxy();

    try {
      const child = spawn("bun", ["run", script, String(FIXED_PORT)], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        env: { ...process.env, OPENCODE_ANTHROPIC_DEBUG: debug ? "1" : "0" },
      });
      proxyProcess = child;
      registerExitHandler();

      let done = false;
      const finish = (port: number | null) => {
        if (done) return;
        done = true;
        if (port && child.pid) {
          try {
            writeFileSync(PID_FILE, String(child.pid));
          } catch {
            /* ok */
          }
        }
        resolve(port);
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        const m = chunk.toString().match(/BUN_PROXY_PORT=(\d+)/);
        if (m) {
          proxyPort = parseInt(m[1], 10);
          healthCheckFails = 0;
          finish(proxyPort);
        }
      });

      child.on("error", () => {
        finish(null);
        proxyPort = null;
        proxyProcess = null;
        starting = null;
      });

      child.on("exit", () => {
        proxyPort = null;
        proxyProcess = null;
        starting = null;
        finish(null);
      });

      // Timeout
      setTimeout(() => finish(null), 5000);
    } catch {
      resolve(null);
    }
  });
}

export async function ensureBunProxy(debug: boolean): Promise<number | null> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return null;

  // Fast path: proxy already running and healthy
  if (proxyPort && proxyProcess && !proxyProcess.killed) {
    return proxyPort;
  }

  // Check if a proxy is already running on the fixed port (from previous session)
  if (!proxyPort && (await isProxyHealthy(FIXED_PORT))) {
    proxyPort = FIXED_PORT;
    if (debug) console.error("[opencode-anthropic-auth] Reusing existing Bun proxy on port", FIXED_PORT);
    return proxyPort;
  }

  // Restart if previous instance died
  if (proxyPort && (!proxyProcess || proxyProcess.killed)) {
    proxyPort = null;
    proxyProcess = null;
    starting = null;
  }

  if (starting) return starting;

  starting = spawnProxy(debug);
  const port = await starting;
  starting = null;
  if (port) {
    if (debug) console.error("[opencode-anthropic-auth] Bun proxy started on port", port);
  } else {
    console.error("[opencode-anthropic-auth] Bun proxy unavailable, falling back to Node.js fetch");
  }
  return port;
}

export function stopBunProxy(): void {
  if (proxyProcess) {
    try {
      proxyProcess.kill();
    } catch {
      /* */
    }
    proxyProcess = null;
  }
  proxyPort = null;
  starting = null;
  killStaleProxy();
}

/**
 * Fetch via Bun proxy for BoringSSL TLS fingerprint.
 * Auto-restarts proxy on failure. Falls back to native fetch only if Bun is unavailable.
 */
export async function fetchViaBun(
  input: string | URL | Request,
  init: { headers: Headers; body?: string | null; method?: string; [k: string]: unknown },
  debug: boolean,
): Promise<Response> {
  const port = await ensureBunProxy(debug);
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

  if (!port) {
    console.error("[opencode-anthropic-auth] Bun proxy unavailable, falling back to Node.js fetch");
    return fetch(input, init as RequestInit);
  }

  if (debug) console.error(`[opencode-anthropic-auth] Routing through Bun proxy at :${port} → ${url}`);

  // Dump full request for debugging
  if (debug && init.body && url.includes("/v1/messages") && !url.includes("count_tokens")) {
    try {
      writeFileSync(
        "/tmp/opencode-last-request.json",
        typeof init.body === "string" ? init.body : JSON.stringify(init.body),
      );
      const hdrs: Record<string, string> = {};
      init.headers.forEach((v: string, k: string) => {
        hdrs[k] = k === "authorization" ? "Bearer ***" : v;
      });
      writeFileSync("/tmp/opencode-last-headers.json", JSON.stringify(hdrs, null, 2));
      console.error("[opencode-anthropic-auth] Dumped request to /tmp/opencode-last-request.json");
    } catch {
      /* ignore */
    }
  }

  const headers = new Headers(init.headers);
  headers.set("x-proxy-url", url);

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/`, {
      method: init.method || "POST",
      headers,
      body: init.body,
    });

    // Proxy returned a 502 — Bun proxy couldn't reach Anthropic
    if (resp.status === 502) {
      const errText = await resp.text();
      throw new Error(`Bun proxy upstream error: ${errText}`);
    }

    healthCheckFails = 0;
    return resp;
  } catch (err) {
    healthCheckFails++;

    // If proxy seems dead, restart it and retry once
    if (healthCheckFails >= MAX_HEALTH_FAILS) {
      stopBunProxy();
      const newPort = await ensureBunProxy(debug);
      if (newPort) {
        healthCheckFails = 0;
        const retryHeaders = new Headers(init.headers);
        retryHeaders.set("x-proxy-url", url);
        return fetch(`http://127.0.0.1:${newPort}/`, {
          method: init.method || "POST",
          headers: retryHeaders,
          body: init.body,
        });
      }
    }

    // Final fallback: native fetch (will use Node TLS — not ideal but better than failing)
    throw err;
  }
}
