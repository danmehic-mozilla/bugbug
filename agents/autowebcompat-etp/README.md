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
  - **[Docker Desktop](https://www.docker.com/products/docker-desktop/)**: runs
    download a fresh Firefox Nightly inside a container. Use this if you don't
    build Firefox yourself.
  - **Your own Firefox build**: see step 5b.

Check them:

```sh
git --version && uv --version && node --version && pnpm --version
docker compose version   # only for Docker runs
```

### 2. Get the code

```sh
git clone https://github.com/danmehic-mozilla/bugbug.git
cd bugbug
git checkout autowebcompat-etp-agent
```

### 3. Add your keys

Create a file named `.env` in the repo root (the `bugbug` directory). Never
commit it.

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

Start Docker Desktop, then:

```sh
uv run --locked agents/autowebcompat-etp/local_runner/server.py
```

Open <http://127.0.0.1:8000>. The first run builds the agent's Docker image,
which takes a few minutes once. After you pull changes to the agent, tick
**Rebuild image first** on the next run.

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
- **"... missing (.env not found)" in the UI:** the `.env` file isn't in the
  repo root, or a key is empty.
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
