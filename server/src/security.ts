import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

/** In-memory sliding-window rate limiter (single-process, local-first). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  check(
    key: string,
    at = Date.now(),
  ): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const cutoff = at - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1, (list[0] ?? at) + this.windowMs - at),
      };
    }
    list.push(at);
    this.hits.set(key, list);
    if (this.hits.size > 10000) {
      for (const [k, v] of this.hits)
        if (!v.some((t) => t > cutoff)) this.hits.delete(k);
    }
    return {
      allowed: true,
      remaining: this.limit - list.length,
      retryAfterMs: 0,
    };
  }
  reset(): void {
    this.hits.clear();
  }
}

export function tokenMatches(
  provided: string | undefined,
  expected: string,
): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function requestToken(request: FastifyRequest): string | undefined {
  const auth = request.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer "))
    return auth.slice(7).trim();
  const apiKey = request.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey) return apiKey;
  const query = request.query as Record<string, unknown> | undefined;
  if (query && typeof query.access_token === "string")
    return query.access_token;
  return undefined;
}

export function isPublicPath(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return path === "/api/health" || path === "/api/ready";
}
