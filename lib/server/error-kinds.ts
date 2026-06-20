import { NextResponse } from "next/server";

import { logServerError } from "./errors";

export type ServerErrorKind =
  | "missing_proof"
  | "missing_anchor"
  | "missing_bundle"
  | "missing_flow"
  | "missing_holder"
  | "proof_mismatch"
  | "anchor_mismatch"
  | "nullifier_replay"
  | "cli_unavailable"
  | "network_unsupported"
  | "auth_required"
  | "payment_required"
  | "flow_conflict"
  | "validation"
  | "rate_limit"
  | "unknown";

export interface ServerErrorPayload {
  kind: ServerErrorKind;
  message: string;
  details?: Record<string, unknown>;
}

export interface ServerErrorEnvelope {
  error: ServerErrorPayload;
}

const STATUS_BY_KIND: Record<ServerErrorKind, number> = {
  missing_proof: 409,
  missing_anchor: 409,
  missing_bundle: 409,
  missing_flow: 409,
  missing_holder: 409,
  proof_mismatch: 422,
  anchor_mismatch: 422,
  nullifier_replay: 409,
  cli_unavailable: 503,
  network_unsupported: 422,
  auth_required: 401,
  payment_required: 402,
  flow_conflict: 409,
  validation: 400,
  rate_limit: 429,
  unknown: 500,
};

export class ServerError extends Error {
  readonly kind: ServerErrorKind;
  readonly details?: Record<string, unknown>;

  constructor(
    kind: ServerErrorKind,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ServerError";
    this.kind = kind;
    this.details = details;
  }
}

interface ErrorPattern {
  kind: ServerErrorKind;
  pattern: RegExp;
}

const CLASSIFICATION_PATTERNS: ErrorPattern[] = [
  { kind: "missing_proof", pattern: /does not have a proof/iu },
  { kind: "missing_proof", pattern: /Missing proof artifact/iu },
  { kind: "missing_proof", pattern: /proof has not been created/iu },
  { kind: "missing_bundle", pattern: /does not have a prepared bundle/iu },
  { kind: "missing_bundle", pattern: /Missing verifier bundle/iu },
  { kind: "missing_anchor", pattern: /does not have an anchor/iu },
  { kind: "missing_anchor", pattern: /Missing anchor record/iu },
  { kind: "missing_flow", pattern: /runtime is not prepared/iu },
  { kind: "missing_holder", pattern: /Missing holder profile/iu },
  { kind: "missing_holder", pattern: /No issuer secret configured/iu },
  { kind: "flow_conflict", pattern: /can only be created once/iu },
  {
    kind: "proof_mismatch",
    pattern: /Verified public inputs do not match/iu,
  },
  { kind: "anchor_mismatch", pattern: /memo fields did not match/iu },
  {
    kind: "network_unsupported",
    pattern: /is not accepted by verifier bundle/iu,
  },
  { kind: "network_unsupported", pattern: /Unsupported Zcash network/iu },
  {
    kind: "cli_unavailable",
    pattern: /Missing required environment variable/iu,
  },
  { kind: "cli_unavailable", pattern: /ZKCGZ_CLI_BIN must be/iu },
  {
    kind: "cli_unavailable",
    pattern: /timestamp anchor broadcast failed/iu,
  },
  {
    kind: "cli_unavailable",
    pattern: /timestamp fetch failed/iu,
  },
  {
    kind: "cli_unavailable",
    pattern: /rpc transport error/iu,
  },
  {
    kind: "cli_unavailable",
    pattern: /Missing anchor fetch configuration/iu,
  },
  {
    kind: "cli_unavailable",
    pattern: /Missing anchor configuration/iu,
  },
  {
    kind: "validation",
    pattern: /^(Issuer name|Jurisdiction|Issuer note)/iu,
  },
  { kind: "validation", pattern: /^Invalid web session id/iu },
];

export function classifyError(
  error: unknown,
  _context: string,
): ServerErrorPayload {
  if (error instanceof ServerError) {
    const payload: ServerErrorPayload = {
      kind: error.kind,
      message: error.message,
    };
    if (error.details !== undefined) {
      payload.details = error.details;
    }
    return payload;
  }

  if (!(error instanceof Error)) {
    return { kind: "unknown", message: "Internal server error" };
  }

  const matched = CLASSIFICATION_PATTERNS.find(({ pattern }) =>
    pattern.test(error.message),
  );

  if (matched) {
    if (
      matched.kind === "cli_unavailable" &&
      /(timestamp anchor broadcast failed|timestamp fetch failed|rpc transport error)/iu.test(
        error.message,
      )
    ) {
      return {
        kind: matched.kind,
        message:
          "Zcash anchor RPC is unreachable. Check that zallet is running and that ZALLET_RPC_URL is reachable from the web service.",
      };
    }
    return { kind: matched.kind, message: error.message };
  }

  return { kind: "unknown", message: "Internal server error" };
}

export function statusForKind(kind: ServerErrorKind): number {
  return STATUS_BY_KIND[kind];
}

export function createServerErrorResponse(
  context: string,
  error: unknown,
): NextResponse {
  const payload = classifyError(error, context);
  const shouldLogStack = payload.kind === "unknown";
  if (shouldLogStack) {
    logServerError(context, error);
  } else {
    logServerError(`${context}:${payload.kind}`, error);
  }

  return NextResponse.json<ServerErrorEnvelope>(
    { error: payload },
    { status: statusForKind(payload.kind) },
  );
}
