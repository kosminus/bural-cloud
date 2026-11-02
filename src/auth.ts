import { HttpError, LIMITS, json, randomToken, sha256Hex, type Account, type Env } from "./shared";

const SESSION_COOKIE = "bural_session";
const STATE_COOKIE = "bural_oauth_state";

export interface Auth {
  account: Account;
  via: "session" | "token";
}

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function cookie(url: URL, name: string, value: string, maxAgeSec: number): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

/** Resolves the caller from `Authorization: Bearer <agent token>` or the session cookie. */
export async function authenticate(req: Request, env: Env): Promise<Auth | null> {
  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    const hash = await sha256Hex(header.slice(7).trim());
    const account = await env.DB.prepare(
      `SELECT a.* FROM tokens t JOIN accounts a ON a.id = t.account_id WHERE t.hash = ?`,
    )
      .bind(hash)
      .first<Account>();
    return account ? { account, via: "token" } : null;
  }
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const hash = await sha256Hex(sid);
  const account = await env.DB.prepare(
    `SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.hash = ? AND s.expires_at > ?`,
  )
    .bind(hash, Date.now())
    .first<Account>();
  return account ? { account, via: "session" } : null;
}

/** Cookie-authenticated requests must come from our own origin (CSRF / cross-site WebSocket). */
export function checkOrigin(req: Request, url: URL, auth: Auth): void {
  if (auth.via !== "session") return;
  const origin = req.headers.get("origin");
  if (origin !== url.origin) throw new HttpError(403, "bad origin");
}

async function createSession(env: Env, url: URL, accountId: string): Promise<string> {
  const sid = randomToken();
  await env.DB.prepare(`INSERT INTO sessions (hash, account_id, expires_at) VALUES (?, ?, ?)`)
    .bind(await sha256Hex(sid), accountId, Date.now() + LIMITS.sessionTtlMs)
    .run();
  // Opportunistic cleanup of expired sessions.
  await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(Date.now()).run();
  return cookie(url, SESSION_COOKIE, sid, LIMITS.sessionTtlMs / 1000);
}

/** Finds or creates a person account. Handles that are taken get a numeric suffix. */
async function upsertPerson(
  env: Env,
  p: { githubId: number | null; login: string; name: string; avatarUrl: string | null },
): Promise<string> {
  if (p.githubId !== null) {
    const existing = await env.DB.prepare(`SELECT id FROM accounts WHERE github_id = ?`)
      .bind(p.githubId)
      .first<{ id: string }>();
    if (existing) {
      await env.DB.prepare(`UPDATE accounts SET display_name = ?, avatar_url = ? WHERE id = ?`)
        .bind(p.name, p.avatarUrl, existing.id)
        .run();
      return existing.id;
    }
  } else {
    // Dev login: reuse by handle.
    const existing = await env.DB.prepare(`SELECT id FROM accounts WHERE handle = ? AND kind = 'person'`)
      .bind(p.login)
      .first<{ id: string }>();
    if (existing) return existing.id;
  }
  const id = crypto.randomUUID();
  let handle = p.login;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await env.DB.prepare(
        `INSERT INTO accounts (id, kind, handle, display_name, github_id, avatar_url, created_at)
         VALUES (?, 'person', ?, ?, ?, ?, ?)`,
      )
        .bind(id, handle, p.name, p.githubId, p.avatarUrl, Date.now())
        .run();
      return id;
    } catch (e) {
      if (!String(e).includes("UNIQUE")) throw e;
      handle = `${p.login}-${Math.floor(Math.random() * 9000 + 1000)}`;
    }
  }
  throw new HttpError(409, "could not allocate a handle");
}

export async function githubLogin(_req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID) throw new HttpError(500, "GitHub login is not configured");
  const state = randomToken(16);
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", `${url.origin}/auth/github/callback`);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("allow_signup", "true");
  return new Response(null, {
    status: 302,
    headers: { location: authorize.toString(), "set-cookie": cookie(url, STATE_COOKIE, state, 600) },
  });
}

export async function githubCallback(req: Request, env: Env, url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = parseCookies(req)[STATE_COOKIE];
  if (!code || !state || !expected || state !== expected) throw new HttpError(400, "invalid login state");

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/auth/github/callback`,
    }),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) throw new HttpError(401, "GitHub login failed");

  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${tokenJson.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "bural-cloud",
    },
  });
  if (!userRes.ok) throw new HttpError(401, "GitHub login failed");
  const user = (await userRes.json()) as { id: number; login: string; name?: string; avatar_url?: string };

  const accountId = await upsertPerson(env, {
    githubId: user.id,
    login: user.login.toLowerCase(),
    name: user.name ?? user.login,
    avatarUrl: user.avatar_url ?? null,
  });
  const headers = new Headers({ location: "/" });
  headers.append("set-cookie", await createSession(env, url, accountId));
  headers.append("set-cookie", cookie(url, STATE_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

/** Local testing only: /auth/dev-login?handle=alice. Disabled unless DEV_LOGIN=1. */
export async function devLogin(_req: Request, env: Env, url: URL): Promise<Response> {
  if (env.DEV_LOGIN !== "1") throw new HttpError(404, "not found");
  const handle = (url.searchParams.get("handle") ?? "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(handle)) throw new HttpError(400, "invalid handle");
  const accountId = await upsertPerson(env, { githubId: null, login: handle, name: handle, avatarUrl: null });
  const setCookie = await createSession(env, url, accountId);
  return json({ ok: true }, 200, { "set-cookie": setCookie });
}

export async function logout(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.headers.get("origin") !== url.origin) throw new HttpError(403, "bad origin");
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (sid) await env.DB.prepare(`DELETE FROM sessions WHERE hash = ?`).bind(await sha256Hex(sid)).run();
  return json({ ok: true }, 200, { "set-cookie": cookie(url, SESSION_COOKIE, "", 0) });
}
