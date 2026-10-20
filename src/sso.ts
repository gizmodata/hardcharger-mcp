// Optional browser sign-in through the server's identity provider (enabled with
// HARDCHARGER_ENABLE_SSO=true), on Hardcharger's browser sign-in server (its OAuth port,
// default 31339), the flow the Hardcharger CLI's --auth-type external runs:
//
//   GET {base}/oauth/initiate            -> { session_uuid, auth_url }
//   open auth_url in the user's browser
//   poll GET {base}/oauth/token/{uuid}   -> { status: pending|complete|error }, 404 not_found
//   sign in with the ID token (the token_exchange grant)
//
// {base} is HARDCHARGER_OAUTH_BASE_URL, or http(s)://<host>:<oauth port> with https when the
// connection URI uses TLS. The token lives in process memory only.

import { spawn } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";

import type { HardchargerConnection } from "./connection.js";

export interface SsoOptions {
  waitSeconds: number;
  pollIntervalMs?: number;
  /** Test hook: replaces the browser opener. */
  openUrl?: (url: string) => Promise<void>;
  /** Test hook: replaces HTTP GET JSON. */
  getJson?: (url: string, tlsSkipVerify: boolean) => Promise<JsonResponse>;
}

export interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface SsoOutcome {
  status: "complete" | "pending" | "unavailable" | "error";
  message: string;
  authUrl?: string;
}

interface PendingSession {
  baseUrl: string;
  sessionUuid: string;
  authUrl: string;
  startedAt: number;
}

const pendingSessions = new WeakMap<HardchargerConnection, PendingSession>();

/** Thrown when the browser sign-in server can't be reached at all. */
class UnreachableError extends Error {}

/** GET a JSON document (small helper so the flow works without extra dependencies). */
export function httpGetJson(url: string, tlsSkipVerify: boolean): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      url.startsWith("https") ? { rejectUnauthorized: !tlsSkipVerify, timeout: 10000 } : { timeout: 10000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) as Record<string, unknown> });
          } catch {
            reject(new Error(`Unexpected non-JSON response (HTTP ${res.statusCode}) from ${url}`));
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new UnreachableError(`Timed out contacting ${url}`));
    });
    req.on("error", (err) =>
      reject(err instanceof UnreachableError ? err : new UnreachableError(`${url}: ${err.message}`)),
    );
  });
}

/**
 * Opens a URL in the user's browser without any extra dependency: the command in
 * HARDCHARGER_BROWSER when set (run with the URL as its one argument, no shell; the
 * Hardcharger CLI's variable of the same meaning), else the platform's default opener.
 */
export function openInBrowser(url: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    let cmd: string;
    let args: string[];
    const browser = env.HARDCHARGER_BROWSER?.trim();
    if (browser) {
      cmd = browser;
      args = [url];
    } else if (process.platform === "darwin") {
      cmd = "open";
      args = [url];
    } else if (process.platform === "win32") {
      cmd = "rundll32";
      args = ["url.dll,FileProtocolHandler", url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", reject);
      child.on("spawn", () => {
        child.unref();
        resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function unavailable(base: string, why: string): SsoOutcome {
  return {
    status: "unavailable",
    message:
      `The Hardcharger server offers no browser sign-in at ${base} (${why}). It runs only when the server ` +
      "is started with --oauth-client-id (and its identity provider settings); set HARDCHARGER_OAUTH_PORT or " +
      "HARDCHARGER_OAUTH_BASE_URL if it listens elsewhere, or configure a password, token or client certificate.",
  };
}

/** Runs (or resumes) the browser sign-in flow for a connection. */
export async function runSsoLogin(connection: HardchargerConnection, options: SsoOptions): Promise<SsoOutcome> {
  const tlsSkipVerify = connection.config.tlsSkipVerify;
  const getJson = options.getJson ?? httpGetJson;
  const openUrl = options.openUrl ?? openInBrowser;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;

  let session = pendingSessions.get(connection);
  if (!session || Date.now() - session.startedAt > 10 * 60 * 1000) {
    const baseUrl = connection.oauthBaseUrl();
    let init: JsonResponse;
    try {
      init = await getJson(`${baseUrl}/oauth/initiate`, tlsSkipVerify);
    } catch (err) {
      if (err instanceof UnreachableError) return unavailable(baseUrl, err.message);
      throw err;
    }
    if (init.status === 404) return unavailable(baseUrl, "HTTP 404 for /oauth/initiate");
    const sessionUuid = typeof init.body.session_uuid === "string" ? init.body.session_uuid : "";
    const authUrl = typeof init.body.auth_url === "string" ? init.body.auth_url : "";
    if (init.status !== 200 || !sessionUuid || !authUrl) {
      return {
        status: "error",
        message: `Unexpected response from /oauth/initiate (HTTP ${init.status}): ${JSON.stringify(init.body)}`,
      };
    }
    session = { baseUrl, sessionUuid, authUrl, startedAt: Date.now() };
    pendingSessions.set(connection, session);
    try {
      await openUrl(authUrl);
    } catch {
      // The URL is returned in the message so the user can open it manually.
    }
  }

  const deadline = Date.now() + options.waitSeconds * 1000;
  const pollUrl = `${session.baseUrl}/oauth/token/${session.sessionUuid}`;
  while (Date.now() < deadline) {
    const { status: httpStatus, body } = await getJson(pollUrl, tlsSkipVerify);
    const status = typeof body.status === "string" ? body.status : "";
    if (httpStatus === 404 || status === "not_found") {
      pendingSessions.delete(connection);
      return { status: "error", message: "The sign-in expired or was already used. Call login_sso again." };
    }
    if (status === "complete") {
      const token = typeof body.token === "string" ? body.token : "";
      pendingSessions.delete(connection);
      if (!token) {
        return { status: "error", message: "The sign-in server answered 'complete' but sent no token." };
      }
      await connection.useCredentials({ token });
      try {
        await connection.query("SELECT 1");
      } catch (err) {
        return {
          status: "error",
          message: `Signed in, but connecting with the identity token failed: ${connection.redact(err instanceof Error ? err.message : String(err))}`,
        };
      }
      return { status: "complete", message: "Signed in with SSO. Subsequent queries use your identity token." };
    }
    if (status === "error") {
      pendingSessions.delete(connection);
      return { status: "error", message: `Browser sign-in failed: ${String(body.error ?? "unknown error")}` };
    }
    if (status !== "pending") {
      pendingSessions.delete(connection);
      return { status: "error", message: `Unexpected sign-in poll answer (HTTP ${httpStatus}): ${JSON.stringify(body)}` };
    }
    await sleep(pollIntervalMs);
  }
  return {
    status: "pending",
    authUrl: session.authUrl,
    message:
      "Waiting for you to finish signing in. A browser window should have opened; if not, open this URL: " +
      `${session.authUrl}\nThen call login_sso again to complete the sign-in.`,
  };
}
