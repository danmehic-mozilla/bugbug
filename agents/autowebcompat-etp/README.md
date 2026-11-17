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

## Target and baseline configurations

Each run tests one **target configuration**:

- **ETP level:** Off, Standard or Strict (default Strict)
- **Filter lists:** EasyList and/or EasyPrivacy, layered on top of the ETP level
  and blocking together with it
- **Private Browsing Mode:** test in a fresh private window

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

## Running it

Inputs come from environment variables: `BUG_ID` or `BUG_DATA`, plus `ETP`
(`off`|`standard`|`strict`), `EASYLIST`, `EASYPRIVACY`, `PRIVATE`, `MODE`
(`investigate`, or `retest` to rerun with the ETP exception list off), `MODEL`,
`EFFORT`, `MAX_TURNS` and `HEADLESS`.

In Docker, the way it ships (Firefox Nightly is downloaded at startup), from the
repo root with secrets in `.env` (see [agents/README.md](../README.md)):

```sh
docker compose -f agents/autowebcompat-etp/compose.yml --env-file .env run --rm \
  -e BUG_ID=2088933 -e ETP=standard -e EASYLIST=true -e PRIVATE=true \
  autowebcompat-etp-agent
```

The easiest way is the local runner UI. It can also run the agent natively
against your own Firefox build (`LOCAL_FIREFOX`), with a cached copy of the
filter lists. See [local_runner/README.md](local_runner/README.md).

## Tests

From the repo root:

```sh
uv run --frozen --package hackbot-agent-autowebcompat-etp --with pytest \
  pytest -q agents/autowebcompat-etp/tests
```

The local runner's tests are listed in its README.
