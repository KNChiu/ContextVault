import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Config } from "./config";

export interface AuthContext {
  key: string;
  user: string;
  admin: boolean;
  allowedTags: string[];
}

const als = new AsyncLocalStorage<AuthContext>();

export function getAuth(): AuthContext {
  const ctx = als.getStore();
  if (!ctx) throw new AuthError("No auth context");
  return ctx;
}

export function runWithAuth<T>(ctx: AuthContext, fn: () => T): T {
  return als.run(ctx, fn);
}

function keyEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function authenticate(cfg: Config, req: Request): AuthContext {
  const auth = req.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    throw new AuthError("Missing or invalid Authorization header");
  }
  const key = auth.slice(7);
  const entry = cfg.keys.find((k) => keyEquals(k.key, key));
  if (!entry) {
    throw new AuthError("Invalid API key");
  }
  return { key, user: entry.user, admin: entry.admin, allowedTags: entry.allowedTags };
}

export function validateAclTags(
  tags: string[],
  allowedTags: string[],
  vocabulary: string[],
): void {
  for (const tag of tags) {
    if (!vocabulary.includes(tag)) {
      throw new ValidationError(`Unknown tag: "${tag}"`);
    }
    if (!allowedTags.includes(tag)) {
      throw new ValidationError(`Tag not allowed: "${tag}"`);
    }
  }
}

export class AuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AuthError";
  }
}

export class ValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ValidationError";
  }
}