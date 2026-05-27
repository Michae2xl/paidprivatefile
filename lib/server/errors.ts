import { NextResponse } from "next/server";

export function logServerError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(`[${context}] ${message}${stack ? `\n${stack}` : ""}`);
}

export function internalServerErrorResponse(
  context: string,
  error: unknown,
): NextResponse {
  logServerError(context, error);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}
