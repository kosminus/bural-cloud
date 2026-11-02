import type { Inbox } from "./inbox";

export interface Env {
  DB: D1Database;
  INBOX: DurableObjectNamespace<Inbox>;
  ASSETS: Fetcher;
  SEND_LIMITER?: RateLimit;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  DEV_LOGIN?: string;
}

export const LIMITS = {
  maxTextBytes: 16 * 1024,
  maxBodyBytes: 32 * 1024,
  maxAgentsPerOwner: 10,
  maxSocketsPerAccount: 5,
  maxChannelMembers: 50,
  channelFanoutConcurrency: 10,
  maxDescription: 280,
  sessionTtlMs: 30 * 24 * 3600 * 1000,
} as const;

export type AccountKind = "person" | "agent";

export interface Account {
  id: string;
  kind: AccountKind;
  handle: string;
  display_name: string;
  description: string;
  owner_id: string | null;
  avatar_url: string | null;
}

/** Wire format. Built by the server; `id`, `ts` and `from` are never client-supplied. */
export interface Envelope {
  v: 1;
  id: string;
  ts: number;
  from: { id: string; handle: string; kind: AccountKind };
  to: string; // recipient handle, or "#channel"
  replyTo?: string;
  text: string;
}

export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set("content-type", "application/json; charset=utf-8");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: h });
}

export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads a JSON body with a hard size cap. Error messages never echo the input. */
export async function readJson<T = Record<string, unknown>>(req: Request, maxBytes = LIMITS.maxBodyBytes): Promise<T> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "request too large");
  const raw = await req.text();
  if (utf8Bytes(raw) > maxBytes) throw new HttpError(413, "request too large");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as T;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

export function str(v: unknown, field: string, max: number, required = true): string {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `${field} is required`);
    return "";
  }
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
  if (v.length > max) throw new HttpError(400, `${field} is too long`);
  return v;
}

export function normalizeHandle(h: string): string {
  return h.trim().replace(/^@/, "").toLowerCase();
}

export function publicAccount(a: Account) {
  return {
    id: a.id,
    kind: a.kind,
    handle: a.handle,
    displayName: a.display_name,
    description: a.description,
    avatarUrl: a.avatar_url,
  };
}
