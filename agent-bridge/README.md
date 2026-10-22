# Lock & Scroll agent bridge

Lets AI agents (Grok, Claude, ChatGPT) look things up in Lock & Scroll: what
fits a vehicle, what is in stock, prices and distributor versions, job and
purchase history, tools. It is an [MCP](https://modelcontextprotocol.io)
server running as one Firebase Cloud Function.

**This first version only reads.** Changing stock, prices, jobs, receipts and
staging new keys comes next, through a request queue the app carries out.

## How it fits together

```
Grok / Claude / ChatGPT ──MCP──► agent bridge (Cloud Function) ──reads──► Firestore
                                                                           ▲
Lock & Scroll app ── after each sync, saves what it sees ──────────────────┘
```

- The app is the only thing that knows the full key list (built-in catalog plus
  every override, rename and merge). After each sync it saves one read-only
  snapshot to `users/<uid>/agent/view`, and the bridge answers from that.
  **Agents see the data as of the last sync.**
- Each agent gets its own **access link** (Settings → AI Agents). Only a hash
  of it is stored, in `agentTokens/<hash>`. Revoking deletes it, and the agent
  is locked out within a minute.

## Setup (once)

### 1. Switch Firebase to pay-as-you-go

[Firebase console](https://console.firebase.google.com) → project
**locknscroll** → **Upgrade** (bottom left) → **Blaze**. Cloud Functions need
it. At this use it should cost nothing or pennies (the free allowance covers
2 million function calls a month), but set a **budget alert** (e.g. $5) when
it offers, so a surprise cannot get far.

### 2. Add the cloud rules

Firebase console → **Firestore Database** → **Rules**. Add the two new blocks
from [`tools/firestore.rules`](../tools/firestore.rules), the `match /agent/{docId}`
block inside `match /users/{userId}` and the `match /agentTokens/{tokenHash}`
block, then **Publish**. If your console rules are exactly that file, you can
paste the whole file instead.

### 3. Put the bridge online (Google Cloud Shell, in the browser)

Open [shell.cloud.google.com](https://shell.cloud.google.com), signed in with
the Google account that owns the Firebase project, and paste these one at a
time:

```sh
nvm install 22
git clone https://github.com/Rmarguelles/Lock-Scroll.git
cd Lock-Scroll/agent-bridge/functions
npm ci
cd ..
npx -y firebase-tools@latest login --no-localhost
npx -y firebase-tools@latest deploy --only functions --project locknscroll
```

- `login --no-localhost` prints a link: open it, allow access, and paste the
  code it shows back into the shell.
- The first deploy asks to turn on a few Google Cloud services (Cloud
  Functions, Cloud Build, Artifact Registry, Cloud Run). Say yes. It takes a
  few minutes.
- At the end it prints the function's address. Open it in a browser: it
  should say **Lock & Scroll agent bridge is running.** The address is
  normally `https://us-central1-locknscroll.cloudfunctions.net/agent`, which
  the app already uses.

To update the bridge later: `cd Lock-Scroll && git pull`, then the last three
commands again.

### 4. Make an access link in the app

Lock & Scroll → **Settings → AI Agents**, signed in:

1. Type the agent's name (Grok, Claude, ChatGPT), pick **Read only** or
   **Read + write**, tap **New access link**.
2. **Copy** the link. It is shown once. Make one per agent, so each can be
   revoked on its own.
3. If step 3 printed a different address, open **Server address**, paste it,
   **Save**, and make the link again.

Making the first link also saves the first snapshot, so agents can answer
straight away.

### 5. Connect each agent

Menu names move around; look for "connectors", "MCP" or "custom tools".

- **Claude**: claude.ai → **Settings → Connectors → Add custom connector**.
  Name it Lock & Scroll and paste the link as the URL. Turn it on in a chat
  from the tools menu. Once added on the web it also works in the phone app.
- **ChatGPT** (Plus): **Settings → Apps & Connectors → Advanced → Developer
  mode** on, then **Create** a connector with the link as the MCP server URL
  and **No authentication**. On Plus, custom connectors can only read.
- **Grok**: [grok.com/connectors](https://grok.com/connectors) → **New
  Connector → Custom**, paste the link. In an app built on the xAI API, add
  the link wherever it takes a remote MCP server URL. If it asks for a URL and
  a header separately, use `https://…/agent/mcp` as the URL and
  `Authorization: Bearer lsa_…` (the part of the link after `/mcp/`) as the
  header.

Then ask, for example: *"Using Lock & Scroll, what keys fit a 2019 Ford F-150,
and which do I have in stock?"*

## What an agent can ask

| Tool | Answers |
|---|---|
| `snapshot_info` | When the data was synced, counts, vendors, read or write access |
| `search_keys` | Keys by part number, SKU, FCC ID, FID, OEM number, keyway, chip, type, buttons, vehicle words; a 4-digit word is a year |
| `get_key` | Everything on one key, including each distributor version and its stock |
| `find_keys_for_vehicle` | Keys for a make/model/year, in stock first, with Lishi tool and test keys |
| `get_inventory` | Stock on hand, or what is at or below a count (reorder list) |
| `list_jobs` | Job history with keys used, equipment, amount charged |
| `list_purchases` | Purchases by date, vendor, invoice/order number or part number |
| `list_tools` | Programmers, cables, adapters on file |

## Safety

- **The link is the password.** Anyone with it can use what it allows. Do not
  paste it into a chat you share. If it gets out, revoke it in the app and make
  a new one.
- Google Cloud's request logs record the address, link included. Only owners
  of the Firebase project can see them.
- A read-only link cannot change anything. This version has no write tools at
  all.
- Never commit a link or token to this repository: it is public.

## Troubleshooting

| The agent says | Fix |
|---|---|
| "No data yet" | Open the app, sign in, sync once |
| "not valid or was revoked" | Make a new link in Settings → AI Agents |
| The app says the cloud rules are not in place | Step 2 |
| Old numbers | Agents see the last sync; sync the app |

## Development

```sh
cd agent-bridge/functions
npm ci
npm test          # a real MCP client against the bridge, Firestore faked in memory
```

- `lib/tools.js`: the lookups, pure functions over the snapshot
- `lib/mcp.js`: tool definitions (names, descriptions, input schemas)
- `lib/http.js`: access check and the MCP transport (stateless Streamable HTTP)
- `lib/store.js`: access links and snapshot loading
- The snapshot is built by `buildAgentSnapshot()` in `index.html`; a field an
  agent should see has to be added there first.
