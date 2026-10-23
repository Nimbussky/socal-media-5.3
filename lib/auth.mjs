import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA } from "./db.mjs";

const SECRET_PATH = path.join(DATA, "secret.key");

function secret() {
  try {
    const s = fs.readFileSync(SECRET_PATH, "utf8").trim();
    if (s.length >= 32) return Buffer.from(s, "base64url");
  } catch {}
  const s = crypto.randomBytes(48).toString("base64url");
  fs.writeFileSync(SECRET_PATH, s + "\n", { mode: 0o600 });
  return Buffer.from(s, "base64url");
}

const KEY = secret();
const COOKIE = "gsp_session";
const WEEK = 7 * 24 * 3600;

function b64u(buf) {
  return Buffer.from(buf).toString("base64url");
}

function sign(payloadB64) {
  return crypto.createHmac("sha256", KEY).update(payloadB64).digest("base64url");
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return { hash: hash.toString("base64url"), salt: salt.toString("base64url") };
}

export function verifyPassword(pw, saltStr, hashStr) {
  const expect = Buffer.from(hashStr, "base64url");
  const got = crypto.scryptSync(pw, Buffer.from(saltStr, "base64url"), expect.length);
  return expect.length === got.length && crypto.timingSafeEqual(expect, got);
}

export function createSession(userId) {
  const payload = b64u(JSON.stringify({ u: userId, exp: Math.floor(Date.now() / 1000) + WEEK }));
  return `${payload}.${sign(payload)}`;
}

export function verifySession(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expect = Buffer.from(sign(parts[0]), "base64url");
  const got = Buffer.from(parts[1], "base64url");
  if (expect.length !== got.length || !crypto.timingSafeEqual(expect, got)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (typeof data.u !== "string" || typeof data.exp !== "number" || data.exp < Math.floor(Date.now() / 1000)) return null;
    return { userId: data.u };
  } catch {
    return null;
  }
}

export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionUser(req, db) {
  const token = parseCookies(req)[COOKIE];
  const s = verifySession(token);
  if (!s) return null;
  return db.users.find((u) => u.id === s.userId) || null;
}

export function sessionCookie(token, clear) {
  if (clear) return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${WEEK}`;
}

export { COOKIE };
