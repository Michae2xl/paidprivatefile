export function extractServerErrorMessage(
  body: unknown,
  fallback: string,
): string {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return fallback;
  }

  const err = (body as { error?: unknown }).error;
  if (typeof err === "string") {
    return err;
  }

  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }

  return fallback;
}
