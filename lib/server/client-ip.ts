export function getClientIp(request: Request): string {
  if (
    process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS !== "1" &&
    process.env.ZECTIME_TRUST_PROXY_HEADERS !== "1" &&
    process.env.ZKCGZ_TRUST_PROXY_HEADERS !== "1"
  ) {
    return "local";
  }

  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "local"
  );
}
