import "dotenv/config";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";

const boolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === "boolean"
      ? v
      : !["0", "false", "no", "off"].includes(v.toLowerCase()),
  )
  .default(true);
const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4310),
  HOST: z.string().default("127.0.0.1"),
  DATA_DIR: z.string().default("./data"),
  LOG_LEVEL: z.string().default("info"),
  // Enterprise / production hardening (all optional; local-first defaults stay open).
  APP_AUTH_TOKEN: z.string().min(16).max(500).optional(),
  RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(3600000)
    .default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(10).max(100000).default(1200),
  RATE_LIMIT_WRITE_MAX: z.coerce.number().int().min(5).max(100000).default(300),
  CONTEXT_MAX_CHARS: z.coerce
    .number()
    .int()
    .min(20000)
    .max(2000000)
    .default(160000),
  FAILOVER_ENABLED: boolFromEnv,
  APP_VERSION: z.string().max(40).default("1.6.0"),
});
const parsed = schema.parse(process.env);
export const rootDir = resolve(process.cwd());
export const dataDir = resolve(rootDir, parsed.DATA_DIR);
export const workspacesDir = resolve(dataDir, "workspaces");
export const config = {
  port: parsed.PORT,
  host: parsed.HOST,
  logLevel: parsed.LOG_LEVEL,
  dataDir,
  workspacesDir,
  authToken: parsed.APP_AUTH_TOKEN ?? "",
  authRequired: Boolean(parsed.APP_AUTH_TOKEN),
  rateLimitWindowMs: parsed.RATE_LIMIT_WINDOW_MS,
  rateLimitMax: parsed.RATE_LIMIT_MAX,
  rateLimitWriteMax: parsed.RATE_LIMIT_WRITE_MAX,
  contextMaxChars: parsed.CONTEXT_MAX_CHARS,
  failoverEnabled: parsed.FAILOVER_ENABLED,
  version: parsed.APP_VERSION,
};

export function initializeStorage(): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(workspacesDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  chmodSync(workspacesDir, 0o700);
  const secretPath = resolve(dataDir, ".secret");
  if (!existsSync(secretPath))
    writeFileSync(secretPath, randomBytes(32), { mode: 0o600, flag: "wx" });
  chmodSync(secretPath, 0o600);
}
export function readSecret(): Buffer {
  return readFileSync(resolve(dataDir, ".secret"));
}
