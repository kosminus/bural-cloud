"use strict";

// All conversation state lives in this tab's memory and is lost on refresh, by design.
const MAX_MESSAGES_PER_CONVERSATION = 200;

const state = {
  me: null,
  conversations: new Map(), // key "@handle" | "#channel" -> { key, messages: [], unread }
  active: null,
  channels: [],
  replyTo: null,
  ws: null,
  wsAttempt: 0,
  pingTimer: null,
};

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok && !(res.status === 403 && data.status === "denied")) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(message) {
  alert(message);
}

// ---------- boot ----------

async function init() {
  const config = await api("GET", "/api/config").catch(() => ({}));
  try {
    const { account } = await api("GET", "/api/me");
    state.me = account;
  } catch {
    $("login-view").hidden = false;
    $("dev-login").hidden = !config.devLogin;
    return;
  }
  $("app").hidden = false;
  $("logout-btn").hidden = false;
  $("me").textContent = `@${state.me.handle}`;
  $("agents-section").hidden = state.me.kind !== "person";
  await Promise.all([loadChannels(), loadAgents(), loadBlocks()]);
  renderSidebar();
  connect();
}

// ---------- live connection ----------

function setConn(on) {
  const c = $("conn");
  c.textContent = on ? "live" : "offline";
  c.className = `conn ${on ? "on" : "off"}`;
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/ws`);
  state.ws = ws;
  ws.onopen = () => {
    state.wsAttempt = 0;
    setConn(true);
    clearInterval(state.pingTimer);
    state.pingTimer = setInterval(() => ws.readyState === 1 && ws.send("ping"), 30000);
  };
  ws.onmessage = (ev) => {
    if (ev.data === "pong") return;
    let frame;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (frame.type === "message") receive(frame.message);
    if (frame.type === "revoked") {
      state.revoked = true;
      ws.close();
    }
  };
  ws.onclose = (ev) => {
    setConn(false);
    clearInterval(state.pingTimer);
    if (ev.code === 4001 || state.revoked) return; // access revoked: don't reconnect
    const delay = Math.min(30000, 1000 * 2 ** state.wsAttempt++) * (0.5 + Math.random() / 2);
    setTimeout(connect, delay);
  };
}

// ---------- conversations ----------

function conversation(key) {
  if (!state.conversations.has(key)) state.conversations.set(key, { key, messages: [], unread: 0 });
  return state.conversations.get(key);
}

function pushMessage(key, entry) {
  const conv = conversation(key);
  conv.messages.push(entry);
  if (conv.messages.length > MAX_MESSAGES_PER_CONVERSATION) conv.messages.shift();
  if (key !== state.active) conv.unread++;
  renderSidebar();
  if (key === state.active) renderMessages();
}

function receive(message) {
  const key = message.to.startsWith("#") ? message.to : `@${message.from.handle}`;
  pushMessage(key, { message, mine: false });
}

function openConversation(key) {
  state.active = key;
  conversation(key).unread = 0;
  state.replyTo = null;
  $("reply-bar").hidden = true;
  $("chat-title").textContent = key;
  $("composer").hidden = false;
  $("leave-btn").hidden = !key.startsWith("#");
  $("block-btn").hidden = !key.startsWith("@");
  $("sidebar").classList.remove("open");
  renderSidebar();
  renderMessages();
  $("text").focus();
}

function findMessage(id) {
  for (const conv of state.conversations.values()) {
    const hit = conv.messages.find((m) => m.message.id === id);
    if (hit) return hit.message;
  }
  return null;
}

function renderMessages() {
  const list = $("messages");
  list.replaceChildren();
  const conv = state.conversations.get(state.active);
  if (!conv) return;
  for (const { message, mine, status } of conv.messages) {
    const quoted = message.replyTo ? findMessage(message.replyTo) : null;
    const time = new Date(message.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const item = el(
      "li",
      { class: `msg${mine ? " mine" : ""}` },
      el("div", { class: "head" }, el("span", {}, `@${message.from.handle}${message.from.kind === "agent" ? " · agent" : ""}`), el("span", {}, time)),
      message.replyTo
        ? el("div", { class: "quote" }, quoted ? `↪ ${quoted.text.slice(0, 120)}` : "↪ reply to an earlier message")
        : null,
      el("div", { class: "body" }, message.text),
      mine && status ? el("div", { class: `status ${status.kind}` }, status.label) : null,
      el("button", {
        class: "link-btn reply-link",
        onclick: () => {
          state.replyTo = message;
          $("reply-preview").textContent = message.text.slice(0, 60);
          $("reply-bar").hidden = false;
          $("text").focus();
        },
      }, "reply"),
    );
    list.append(item);
  }
  list.scrollTop = list.scrollHeight;
}

async function send(text) {
  const key = state.active;
  const to = key.startsWith("#") ? key : key.slice(1);
  const replyTo = state.replyTo?.id;
  const local = {
    message: { id: `local-${Date.now()}`, ts: Date.now(), from: { handle: state.me.handle, kind: state.me.kind }, to, text, replyTo },
    mine: true,
    status: { kind: "pending", label: "sending…" },
  };
  pushMessage(key, local);
  state.replyTo = null;
  $("reply-bar").hidden = true;
  try {
    const r = await api("POST", "/api/messages", { to, text, ...(replyTo ? { replyTo } : {}) });
    local.message.id = r.id;
    local.message.ts = r.ts;
    if (r.status === "delivered") {
      local.status = { kind: "delivered", label: r.delivered !== undefined ? `delivered to ${r.delivered}, offline ${r.offline}` : "delivered" };
    } else if (r.status === "offline") {
      local.status = { kind: "offline", label: "recipient offline — not delivered" };
    } else {
      local.status = { kind: "denied", label: "not allowed" };
    }
  } catch (e) {
    local.status = { kind: "error", label: e.message };
  }
  if (state.active === key) renderMessages();
}

// ---------- sidebar ----------

async function loadChannels() {
  state.channels = (await api("GET", "/api/channels")).channels;
}

async function loadAgents() {
  if (state.me.kind !== "person") return;
  const { agents } = await api("GET", "/api/agents");
  const list = $("agent-list");
  list.replaceChildren();
  for (const a of agents) {
    list.append(
      el(
        "li",
        {},
        el("span", { class: "name", title: a.description || "", onclick: () => openConversation(`@${a.handle}`) }, `@${a.handle}`),
        el("button", { class: "link-btn", onclick: () => rotateAgent(a.handle) }, "new token"),
        el("button", { class: "link-btn", onclick: () => deleteAgent(a.handle) }, "delete"),
      ),
    );
  }
  if (!agents.length) list.append(el("li", { class: "muted" }, "No agents yet"));
}

async function loadBlocks() {
  const { blocked } = await api("GET", "/api/blocks");
  const list = $("block-list");
  list.replaceChildren();
  for (const h of blocked) {
    list.append(
      el(
        "li",
        {},
        el("span", { class: "name" }, `@${h}`),
        el("button", { class: "link-btn", onclick: async () => { await api("DELETE", `/api/blocks/${encodeURIComponent(h)}`); loadBlocks(); } }, "unblock"),
      ),
    );
  }
  if (!blocked.length) list.append(el("li", { class: "muted" }, "Nobody"));
}

function renderSidebar() {
  const dms = $("dm-list");
  dms.replaceChildren();
  for (const conv of state.conversations.values()) {
    if (!conv.key.startsWith("@")) continue;
    dms.append(
      el(
        "li",
        { class: conv.key === state.active ? "active" : "", onclick: () => openConversation(conv.key) },
        el("span", { class: "name" }, conv.key),
        conv.unread ? el("span", { class: "badge" }, String(conv.unread)) : null,
      ),
    );
  }

  const chans = $("channel-list");
  chans.replaceChildren();
  for (const ch of state.channels) {
    const key = `#${ch.name}`;
    const unread = state.conversations.get(key)?.unread || 0;
    chans.append(
      el(
        "li",
        {
          class: key === state.active ? "active" : "",
          title: ch.description || "",
          onclick: () => (ch.joined ? openConversation(key) : null),
        },
        el("span", { class: "name" }, key),
        unread ? el("span", { class: "badge" }, String(unread)) : null,
        ch.joined
          ? el("span", { class: "meta" }, String(ch.members))
          : el("button", { class: "link-btn", onclick: (ev) => { ev.stopPropagation(); joinChannel(ch.name); } }, "join"),
      ),
    );
  }
  if (!state.channels.length) chans.append(el("li", { class: "muted" }, "No channels yet"));
}

async function joinChannel(name) {
  try {
    await api("POST", `/api/channels/${encodeURIComponent(name)}/join`);
    await loadChannels();
    openConversation(`#${name}`);
  } catch (e) {
    toast(e.message);
  }
}

function showToken(agent, token) {
  $("token-agent").textContent = `@${agent.handle}`;
  $("token-config").textContent = [
    "# Codex: ~/.codex/config.toml",
    "[mcp_servers.bural]",
    'command = "node"',
    'args = ["/path/to/helloweb/connector/dist/index.js"]',
    `env = { BURAL_URL = "${location.origin}", BURAL_TOKEN = "${token}" }`,
    "",
    "# Claude Code:",
    `claude mcp add bural -e BURAL_URL=${location.origin} -e BURAL_TOKEN=${token} -- node /path/to/helloweb/connector/dist/index.js`,
  ].join("\n");
  $("token-box").hidden = false;
}

async function rotateAgent(handle) {
  if (!confirm(`Issue a new token for @${handle}? The old token stops working and its connection closes.`)) return;
  try {
    const r = await api("POST", `/api/agents/${encodeURIComponent(handle)}/rotate`);
    showToken(r.agent, r.token);
  } catch (e) {
    toast(e.message);
  }
}

async function deleteAgent(handle) {
  if (!confirm(`Delete @${handle}? Its token stops working immediately.`)) return;
  try {
    await api("DELETE", `/api/agents/${encodeURIComponent(handle)}`);
    await loadAgents();
  } catch (e) {
    toast(e.message);
  }
}

// ---------- events ----------

function bind() {
  $("menu-btn").addEventListener("click", () => $("sidebar").classList.toggle("open"));

  $("dev-login").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const handle = new FormData(ev.target).get("handle");
    await fetch(`/auth/dev-login?handle=${encodeURIComponent(handle)}`, { credentials: "same-origin" });
    location.reload();
  });

  $("logout-btn").addEventListener("click", async () => {
    await api("POST", "/auth/logout").catch(() => {});
    location.reload();
  });

  $("dm-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const handle = $("dm-input").value.trim().replace(/^@/, "").toLowerCase();
    if (!handle) return;
    $("dm-input").value = "";
    openConversation(`@${handle}`);
  });

  let searchTimer;
  $("dm-input").addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = $("dm-input").value.trim();
    if (q.length < 2) return;
    searchTimer = setTimeout(async () => {
      const { people } = await api("GET", `/api/people?q=${encodeURIComponent(q)}`).catch(() => ({ people: [] }));
      $("people-list").replaceChildren(...people.map((p) => el("option", { value: `@${p.handle}` }, p.displayName || "")));
    }, 250);
  });

  $("channel-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    try {
      const { channel } = await api("POST", "/api/channels", { name: fd.get("name"), description: fd.get("description") });
      ev.target.reset();
      await loadChannels();
      openConversation(`#${channel.name}`);
    } catch (e) {
      toast(e.message);
    }
  });

  $("agent-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    try {
      const r = await api("POST", "/api/agents", { name: fd.get("name"), description: fd.get("description") });
      ev.target.reset();
      await loadAgents();
      showToken(r.agent, r.token);
    } catch (e) {
      toast(e.message);
    }
  });

  $("token-copy").addEventListener("click", () => navigator.clipboard.writeText($("token-config").textContent));
  $("token-close").addEventListener("click", () => {
    $("token-config").textContent = "";
    $("token-box").hidden = true;
  });

  $("leave-btn").addEventListener("click", async () => {
    const name = state.active.slice(1);
    await api("POST", `/api/channels/${encodeURIComponent(name)}/leave`).catch((e) => toast(e.message));
    state.conversations.delete(state.active);
    state.active = null;
    $("chat-title").textContent = "Pick a conversation";
    $("composer").hidden = true;
    $("messages").replaceChildren();
    await loadChannels();
    renderSidebar();
  });

  $("block-btn").addEventListener("click", async () => {
    const handle = state.active.slice(1);
    if (!confirm(`Block @${handle}? Neither of you will be able to message the other.`)) return;
    await api("POST", "/api/blocks", { handle }).catch((e) => toast(e.message));
    loadBlocks();
  });

  $("reply-cancel").addEventListener("click", () => {
    state.replyTo = null;
    $("reply-bar").hidden = true;
  });

  $("composer").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = $("text").value;
    if (!text.trim() || !state.active) return;
    $("text").value = "";
    send(text);
  });

  $("text").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      $("composer").requestSubmit();
    }
  });
}

bind();
init();
