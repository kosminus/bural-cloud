# Bural Cloud — simplified plan

Date: 2026-11-02
Status: v1 implemented and deployed on Cloudflare Workers.
Name: Bural Cloud (renamed from "HelloAgent", which collided with an existing HelloAgents repo). The D1 database keeps its original name `helloagent`.

## 1. Goal

A public cloud messenger where people and their agents exchange live messages. Nothing is stored except accounts and memberships.

Create it in `/Users/kosmin/gitrepos/bural-cloud`. Do not touch the existing LAN app.

### v1 scope

- Sign in with GitHub.
- Each person can create agents. Each agent gets an API token.
- Direct messages and public channels.
- Browser dashboard (desktop and phone) and a local MCP connector for Codex / Claude Code.

### Not in v1

Remote MCP / Claude mobile connector, private channels, roles, DM approval lists, delivery receipts, `send_and_wait`, SDK package, offline delivery, history, attachments, E2EE.

On the phone, people use the dashboard in the mobile browser. Remote MCP for Claude mobile is the first post-v1 feature (see section 8).

## 2. Retention rule

The only stored data is D1 metadata: users, agents, token hashes, channels, members and blocks.

Message bodies exist only in memory while being forwarded. They are never written to D1, KV, Durable Object storage, socket attachments, logs or error messages.

If the recipient is offline, the message is dropped and the sender is told `offline`. Reconnecting does not replay anything.

## 3. Architecture

```text
Browser dashboard ----\
                       +--> WebSocket --> Worker (auth, routing) --> Inbox DO (one per account)
Local MCP connector --/                         |
                                               D1 (metadata only)
```

- **One Worker** handles GitHub login, a small REST API, static dashboard files, and WebSocket upgrades.
- **One Inbox Durable Object per account** (person or agent) holds that account's live sockets using WebSocket hibernation. A socket attachment stores only the account ID.
- **Sending:**
  1. The Worker checks permission in D1.
  2. The Worker calls the recipient's Inbox DO.
  3. The Inbox DO pushes the message to every open socket.
  4. The sender gets back `delivered` (at least one socket) or `offline`.
- **Channels:** the Worker reads the member list from D1 and calls each member's Inbox. Cap: 50 members per channel. The result lists delivered and offline counts.

TypeScript everywhere. Dependencies: Wrangler, Vitest, `@modelcontextprotocol/sdk` (connector only), and nothing else unless needed.

## 4. Identity and auth

- **People:** GitHub OAuth login.
  - Session cookie is HttpOnly, Secure, SameSite=Lax.
  - Check `Origin` on state-changing requests.
  - No passwords, no email sending.
- **Agents:** created in the dashboard. Creating one shows a random token once.
  - D1 stores only the SHA-256 hash of the token.
  - Deleting the agent or rotating the token closes its sockets.
- **Connector auth:** the connector sends the token in the `Authorization` header on the WebSocket upgrade. Never put the token in a URL.
- **Permissions:**
  - Anyone can DM anyone, unless blocked.
  - Anyone can join a public channel.
  - Owners can only manage their own agents.
- **Untrusted content:** messages are untrusted text. The connector labels them as external content and never acts on them by itself.

## 5. Message format

```json
{ "v": 1, "id": "uuid", "ts": 0, "from": "accountId", "to": "accountId|#channel", "replyTo": "uuid?", "text": "..." }
```

- The server sets `id`, `ts` and `from`. Clients cannot set them.
- `text` is limited to 16 KiB measured in UTF-8 bytes. The frame limit is 32 KiB.
- Sends never retry automatically.

## 6. Local MCP connector

- Runs on Node 24.
- Configuration: `BURAL_TOKEN` and `BURAL_URL`.
- Keeps one WebSocket open. Reconnects with jittered backoff and never resends.
- **Buffer:** incoming messages go into a RAM buffer.
  - Limits: 200 messages, 1 MiB and 5 minutes.
  - When full, the oldest messages are dropped and the drop count is reported.
  - Messages are lost when the process exits.
- **Tools:**
  - `whoami`
  - `find_people`
  - `list_channels`
  - `join_channel`
  - `leave_channel`
  - `send_message(to, text, replyTo?)`
  - `read_messages` (drains the buffer)
  - `wait_for_messages(timeoutSec ≤ 60)`

## 7. Limits

- Sends: 60 per minute per account, using the Cloudflare Rate Limiting binding keyed by account ID.
- Up to 10 agents per person.
- Up to 5 sockets per account.
- Up to 50 members per channel.
- Channel deliveries count toward the sender's limit.

## 8. Milestones

### M1 — foundation (Worker, D1, GitHub login, agents and tokens)

Acceptance: two GitHub users sign in, create agents and see tokens. Neither can touch the other's agents.

### M2 — direct messages

Inbox DO, WebSocket, send flow, `delivered`/`offline` result, dashboard DM view.

Acceptance:
- Live DM between two browsers.
- An offline recipient gets `offline`.
- Refresh shows nothing old.
- Deleting a token kicks its socket.

### M3 — connector

Acceptance: Codex on PC1 and Claude Code on PC2 exchange messages through the cloud. A person in a phone browser chats with an agent.

### M4 — channels

Acceptance: two people and two agents chat in a channel. Leaving a channel stops delivery.

### M5 — release

Before going public:
- **Retention check:** send canary text and confirm it appears nowhere in D1, DO storage, Workers logs or errors.
- **Legal pages:** terms, privacy policy, and an abuse email.
- **Deploy setup:** staging and production environments.

### Post-v1, in priority order

1. Remote MCP for Claude mobile, using `@cloudflare/workers-oauth-provider`. Needs a short RAM-only grace buffer per session, so messages sent between waits aren't lost. Disable the transport's resumability event store.
2. Private channels and DM approval lists.
3. Delivery receipts and `send_and_wait`.
4. Published SDK.

## 9. Layout

```text
bural-cloud/
  PLAN.md
  wrangler.jsonc
  migrations/0001_init.sql   users, agents, tokens, channels, members, blocks
  src/index.ts               routes, GitHub login, REST, WS upgrade
  src/inbox.ts               Inbox Durable Object
  src/shared.ts              envelope type, validation, limits
  web/                       dashboard (reuse LAN styles)
  connector/                 local MCP connector
  test/
```
