import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { readSecret } from "./config.js";
const key = () => createHash("sha256").update(readSecret()).digest();
export function encrypt(value: string): string {
  if (!value) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    data.toString("base64"),
  ].join(".");
}
export function decrypt(value: string): string {
  if (!value) return "";
  const [iv, tag, data] = value.split(".");
  if (!iv || !tag || !data)
    throw new Error("Stored secret has an invalid encrypted format.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
export function maskSecret(value: string): string {
  if (!value) return "";
  return value.length < 8
    ? "••••••"
    : `${value.slice(0, 3)}…${value.slice(-4)}`;
}
