// End-to-end test against a running local server:
//   cp .dev.vars.example .dev.vars   (DEV_LOGIN=1)
//   npm run db:migrate:local && npm run dev
//   (cd connector && npm install && npm run build)
//   npm run test:e2e
// Prints the canary string on the last line so you can grep local storage for it.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CANARY = `CANARY-${randomUUID()}`;
const run = randomUUID().slice(0, 6);

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(handle) {
  const r = await fetch(`${BASE}/auth/dev-login?handle=${handle}`);
  if (!r.ok) throw new Error(`dev login failed (${r.status}). Is DEV_LOGIN=1 set in .dev.vars?`);
  return r.headers.get("set-cookie").split(";")[0];
}

function cookieClient(cookie) {
  return async (method, p, body, origin = BASE) => {
    const r = await fetch(BASE + p, {
      method,
      headers: { cookie, origin, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
}

function tokenClient(token) {
  return async (method, p, body) => {
    const r = await fetch(BASE + p, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
}

/** Opens a live socket; resolves after the server's hello frame. */
function openSocket(headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/ws`, { headers });
    const inbox = [];
    const waiters = [];
    let closeCode = null;
    let revoked = false;
    ws.on("unexpected-response", (_req, res) => reject(new Error(`ws rejected ${res.statusCode}`)));
    ws.on("error", (e) => reject(e));
    ws.on("close", (code) => (closeCode = code));
    ws.on("message", (raw) => {
      const s = raw.toString();
      if (s === "pong") return;
      const frame = JSON.parse(s);
      if (frame.type === "hello") {
        resolve({
          ws,
          inbox,
          closeCode: () => closeCode,
          revoked: () => revoked,
          next: (ms = 3000) =>
            new Promise((res) => {
              if (inbox.length) return res(inbox.shift());
              const waiter = (m) => {
                clearTimeout(t);
                res(m);
              };
              const t = setTimeout(() => {
                waiters.splice(waiters.indexOf(waiter), 1);
                res(null);
              }, ms);
              waiters.push(waiter);
            }),
        });
      } else if (frame.type === "revoked") {
        revoked = true;
      } else if (frame.type === "message") {
        const w = waiters.shift();
        if (w) w(frame.message);
        else inbox.push(frame.message);
      }
    });
  });
}

async function main() {
  const A = `alice${run}`;
  const B = `bob${run}`;
  const C = `carol${run}`;
  const alice = cookieClient(await login(A));
  const bobCookie = await login(B);
  const bob = cookieClient(bobCookie);
  await login(C); // carol exists but never connects

  // ---- accounts and agents ----
  const me = await alice("GET", "/api/me");
  check("me returns signed-in person", me.status === 200 && me.data.account.handle === A, me);
  check("unauthenticated request is rejected", (await fetch(`${BASE}/api/me`)).status === 401);

  const created = await alice("POST", "/api/agents", { name: "codex", description: "test agent" });
  check("person creates an agent", created.status === 201 && created.data.agent.handle === `${A}.codex`, created);
  let token = created.data.token;
  check("token is returned once with bural_ prefix", typeof token === "string" && token.startsWith("bural_"));
  const agentApi = tokenClient(token);
  const agentMe = await agentApi("GET", "/api/me");
  check("agent authenticates with its token", agentMe.status === 200 && agentMe.data.owner === A, agentMe);
  check("agent cannot create agents", (await agentApi("POST", "/api/agents", { name: "x" })).status === 403);
  check("bob cannot delete alice's agent", (await bob("DELETE", `/api/agents/${A}.codex`)).status === 404);
  check("bob cannot rotate alice's agent", (await bob("POST", `/api/agents/${A}.codex/rotate`)).status === 404);

  // ---- CSRF / origin ----
  const evil = await alice("POST", "/api/messages", { to: B, text: "x" }, "https://evil.example");
  check("cross-origin cookie POST is rejected", evil.status === 403, evil);
  let evilWs = null;
  try {
    evilWs = await openSocket({ cookie: bobCookie, origin: "https://evil.example" });
  } catch {}
  check("cross-origin cookie WebSocket is rejected", evilWs === null);
  evilWs?.ws.close();

  // ---- direct messages ----
  const bobWs = await openSocket({ cookie: bobCookie, origin: BASE });
  const dm = await alice("POST", "/api/messages", { to: `@${B}`, text: `hi ${CANARY}` });
  check("DM to online person -> delivered", dm.status === 200 && dm.data.status === "delivered", dm);
  const got = await bobWs.next();
  check("bob receives the DM live", got?.text === `hi ${CANARY}` && got.from.handle === A && got.to === B, got);
  check("server sets id/ts/from", got && got.id === dm.data.id && typeof got.ts === "number" && got.from.kind === "person");

  const reply = await bob("POST", "/api/messages", { to: A, text: "reply", replyTo: dm.data.id });
  check("reply to offline sender -> offline", reply.data.status === "offline", reply);

  const off = await alice("POST", "/api/messages", { to: C, text: "are you there" });
  check("DM to offline person -> offline (not queued)", off.data.status === "offline", off);

  const unknown = await alice("POST", "/api/messages", { to: "nobody-xyz", text: "x" });
  check("unknown recipient -> 404", unknown.status === 404, unknown);

  const big = await alice("POST", "/api/messages", { to: B, text: "é".repeat(9000) });
  check("text over 16 KiB (UTF-8 bytes) is rejected", big.status === 413, big.status);

  const spoof = await alice("POST", "/api/messages", { to: B, text: "x", from: { handle: "admin" }, id: "fake" });
  const spoofed = await bobWs.next();
  check("client cannot spoof sender or id", spoof.status === 200 && spoofed?.from.handle === A && spoofed.id !== "fake", spoofed);

  // ---- blocking ----
  await bob("POST", "/api/blocks", { handle: A });
  const blocked = await alice("POST", "/api/messages", { to: B, text: "blocked?" });
  check("blocked sender -> denied", blocked.status === 403 && blocked.data.status === "denied", blocked);
  const blockedOther = await bob("POST", "/api/messages", { to: A, text: "x" });
  check("blocker cannot message the blocked account either", blockedOther.data.status === "denied", blockedOther);
  check("blocked message never reaches bob", (await bobWs.next(500)) === null);
  await bob("DELETE", `/api/blocks/${A}`);
  const unblocked = await alice("POST", "/api/messages", { to: B, text: "after unblock" });
  check("after unblock -> delivered", unblocked.data.status === "delivered", unblocked);
  await bobWs.next();

  // ---- agent over raw socket ----
  let agentWs = await openSocket({ authorization: `Bearer ${token}` });
  const toAgent = await bob("POST", "/api/messages", { to: `${A}.codex`, text: "hello agent" });
  check("DM to online agent -> delivered", toAgent.data.status === "delivered", toAgent);
  check("agent socket receives it", (await agentWs.next())?.text === "hello agent");

  // ---- channels ----
  const ch = `test-${run}`;
  const mk = await alice("POST", "/api/channels", { name: ch, description: "e2e" });
  check("person creates a channel", mk.status === 201, mk);
  check("agent cannot create channels", (await agentApi("POST", "/api/channels", { name: `x-${run}` })).status === 403);
  const notMember = await bob("POST", "/api/messages", { to: `#${ch}`, text: "x" });
  check("non-member cannot post to channel", notMember.status === 403, notMember);
  await bob("POST", `/api/channels/${ch}/join`);
  await agentApi("POST", `/api/channels/${ch}/join`);
  await cookieClient(await login(C))("POST", `/api/channels/${ch}/join`); // carol joins but stays offline
  const list = await bob("GET", "/api/channels");
  const listed = list.data.channels.find((c) => c.name === ch);
  check("channel list shows membership and count", listed?.joined === true && listed.members === 4, listed);

  const post = await alice("POST", "/api/messages", { to: `#${ch}`, text: `channel ${CANARY}` });
  check("channel send reports delivered/offline counts", post.data.delivered === 2 && post.data.offline === 1, post);
  const b1 = await bobWs.next();
  const a1 = await agentWs.next();
  check("bob and agent receive channel message", b1?.to === `#${ch}` && a1?.to === `#${ch}` && b1.text === `channel ${CANARY}`);

  await bob("POST", `/api/channels/${ch}/leave`);
  const post2 = await alice("POST", `/api/messages`, { to: `#${ch}`, text: "after leave" });
  check("after leaving, member stops receiving", post2.data.delivered === 1 && (await bobWs.next(500)) === null, post2);
  await agentWs.next();

  // ---- token rotation revokes live access ----
  const rotated = await alice("POST", `/api/agents/${A}.codex/rotate`);
  check("rotate issues a new token", rotated.status === 200 && rotated.data.token !== token, rotated.status);
  for (let i = 0; i < 30 && !agentWs.revoked(); i++) await sleep(100);
  check("old agent socket gets a revoked frame", agentWs.revoked());
  agentWs.ws.terminate();
  check("old token is rejected", (await tokenClient(token)("GET", "/api/me")).status === 401);
  token = rotated.data.token;

  // ---- MCP connector ----
  const sdk = path.join(ROOT, "connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client");
  const { Client } = await import(pathToFileURL(path.join(sdk, "index.js")).href);
  const { StdioClientTransport } = await import(pathToFileURL(path.join(sdk, "stdio.js")).href);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "connector/dist/index.js")],
    env: { ...process.env, BURAL_URL: BASE, BURAL_TOKEN: token },
    stderr: "ignore",
  });
  const mcp = new Client({ name: "e2e", version: "0.0.0" });
  await mcp.connect(transport);
  const call = async (name, args = {}) => {
    const r = await mcp.callTool({ name, arguments: args });
    const text = r.content[0].text;
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text, isError: r.isError };
    }
  };
  const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
  check("connector exposes the planned tools", JSON.stringify(tools) === JSON.stringify(
    ["find_people", "join_channel", "leave_channel", "list_channels", "read_messages", "send_message", "wait_for_messages", "whoami"],
  ), tools);
  await sleep(1000);
  const who = await call("whoami");
  check("connector whoami + connected", who.account?.handle === `${A}.codex` && who.connection === "connected", who);

  const sent = await call("send_message", { to: B, text: "from connector" });
  check("connector send -> delivered", sent.status === "delivered", sent);
  check("bob receives connector message", (await bobWs.next())?.from.handle === `${A}.codex`);

  const waiting = call("wait_for_messages", { timeoutSec: 10 });
  await sleep(300);
  await bob("POST", "/api/messages", { to: `${A}.codex`, text: `to connector ${CANARY}` });
  const waited = await waiting;
  check("wait_for_messages returns a live message", waited.messages?.[0]?.text === `to connector ${CANARY}`, waited);
  check("connector labels messages as untrusted", typeof waited.note === "string" && waited.note.includes("untrusted"));

  await bob("POST", "/api/messages", { to: `${A}.codex`, text: "buffered" });
  await sleep(300);
  const read = await call("read_messages");
  check("read_messages drains the RAM buffer", read.messages?.length === 1 && read.messages[0].text === "buffered", read);
  check("buffer is empty after drain", (await call("read_messages")).messages.length === 0);

  const t0 = Date.now();
  const empty = await call("wait_for_messages", { timeoutSec: 1 });
  check("wait_for_messages times out with no messages", empty.messages.length === 0 && Date.now() - t0 >= 900);

  await mcp.close();

  // ---- cleanup ----
  const del = await alice("DELETE", `/api/agents/${A}.codex`);
  check("delete agent", del.status === 200);
  check("deleted agent's token is rejected", (await tokenClient(token)("GET", "/api/me")).status === 401);
  bobWs.ws.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(`canary: ${CANARY}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
