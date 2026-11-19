# autowebcompat-etp

A Claude agent that investigates web-compatibility reports where Firefox's
Enhanced Tracking Protection (ETP) may break a site. It drives a real Firefox
through the Firefox DevTools MCP server and reproduces the report. It then finds
the blocked resources responsible and proposes a fix: an entry for the ETP
exception list (`url-classifier-exceptions` in Remote Settings) or a SmartBlock
shim.

- `hackbot_agents/autowebcompat_etp/`: the agent (prompt, result schema, harness)
- `mcp/`: the ETP tools added to the DevTools MCP server (`set_etp_mode`,
  `get_content_blocking_log`, ...)
- `local_runner/`: a web UI to start runs, compare them and post the results to
  Bugzilla. See [local_runner/README.md](local_runner/README.md).
- `tests/`: agent tests

## Setting up with a coding agent

The Quick start below can be done by a coding agent such as Claude Code, except
for the secrets and the browser steps. An agent should follow these steps in
order, and stop and tell the user at the first one that fails, quoting the
error:

1. **Tools (step 1).** Run the checks in step 1. If a tool is missing, list
   the missing ones and ask before installing anything. If `docker info`
   fails, ask the user to start Docker Desktop or run `colima start --memory
   8`. Don't start it unasked.
   With no Docker, runs need a Firefox the user built (step 5b). Ask for the
   path to its `firefox` binary. If there is neither, stop: the runner can't
   run anything.
2. **Code (step 2).** If the current directory is already a clone of this
   repo (it has `agents/autowebcompat-etp`), use it and don't clone again.
3. **UI (step 4).** Build it, and check that
   `agents/autowebcompat-etp/local_runner/web/dist/index.html` exists.
4. **Keys (step 3).** Ask the user to create `.env` in the repo root
   themselves, then wait until they say it's done. Check only that it exists
   (`test -f .env`). Never create, read, print or log `.env`, and never ask
   for the keys in the chat.
5. **Image (Docker only).** Build the agent's image now, so the user's first
   run doesn't fail on it:

   ```sh
   docker compose -f agents/autowebcompat-etp/compose.yml --env-file .env build
   ```

   It takes a few minutes the first time. Redirect the output to a log file
   outside the repo and read only its last lines. For local-build runs, do
   the `npm ci` and patch commands from step 5b instead.
6. **Server (step 5a or 5b).** Start it in the background, with its output
   redirected to a log file outside the repo, e.g.
   `~/hackbot/local-runner.log`. Don't run it in the foreground.
7. **Check.** Within a few seconds the log shows either `Setup check
   passed.` or `WARNING:` lines, each naming the step to redo. Then run
   `curl -s http://127.0.0.1:8000/api/config`. `setup_problems` should be
   `[]`, and `has_anthropic_key` and `has_bugzilla_key` both `true`. Report
   only those fields and any `WARNING:` lines. If the port is in use, see
   Troubleshooting.
8. **Hand over.** Tell the user to open <http://127.0.0.1:8000>, and where the
   server's log is. A server started by a coding agent can stop when the
   agent's session ends. Give the user the command from step 5a (or 5b) to
   run in their own terminal if the page stops responding. Steps 6 and 7
   (running a bug, reviewing and posting to Bugzilla) are for the user. Never
   post to Bugzilla or start a run unasked, because each run costs money.

## Quick start

These steps take you from nothing to a finished run in the local runner UI. Run
every command from the repo root unless a step says otherwise.

### 1. Install the tools

- **git**
- **[uv](https://docs.astral.sh/uv/getting-started/installation/)**, which runs
  the Python code and installs the Python version it needs (3.14)
- **[Node.js](https://nodejs.org/) 20 or newer** and
  **[pnpm](https://pnpm.io/installation)**, to build the UI
- One way to run Firefox:
  - **Docker**: runs download a fresh Firefox Nightly inside a container. Use
    this if you don't build Firefox yourself. Any engine works:
    [Docker Desktop](https://www.docker.com/products/docker-desktop/), or
    [Colima](https://github.com/abiosoft/colima) (`brew install colima docker
    docker-compose`).
  - **Your own Firefox build**: see step 5b.

On macOS with [Homebrew](https://brew.sh/), one command installs everything
except Docker Desktop:

```sh
brew install git uv node pnpm colima docker docker-compose
```

Check them:

```sh
git --version && uv --version && node --version && pnpm --version
docker info > /dev/null && echo "docker engine running"   # only for Docker runs
```

`docker info` fails if no engine is running (see step 5a). `docker compose
version` alone passes even then, so it isn't a check.

### 2. Get the code

```sh
git clone https://github.com/danmehic-mozilla/bugbug.git
cd bugbug
```

The agent is on the default branch, so there is nothing to check out.

### 3. Add your keys

Create a file named `.env` in the repo root (the `bugbug` directory). Never
commit it. You create and fill this file yourself. If a coding agent is helping
you, it must not write, read or print it, and you must not paste the keys into
the chat.

```dotenv
ANTHROPIC_API_KEY=sk-ant-...
BUGZILLA_API_URL=https://bugzilla.mozilla.org/rest
BUGZILLA_API_KEY=...
```

- `ANTHROPIC_API_KEY`: from the [Claude Console](https://console.anthropic.com/)
  under API keys. Every run uses it and costs money, typically $0.20 to $0.60
  per run.
- `BUGZILLA_API_KEY`: from Bugzilla under Preferences → API Keys. The agent
  only reads bugs. Nothing is posted until you approve it in the UI (step 7).

### 4. Build the UI

```sh
pnpm --dir agents/autowebcompat-etp/local_runner/web install --frozen-lockfile
pnpm --dir agents/autowebcompat-etp/local_runner/web build
```

Run the build again whenever you pull changes to the UI.

### 5a. Start the runner with Docker

Start the Docker engine first: open Docker Desktop, or with Colima run
`colima start` (the default 2 GB of memory is tight for the image build, so
`colima start --memory 8` is safer). Then:

```sh
uv run --locked agents/autowebcompat-etp/local_runner/server.py
```

If a run fails with "failed to connect to the docker API", the engine isn't
running. If the image build dies with `error reading from server: EOF`, the VM
was still starting or ran out of memory. Wait, or `colima restart`, and run
again.

At startup the server checks the steps above and prints `Setup check passed.`,
or a `WARNING:` line for each problem it finds (the UI isn't built, `.env` or a
key is missing, the Docker engine isn't running). The same problems show in
red in the UI's sidebar.

Open <http://127.0.0.1:8000>. Unless you built the image beforehand (`docker
compose -f agents/autowebcompat-etp/compose.yml --env-file .env build`), the
first run builds the agent's Docker image, which takes a few minutes once.
After you pull changes to the agent, tick **Rebuild image first** on the next
run.

The server stays in the foreground until you stop it. To check that it is up
and sees your keys, run this in another terminal. `setup_problems` should be
`[]`, and both `has_*` fields `true`:

```sh
curl -s http://127.0.0.1:8000/api/config
```

When a run fails on a setup problem (the Docker engine stopped, the image
build failed, Firefox didn't start), the end of its log says so in a
`[runner] ERROR:` line with what to do.

### 5b. Or start it with your own Firefox build

Install the patched DevTools MCP into the agent directory. Do it once, and
again after `mcp/etp-tools.js` changes:

```sh
cd agents/autowebcompat-etp
npm ci --omit=dev
node mcp/patch-mcp.mjs node_modules/@mozilla/firefox-devtools-mcp-moz
cd ../..
```

Start the runner with `LOCAL_FIREFOX` set to your build's `firefox` binary:

```sh
# macOS
LOCAL_FIREFOX=/path/to/obj-dir/dist/Nightly.app/Contents/MacOS/firefox \
  uv run --locked agents/autowebcompat-etp/local_runner/server.py
# Linux
LOCAL_FIREFOX=/path/to/obj-dir/dist/bin/firefox \
  uv run --locked agents/autowebcompat-etp/local_runner/server.py
```

At startup the server also checks that `LOCAL_FIREFOX` is an executable file
and that the DevTools MCP is installed and patched, and prints a `WARNING:`
line if not.

Open <http://127.0.0.1:8000>. Under **Run in**, choose **Local build**, or
**Docker** if Docker is also running.

The build must match its source checkout. If you've updated the checkout since
you built it, rebuild, or Firefox may crash at startup. If you don't need your
own C++ changes, an artifact build (`ac_add_options --enable-artifact-builds` in
your mozconfig) takes about two minutes.

### 6. Run a bug

1. Enter a Bugzilla bug ID, e.g. a report from Web Compatibility → Privacy:
   Site Reports.
2. Under **Config**, pick the target configuration:

   - the ETP level (Off, Standard or Strict);
   - optionally EasyList and/or EasyPrivacy;
   - optionally Private Browsing Mode;
   - which ETP exceptions apply.

   The line below shows the baseline it compares against.

3. Leave Model, Effort and Max turns empty for the defaults. Tick **Headless
   Firefox** unless you want to watch the browser.
4. Click **Start run**. The log streams live, and a run usually takes 2 to 10
   minutes.

When it finishes, the result shows:

- whether the site broke in the baseline and the target;
- what was blocked;
- screenshots;
- the proposed fix.

**Compare all runs of bug N** puts every run of that bug side by side, which
helps when you run one bug in several configurations.

### 7. Review and post (optional)

Under **Bugzilla actions**, edit the drafted comment and fields: whiteboard
tags, an optional close or needinfo. Then post them with your Bugzilla key.
Nothing is posted until you do.

### 8. Stop

Press Ctrl+C in the terminal running the server. That also stops the Bugzilla
broker it started for local runs.

### Troubleshooting

- **The port is in use:** start the server on another port, e.g.
  `PORT=8010 uv run --locked agents/autowebcompat-etp/local_runner/server.py`,
  and open that port.
- **"No .env file at ..." or "... is not set" in the UI or the server's
  output:** the `.env` file isn't in the repo root, or a key is empty. Restart
  the server after fixing it.
- **A local-build run fails at once with "Process unexpectedly closed":**
  Firefox didn't start. Run the binary by hand to see why. It's usually a build
  that no longer matches its checkout.
- **Sites never load in a local-build run:** local runs already bypass the
  system proxy. Check that the machine itself can reach the site.
- **Docker runs that use EasyList/EasyPrivacy fail to load the lists on Linux:**
  they reach the runner at `host.docker.internal`, which Docker Desktop
  provides and plain Linux Docker doesn't.

## Target and baseline configurations

Each run tests one **target configuration**:

- **ETP level:** Off, Standard or Strict (default Strict)
- **Filter lists:** EasyList and/or EasyPrivacy, layered on top of the ETP level
  and blocking together with it
- **Private Browsing Mode:** test in a fresh private window
- **ETP exceptions:** whether the baseline and convenience categories of the
  ETP exception list apply (default: Firefox's for the ETP level). Convenience
  needs baseline.

The agent compares the target with a **baseline** where the site should work:
ETP Standard for a Strict target, otherwise ETP Off without lists, in the same
kind of window. Off with no lists is a control run: the agent loads the page,
follows the steps and reports whether it works, with no fix.

When a target with lists breaks, the agent retests at the same ETP level without
the lists. If the lists alone cause it, no ETP exception can help. The agent then
reports `not_fixable_by_exception` instead of proposing one.

## Result

The agent submits an `EtpInvestigationResult` (`result.py`). The main fields:

- `broken_in_baseline`, `broken_in_target`, `broken_without_lists`
- `failure_reason`: null when a verified fix is proposed. Otherwise one of
  `not_etp`, `not_reproducible`, `fixed_by_list_update`, `broken_in_baseline`,
  `not_fixable_by_exception`, `exception_not_verified`, `anti_adblock`,
  `blocked*`, `login`, `down`, `other`.
- `proposed_exceptions` / `proposed_shim`
- `blocked_trackers` and screenshots for the baseline, target and fixed stages
- `filter_list_versions`: the EasyList/EasyPrivacy versions that were loaded

## Running the agent without the UI

Inputs come from environment variables: `BUG_ID` or `BUG_DATA`, plus `ETP`
(`off`|`standard`|`strict`), `EASYLIST`, `EASYPRIVACY`, `PRIVATE`,
`EXCEPTIONS_BASELINE` and `EXCEPTIONS_CONVENIENCE` (`true`/`false`: whether that
category of the ETP exception list applies in every mode; unset keeps the ETP
level's default, Strict: baseline only, Standard and Off: both), `MODE`
(`investigate`, or `retest` to rerun with the ETP exception list off, the same
as `EXCEPTIONS_BASELINE=false`), `MODEL`, `EFFORT`, `MAX_TURNS` and `HEADLESS`.

Before the agent starts, the run loads the bug's URL field (or the first URL in
`BUG_DATA`) once in Firefox. If Firefox shows its own error page for it (a
certificate error, DNS or connection failure, blocked site), the run stops
there, at no model cost, with `failure_reason` `down` (the site can't be
reached) or `other`, and a `[preflight]` line in the output says why.
`PREFLIGHT=false` skips this check.

In Docker, from the repo root with the `.env` from step 3:

```sh
docker compose -f agents/autowebcompat-etp/compose.yml --env-file .env run --rm \
  -e BUG_ID=2088933 -e ETP=standard -e EASYLIST=true -e PRIVATE=true \
  autowebcompat-etp-agent
```

Results go to `~/hackbot/artifacts/<run id>/`.

## Tests

From the repo root:

```sh
uv run --frozen --package hackbot-agent-autowebcompat-etp --with pytest \
  pytest -q agents/autowebcompat-etp/tests
```

The local runner's tests are listed in its README.

`tests/test_smoke.py` checks the patched DevTools MCP server against the real
npm package and a real Firefox. It needs the network and a few minutes, so it
only runs when asked for:

```sh
# Install the pinned package and apply mcp/patch-mcp.mjs (needs node and npm).
ETP_SMOKE=1 uv run --frozen --package hackbot-agent-autowebcompat-etp \
  --with pytest pytest -q agents/autowebcompat-etp/tests/test_smoke.py
# Also drive a Firefox Nightly through the ETP tools.
ETP_SMOKE=1 ETP_SMOKE_FIREFOX=/path/to/firefox uv run --frozen \
  --package hackbot-agent-autowebcompat-etp --with pytest \
  pytest -q agents/autowebcompat-etp/tests/test_smoke.py
```

Run it after changing `mcp/etp-tools.js` or bumping the package version.
