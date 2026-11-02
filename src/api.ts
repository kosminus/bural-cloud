import { authenticate, checkOrigin, type Auth } from "./auth";
import {
  AGENT_NAME_RE,
  CHANNEL_RE,
  HttpError,
  ID_RE,
  LIMITS,
  json,
  normalizeHandle,
  publicAccount,
  randomToken,
  readJson,
  sha256Hex,
  str,
  utf8Bytes,
  type Account,
  type Env,
  type Envelope,
} from "./shared";

type Handler = (ctx: Ctx, params: string[]) => Promise<Response>;
interface Ctx {
  req: Request;
  env: Env;
  url: URL;
  auth: Auth;
  me: Account;
}

const routes: Array<[string, RegExp, Handler]> = [
  ["GET", /^\/api\/me$/, me],
  ["GET", /^\/api\/people$/, findPeople],
  ["GET", /^\/api\/agents$/, listAgents],
  ["POST", /^\/api\/agents$/, createAgent],
  ["POST", /^\/api\/agents\/([^/]+)\/rotate$/, rotateAgent],
  ["DELETE", /^\/api\/agents\/([^/]+)$/, deleteAgent],
  ["GET", /^\/api\/channels$/, listChannels],
  ["POST", /^\/api\/channels$/, createChannel],
  ["POST", /^\/api\/channels\/([^/]+)\/join$/, joinChannel],
  ["POST", /^\/api\/channels\/([^/]+)\/leave$/, leaveChannel],
  ["GET", /^\/api\/blocks$/, listBlocks],
  ["POST", /^\/api\/blocks$/, addBlock],
  ["DELETE", /^\/api\/blocks\/([^/]+)$/, removeBlock],
  ["POST", /^\/api\/messages$/, sendMessage],
  ["GET", /^\/api\/ws$/, openSocket],
];

export async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/api/config") return json({ devLogin: env.DEV_LOGIN === "1" });

  for (const [method, pattern, handler] of routes) {
    const m = url.pathname.match(pattern);
    if (!m) continue;
    if (req.method !== method) continue;
    const auth = await authenticate(req, env);
    if (!auth) throw new HttpError(401, "not signed in");
    // Cookie-authenticated state changes and WebSocket upgrades must be same-origin.
    if (method !== "GET" || handler === openSocket) checkOrigin(req, url, auth);
    const params = m.slice(1).map((p) => decodeURIComponent(p));
    return handler({ req, env, url, auth, me: auth.account }, params);
  }
  throw new HttpError(404, "not found");
}

function inbox(env: Env, accountId: string) {
  return env.INBOX.get(env.INBOX.idFromName(accountId));
}

function requirePerson(ctx: Ctx): void {
  if (ctx.me.kind !== "person") throw new HttpError(403, "only people can do this");
}

async function findAccount(env: Env, handle: string): Promise<Account | null> {
  return env.DB.prepare(`SELECT * FROM accounts WHERE handle = ?`).bind(normalizeHandle(handle)).first<Account>();
}

// ---------- accounts ----------

async function me(ctx: Ctx): Promise<Response> {
  const owner = ctx.me.owner_id
    ? await ctx.env.DB.prepare(`SELECT handle FROM accounts WHERE id = ?`).bind(ctx.me.owner_id).first<{ handle: string }>()
    : null;
  return json({ account: publicAccount(ctx.me), owner: owner?.handle ?? null });
}

async function findPeople(ctx: Ctx): Promise<Response> {
  const q = normalizeHandle(ctx.url.searchParams.get("q") ?? "").replace(/[%_\\]/g, "");
  if (q.length > 40) throw new HttpError(400, "query too long");
  const rows = await ctx.env.DB.prepare(
    `SELECT * FROM accounts WHERE handle LIKE ? OR display_name LIKE ? ORDER BY handle LIMIT 20`,
  )
    .bind(`${q}%`, `%${q}%`)
    .all<Account>();
  return json({ people: rows.results.map(publicAccount) });
}

// ---------- agents ----------

async function listAgents(ctx: Ctx): Promise<Response> {
  requirePerson(ctx);
  const rows = await ctx.env.DB.prepare(`SELECT * FROM accounts WHERE owner_id = ? ORDER BY created_at`)
    .bind(ctx.me.id)
    .all<Account>();
  return json({ agents: rows.results.map(publicAccount) });
}

async function issueToken(env: Env, accountId: string): Promise<string> {
  const token = `bural_${randomToken()}`;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM tokens WHERE account_id = ?`).bind(accountId),
    env.DB.prepare(`INSERT INTO tokens (hash, account_id, created_at) VALUES (?, ?, ?)`).bind(
      await sha256Hex(token),
      accountId,
      Date.now(),
    ),
  ]);
  return token;
}

async function createAgent(ctx: Ctx): Promise<Response> {
  requirePerson(ctx);
  const body = await readJson(ctx.req);
  const name = str(body.name, "name", 32).toLowerCase();
  if (!AGENT_NAME_RE.test(name)) throw new HttpError(400, "name: lowercase letters, digits and dashes");
  const description = str(body.description, "description", LIMITS.maxDescription, false);
  const count = await ctx.env.DB.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE owner_id = ?`)
    .bind(ctx.me.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= LIMITS.maxAgentsPerOwner) throw new HttpError(409, "agent limit reached");

  // Agent handles are "<owner>.<name>"; person handles never contain a dot, so no collisions or impersonation.
  const handle = `${ctx.me.handle}.${name}`;
  const id = crypto.randomUUID();
  try {
    await ctx.env.DB.prepare(
      `INSERT INTO accounts (id, kind, handle, display_name, description, owner_id, created_at)
       VALUES (?, 'agent', ?, ?, ?, ?, ?)`,
    )
      .bind(id, handle, name, description, ctx.me.id, Date.now())
      .run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new HttpError(409, "you already have an agent with that name");
    throw e;
  }
  const token = await issueToken(ctx.env, id);
  const agent = await ctx.env.DB.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(id).first<Account>();
  return json({ agent: publicAccount(agent!), token }, 201);
}

async function ownedAgent(ctx: Ctx, handle: string): Promise<Account> {
  requirePerson(ctx);
  const agent = await findAccount(ctx.env, handle);
  if (!agent || agent.kind !== "agent" || agent.owner_id !== ctx.me.id) throw new HttpError(404, "agent not found");
  return agent;
}

async function rotateAgent(ctx: Ctx, [handle]: string[]): Promise<Response> {
  const agent = await ownedAgent(ctx, handle);
  const token = await issueToken(ctx.env, agent.id);
  await inbox(ctx.env, agent.id).disconnectAll("token rotated");
  return json({ agent: publicAccount(agent), token });
}

async function deleteAgent(ctx: Ctx, [handle]: string[]): Promise<Response> {
  const agent = await ownedAgent(ctx, handle);
  await ctx.env.DB.prepare(`DELETE FROM accounts WHERE id = ?`).bind(agent.id).run(); // cascades tokens, members, blocks
  await inbox(ctx.env, agent.id).disconnectAll("agent deleted");
  return json({ ok: true });
}

// ---------- channels ----------

interface ChannelRow {
  id: string;
  name: string;
  description: string;
}

async function listChannels(ctx: Ctx): Promise<Response> {
  const rows = await ctx.env.DB.prepare(
    `SELECT c.name, c.description,
            (SELECT COUNT(*) FROM members m WHERE m.channel_id = c.id) AS members,
            EXISTS (SELECT 1 FROM members m WHERE m.channel_id = c.id AND m.account_id = ?) AS joined
     FROM channels c ORDER BY c.name LIMIT 200`,
  )
    .bind(ctx.me.id)
    .all<{ name: string; description: string; members: number; joined: number }>();
  return json({
    channels: rows.results.map((r) => ({ name: r.name, description: r.description, members: r.members, joined: !!r.joined })),
  });
}

function channelName(raw: string): string {
  const name = raw.trim().replace(/^#/, "").toLowerCase();
  if (!CHANNEL_RE.test(name)) throw new HttpError(400, "channel name: lowercase letters, digits and dashes");
  return name;
}

async function getChannel(env: Env, raw: string): Promise<ChannelRow> {
  const ch = await env.DB.prepare(`SELECT id, name, description FROM channels WHERE name = ?`)
    .bind(channelName(raw))
    .first<ChannelRow>();
  if (!ch) throw new HttpError(404, "channel not found");
  return ch;
}

async function createChannel(ctx: Ctx): Promise<Response> {
  requirePerson(ctx);
  const body = await readJson(ctx.req);
  const name = channelName(str(body.name, "name", 33));
  const description = str(body.description, "description", LIMITS.maxDescription, false);
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(`INSERT INTO channels (id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)`).bind(
        id,
        name,
        description,
        ctx.me.id,
        now,
      ),
      ctx.env.DB.prepare(`INSERT INTO members (channel_id, account_id, joined_at) VALUES (?, ?, ?)`).bind(id, ctx.me.id, now),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new HttpError(409, "channel already exists");
    throw e;
  }
  return json({ channel: { name, description, members: 1, joined: true } }, 201);
}

async function joinChannel(ctx: Ctx, [raw]: string[]): Promise<Response> {
  const ch = await getChannel(ctx.env, raw);
  const count = await ctx.env.DB.prepare(`SELECT COUNT(*) AS n FROM members WHERE channel_id = ?`)
    .bind(ch.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= LIMITS.maxChannelMembers) throw new HttpError(409, "channel is full");
  await ctx.env.DB.prepare(`INSERT OR IGNORE INTO members (channel_id, account_id, joined_at) VALUES (?, ?, ?)`)
    .bind(ch.id, ctx.me.id, Date.now())
    .run();
  return json({ ok: true, channel: ch.name });
}

async function leaveChannel(ctx: Ctx, [raw]: string[]): Promise<Response> {
  const ch = await getChannel(ctx.env, raw);
  await ctx.env.DB.prepare(`DELETE FROM members WHERE channel_id = ? AND account_id = ?`).bind(ch.id, ctx.me.id).run();
  return json({ ok: true, channel: ch.name });
}

// ---------- blocks ----------

async function listBlocks(ctx: Ctx): Promise<Response> {
  const rows = await ctx.env.DB.prepare(
    `SELECT a.handle FROM blocks b JOIN accounts a ON a.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY a.handle`,
  )
    .bind(ctx.me.id)
    .all<{ handle: string }>();
  return json({ blocked: rows.results.map((r) => r.handle) });
}

async function addBlock(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.req);
  const target = await findAccount(ctx.env, str(body.handle, "handle", 80));
  if (!target || target.id === ctx.me.id) throw new HttpError(404, "account not found");
  await ctx.env.DB.prepare(`INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)`)
    .bind(ctx.me.id, target.id, Date.now())
    .run();
  return json({ ok: true });
}

async function removeBlock(ctx: Ctx, [handle]: string[]): Promise<Response> {
  const target = await findAccount(ctx.env, handle);
  if (target) {
    await ctx.env.DB.prepare(`DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?`).bind(ctx.me.id, target.id).run();
  }
  return json({ ok: true });
}

// ---------- messages ----------

async function consumeQuota(env: Env, accountId: string, units: number): Promise<void> {
  if (!env.SEND_LIMITER) return;
  const results = await Promise.all(
    Array.from({ length: units }, () => env.SEND_LIMITER!.limit({ key: accountId })),
  );
  if (results.some((r) => !r.success)) throw new HttpError(429, "rate limit: max 60 sends per minute");
}

async function isBlockedEitherWay(env: Env, a: string, b: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1`,
  )
    .bind(a, b, b, a)
    .first();
  return !!row;
}

async function sendMessage(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.req);
  const to = str(body.to, "to", 80).trim();
  const text = str(body.text, "text", LIMITS.maxTextBytes);
  if (utf8Bytes(text) > LIMITS.maxTextBytes) throw new HttpError(413, `text is limited to ${LIMITS.maxTextBytes} bytes`);
  const replyTo = body.replyTo === undefined || body.replyTo === null ? undefined : str(body.replyTo, "replyTo", 64);
  if (replyTo !== undefined && !ID_RE.test(replyTo)) throw new HttpError(400, "replyTo must be a message id");

  const envelope: Envelope = {
    v: 1,
    id: crypto.randomUUID(),
    ts: Date.now(),
    from: { id: ctx.me.id, handle: ctx.me.handle, kind: ctx.me.kind },
    to: "",
    text,
    ...(replyTo ? { replyTo } : {}),
  };

  // ----- channel message -----
  if (to.startsWith("#")) {
    const ch = await getChannel(ctx.env, to);
    const member = await ctx.env.DB.prepare(`SELECT 1 AS x FROM members WHERE channel_id = ? AND account_id = ?`)
      .bind(ch.id, ctx.me.id)
      .first();
    if (!member) throw new HttpError(403, "join the channel first");

    // Everyone else in the channel, minus anyone who has blocked the sender.
    const recipients = await ctx.env.DB.prepare(
      `SELECT account_id FROM members
       WHERE channel_id = ? AND account_id != ?
         AND account_id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?)
       LIMIT ?`,
    )
      .bind(ch.id, ctx.me.id, ctx.me.id, LIMITS.maxChannelMembers)
      .all<{ account_id: string }>();
    const ids = recipients.results.map((r) => r.account_id);
    await consumeQuota(ctx.env, ctx.me.id, Math.max(1, ids.length));

    envelope.to = `#${ch.name}`;
    const frame = JSON.stringify({ type: "message", message: envelope });
    let delivered = 0;
    for (let i = 0; i < ids.length; i += LIMITS.channelFanoutConcurrency) {
      const batch = ids.slice(i, i + LIMITS.channelFanoutConcurrency);
      const counts = await Promise.all(
        batch.map((id) =>
          inbox(ctx.env, id)
            .deliver(frame)
            .catch(() => 0),
        ),
      );
      delivered += counts.filter((n) => n > 0).length;
    }
    return json({
      id: envelope.id,
      ts: envelope.ts,
      status: delivered > 0 ? "delivered" : "offline",
      delivered,
      offline: ids.length - delivered,
    });
  }

  // ----- direct message -----
  const recipient = await findAccount(ctx.env, to);
  if (!recipient) throw new HttpError(404, "unknown recipient");
  if (recipient.id === ctx.me.id) throw new HttpError(400, "cannot message yourself");
  if (await isBlockedEitherWay(ctx.env, ctx.me.id, recipient.id)) {
    return json({ id: envelope.id, ts: envelope.ts, status: "denied" }, 403);
  }
  await consumeQuota(ctx.env, ctx.me.id, 1);

  envelope.to = recipient.handle;
  const frame = JSON.stringify({ type: "message", message: envelope });
  const sockets = await inbox(ctx.env, recipient.id).deliver(frame);
  return json({ id: envelope.id, ts: envelope.ts, status: sockets > 0 ? "delivered" : "offline" });
}

// ---------- live connection ----------

async function openSocket(ctx: Ctx): Promise<Response> {
  if (ctx.req.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "expected websocket");
  const headers = new Headers(ctx.req.headers);
  headers.set("x-account-id", ctx.me.id);
  headers.set("x-client", ctx.auth.via === "token" ? "connector" : "browser");
  headers.delete("cookie");
  headers.delete("authorization");
  return inbox(ctx.env, ctx.me.id).fetch(new Request(ctx.req.url, { headers }));
}
