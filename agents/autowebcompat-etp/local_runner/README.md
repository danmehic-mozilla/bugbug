# autowebcompat-etp local runner

A small web UI for running the autowebcompat-etp agent on your machine and
reviewing its results. It starts the agent through the agent's `compose.yml`
(the same way it ships), streams the agent's output to the browser, and when
the run finishes shows the result next to a draft of the Bugzilla changes.
After you have edited and approved the draft, the changes are posted with your
own Bugzilla API key.

## Prerequisites

- Docker with `docker compose`
- [uv](https://docs.astral.sh/uv/) (the server is a PEP 723 script and needs
  Python 3.14 or newer, which uv installs for you)
- [pnpm](https://pnpm.io/), to build the UI

## Configuration

The server reads secrets from the `.env` file in the repo root (see
[agents/README.md](../../README.md#running-an-agent-locally)):

```dotenv
ANTHROPIC_API_KEY=sk-ant-...
BUGZILLA_API_URL=https://bugzilla.mozilla.org/rest
BUGZILLA_API_KEY=...
```

`ANTHROPIC_API_KEY` is used by the agent. `BUGZILLA_API_KEY` is used by the
broker and to apply the reviewed changes.

You can also set these optional environment variables:

| Variable            | Default               | Purpose                                  |
| ------------------- | --------------------- | ---------------------------------------- |
| `HOST`              | `127.0.0.1`           | Address the server listens on            |
| `PORT`              | `8000`                | Port the server listens on               |
| `MAX_PARALLEL`      | `1`                   | How many agent runs can execute at once  |
| `HACKBOT_ARTIFACTS` | `~/hackbot/artifacts` | Where the server looks for run artifacts |

`compose.yml` always mounts `~/hackbot/artifacts` into the agent container. If
you change `HACKBOT_ARTIFACTS`, the server will look somewhere the agent does
not write to.

## Starting it

Run these from the repo root:

```sh
pnpm --dir agents/autowebcompat-etp/local_runner/web install --frozen-lockfile
pnpm --dir agents/autowebcompat-etp/local_runner/web build
uv run --locked agents/autowebcompat-etp/local_runner/server.py
```

Then open <http://127.0.0.1:8000>. The server serves the built UI from
`web/dist`, so you have to rebuild it after you pull changes to the UI.

## Running with a local Firefox build

Docker runs download a fresh Nightly in a Linux container. To test a Firefox you
built yourself (on macOS, say), start the server with `LOCAL_FIREFOX` set to the
build's binary. The form then offers *Run in: Local build / Docker* per run;
local runs start the agent and the Bugzilla broker on this machine instead.

Install the patched DevTools MCP into the agent directory once (and again after
`mcp/etp-tools.js` changes):

```sh
cd agents/autowebcompat-etp
npm ci --omit=dev
node mcp/patch-mcp.mjs node_modules/@mozilla/firefox-devtools-mcp-moz
```

Then, from the repo root:

```sh
LOCAL_FIREFOX=/path/to/obj-dir/dist/Nightly.app/Contents/MacOS/firefox \
  uv run --locked agents/autowebcompat-etp/local_runner/server.py
```

The build must match its source tree: an objdir whose checkout has moved on
since it was built can crash at startup. An artifact build in its own worktree
avoids that. Local runs ignore the system proxy, and on macOS Firefox gets a
separate home under `~/hackbot/firefox-home`. Without Xvfb, a run that isn't
headless opens a real Firefox window. `BROKER_PORT` (default 8765) sets the
broker's port.

## Working on the UI

Keep the server running, and start the Vite dev server in a second terminal:

```sh
pnpm --dir agents/autowebcompat-etp/local_runner/web dev
```

Open the URL that Vite prints. Vite reloads the page when you save a change
and proxies `/api` to the server at `http://127.0.0.1:8000`. If the server
runs somewhere else, set `API_URL` for the dev server.
