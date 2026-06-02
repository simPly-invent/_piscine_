/** Shared helpers used across all handlers. */

export function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export function getIP(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0].trim() ||
    "0.0.0.0"
  );
}

export function getUA(request) {
  return request.headers.get("User-Agent") || "";
}

export function getSessionId(request) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  const url = new URL(request.url);
  return url.searchParams.get("session") || null;
}
