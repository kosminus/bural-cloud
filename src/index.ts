import { handleApi } from "./api";
import { devLogin, githubCallback, githubLogin, logout } from "./auth";
import { HttpError, json, type Env } from "./shared";

export { Inbox } from "./inbox";

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' https://avatars.githubusercontent.com data:; connect-src 'self'; " +
    "style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

function withSecurityHeaders(res: Response): Response {
  if (res.status === 101) return res; // WebSocket upgrade responses must pass through untouched
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  if (p === "/auth/github/login" && req.method === "GET") return githubLogin(req, env, url);
  if (p === "/auth/github/callback" && req.method === "GET") return githubCallback(req, env, url);
  if (p === "/auth/dev-login" && req.method === "GET") return devLogin(req, env, url);
  if (p === "/auth/logout" && req.method === "POST") return logout(req, env, url);
  if (p.startsWith("/api/")) return handleApi(req, env, url);
  return env.ASSETS.fetch(req);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      return withSecurityHeaders(await route(req, env, url));
    } catch (e) {
      if (e instanceof HttpError) return withSecurityHeaders(json({ error: e.message }, e.status));
      // Never log error messages or request data: they could contain message text.
      console.error("internal error", e instanceof Error ? e.name : "unknown");
      return withSecurityHeaders(json({ error: "internal error" }, 500));
    }
  },
} satisfies ExportedHandler<Env>;
