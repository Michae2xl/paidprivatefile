import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cookies, headers } from "next/headers";
import { type NextResponse } from "next/server";

export const WEB_SESSION_COOKIE = "paidprivatefile_session";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
export const FLOW_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;

export function validateFlowId(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") {
    return fallback;
  }
  return FLOW_ID_PATTERN.test(raw) ? raw : fallback;
}

export interface WebSessionContext {
  sessionId: string;
  runtimeDir: string;
  cookieWasMissing: boolean;
}

interface SessionLookup {
  cookieValue?: string | null;
}

export function resolveWebRuntimeRoot(): string {
  return (
    process.env.PAID_PRIVATE_FILE_RUNTIME_DIR ??
    process.env.ZKCGZ_WEB_RUNTIME_DIR ??
    join(tmpdir(), "paidprivatefile-runtime")
  );
}

export function buildSessionRuntimeDir(
  sessionId: string,
  runtimeRoot = resolveWebRuntimeRoot(),
): string {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) {
    throw new Error(`Invalid web session id: ${sessionId}`);
  }

  return join(runtimeRoot, "sessions", normalized);
}

export function resolveRouteSession(request: Request): WebSessionContext {
  return buildSessionContext({
    cookieValue: readCookieValue(
      request.headers.get("cookie"),
      WEB_SESSION_COOKIE,
    ),
  });
}

export async function resolveRequestSession(): Promise<WebSessionContext> {
  const [, cookieStore] = await Promise.all([headers(), cookies()]);

  return buildSessionContext({
    cookieValue: cookieStore.get(WEB_SESSION_COOKIE)?.value,
  });
}

export function applySessionCookie(
  response: NextResponse,
  sessionId: string,
): NextResponse {
  response.cookies.set({
    name: WEB_SESSION_COOKIE,
    value: sessionId,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  return response;
}

function buildSessionContext(lookup: SessionLookup): WebSessionContext {
  const existingSessionId = normalizeSessionId(lookup.cookieValue);
  const sessionId = existingSessionId ?? randomUUID();

  return {
    sessionId,
    runtimeDir: buildSessionRuntimeDir(sessionId),
    cookieWasMissing: existingSessionId === null,
  };
}

function normalizeSessionId(value: string | null | undefined): string | null {
  return value && SESSION_ID_PATTERN.test(value) ? value : null;
}

function readCookieValue(
  cookieHeader: string | null,
  cookieName: string,
): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (const entry of cookieHeader.split(/;\s*/u)) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const name = entry.slice(0, separatorIndex);
    if (name !== cookieName) {
      continue;
    }

    return entry.slice(separatorIndex + 1);
  }

  return null;
}
