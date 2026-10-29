// Optional browser sign-in through the server's identity provider (enabled with
// HARDCHARGER_ENABLE_SSO=true): Chargewire browser sign-in (§4.3, capability oauth_browser), on
// the server's own Chargewire port, through @gizmodata/hardcharger:
//
//   startBrowserSignIn  POST {uri}/v1/auth/oauth/flows        -> flow id, poll secret, authorize URL
//   open the authorize URL in the user's browser
//   pollBrowserSignIn   POST {uri}/v1/auth/oauth/flows/{id}   -> pending | complete (the server's
//                                                                own access token) | failed (a code)
//
// The access token lives in process memory only, and is used as is: when it expires, call
// login_sso again.

import { spawn } from "node:child_process";

import {
  type BrowserSignInFlow,
  type BrowserSignInPoll,
  type BrowserSignInTarget,
  HardchargerError,
  HardchargerErrorCode,
  pollBrowserSignIn,
  startBrowserSignIn,
} from "@gizmodata/hardcharger";

import type { HardchargerConnection } from "./connection.js";

/** The two Chargewire calls a sign-in makes; replaceable in tests. */
export interface BrowserSignInCalls {
  start(target: BrowserSignInTarget): Promise<BrowserSignInFlow>;
  poll(target: BrowserSignInTarget, flow: BrowserSignInFlow): Promise<BrowserSignInPoll>;
}

export interface SsoOptions {
  waitSeconds: number;
  /** Overrides the server's poll interval (tests). */
  pollIntervalMs?: number;
  /** Test hook: replaces the browser opener. */
  openUrl?: (url: string) => Promise<void>;
  /** Test hook: replaces the Chargewire browser sign-in calls. */
  calls?: BrowserSignInCalls;
}

export interface SsoOutcome {
  status: "complete" | "pending" | "unavailable" | "error";
  message: string;
  authUrl?: string;
}

interface PendingSession {
  flow: BrowserSignInFlow;
  startedAt: number;
}

const pendingSessions = new WeakMap<HardchargerConnection, PendingSession>();

const chargewireCalls: BrowserSignInCalls = {
  start: (target) => startBrowserSignIn(target),
  poll: (target, flow) => pollBrowserSignIn({ ...target, flow }),
};

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

function unavailable(uri: string, why: string): SsoOutcome {
  return {
    status: "unavailable",
    message:
      `The Hardcharger server at ${uri} offers no browser sign-in (${why}). It is offered only when the ` +
      "server is started with --oauth-client-id (and its identity provider settings); otherwise configure " +
      "a password, token or client certificate.",
  };
}

const code = (err: unknown): string | undefined => (err instanceof HardchargerError ? err.code : undefined);

/** A flow the server no longer knows, or one past its expiry: start a new one. */
function stale(session: PendingSession): boolean {
  const expires = Date.parse(session.flow.expiresAt);
  const now = Date.now();
  return now - session.startedAt > 10 * 60 * 1000 || (!Number.isNaN(expires) && now >= expires);
}

/** Runs (or resumes) the browser sign-in flow for a connection. */
export async function runSsoLogin(connection: HardchargerConnection, options: SsoOptions): Promise<SsoOutcome> {
  const calls = options.calls ?? chargewireCalls;
  const openUrl = options.openUrl ?? openInBrowser;
  const target = connection.signInTarget();
  const redact = (err: unknown) => connection.redact(err instanceof Error ? err.message : String(err));

  let session = pendingSessions.get(connection);
  if (!session || stale(session)) {
    let flow: BrowserSignInFlow;
    try {
      flow = await calls.start(target);
    } catch (err) {
      const c = code(err);
      if (c === HardchargerErrorCode.notImplemented || c === HardchargerErrorCode.notFound) {
        return unavailable(connection.config.uri, `${c}: ${redact(err)}`);
      }
      if (c === HardchargerErrorCode.clientTransportError) return unavailable(connection.config.uri, redact(err));
      throw err;
    }
    session = { flow, startedAt: Date.now() };
    pendingSessions.set(connection, session);
    try {
      await openUrl(flow.authorizeUrl);
    } catch {
      // The URL is returned in the message so the user can open it manually.
    }
  }

  const pollIntervalMs = options.pollIntervalMs ?? session.flow.pollIntervalS * 1000;
  const deadline = Date.now() + options.waitSeconds * 1000;
  while (Date.now() < deadline) {
    let poll: BrowserSignInPoll;
    try {
      poll = await calls.poll(target, session.flow);
    } catch (err) {
      pendingSessions.delete(connection);
      const c = code(err);
      if (c === HardchargerErrorCode.flowNotFound) {
        return { status: "error", message: "The sign-in expired or was already used. Call login_sso again." };
      }
      // A failed flow throws its code (access_denied, identity_provider_error,
      // invalid_credentials, ...) with no HTTP status: report it with the code.
      const why = redact(err).replace(/^browser sign-in failed: /iu, "");
      return { status: "error", message: `Browser sign-in failed: ${c !== undefined && !why.includes(c) ? `${why} (${c})` : why}` };
    }
    if (poll.state === "complete") {
      pendingSessions.delete(connection);
      await connection.useCredentials({ accessToken: poll.accessToken });
      try {
        await connection.query("SELECT 1");
      } catch (err) {
        return { status: "error", message: `Signed in, but connecting with the access token failed: ${redact(err)}` };
      }
      return {
        status: "complete",
        message: "Signed in with SSO. Subsequent queries use your Hardcharger access token (call login_sso again when it expires).",
      };
    }
    await sleep(Math.max(0, Math.min(pollIntervalMs, deadline - Date.now())));
  }
  return {
    status: "pending",
    authUrl: session.flow.authorizeUrl,
    message:
      "Waiting for you to finish signing in. A browser window should have opened; if not, open this URL: " +
      `${session.flow.authorizeUrl}\nThen call login_sso again to complete the sign-in.`,
  };
}
