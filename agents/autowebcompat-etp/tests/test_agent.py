import json
from unittest import mock

import pytest
import requests
from autowebcompat_tools.inputs import BugDataInput, BugIdInput
from autowebcompat_tools.task import RunTracker, TaskConfig
from hackbot_agents.autowebcompat_etp import agent, mcp_servers
from hackbot_agents.autowebcompat_etp.result import (
    PNG_SIGNATURE,
    EtpInvestigationResult,
    EtpListsTargetResult,
    ProposedShim,
)


def make_result(*proposals):
    return EtpInvestigationResult(
        summary="",
        failure_reason=None,
        broken_in_baseline=False,
        broken_in_target=True,
        broken_without_lists=None,
        culprit_prefs=[],
        blocked_resources=[],
        proposed_exceptions=list(proposals),
        exception_verified=True,
        severity="S3",
        priority="P3",
        steps="",
    )


SITE_SCOPED = {
    "category": "baseline",
    "urlPattern": "*://*.licdn.com/*",
    "topLevelUrlPattern": "*://www.example.com/*",
    "classifierFeatures": ["tracking-protection"],
    "rationale": "",
}
GLOBAL = SITE_SCOPED | {"urlPattern": "*://cdn.widget.io/*", "topLevelUrlPattern": None}


def test_exception_records_shape():
    records = agent.exception_records(
        make_result(SITE_SCOPED, GLOBAL), BugIdInput(bug_id=123)
    )

    assert records == [
        {
            "bugIds": ["123"],
            "category": "baseline",
            "urlPattern": "*://*.licdn.com/*",
            "classifierFeatures": ["tracking-protection"],
            "topLevelUrlPattern": "*://www.example.com/*",
        },
        {
            "bugIds": ["123"],
            "category": "baseline",
            "urlPattern": "*://cdn.widget.io/*",
            "classifierFeatures": ["tracking-protection"],
        },
    ]


def test_exception_records_without_bug_id():
    records = agent.exception_records(make_result(GLOBAL), BugDataInput(bug_data="x"))
    assert records[0]["bugIds"] == []


def test_bug_tags():
    social = SITE_SCOPED | {
        "urlPattern": "*://platform.linkedin.com/*",
        "classifierFeatures": ["socialtracking-protection", "tracking-protection"],
    }
    assert agent.bug_tags(make_result(SITE_SCOPED, social)) == (
        ["[privacy-team:diagnosed]", "[exception-baseline]"],
        [
            "trackers-blocked:*.licdn.com,platform.linkedin.com",
            "classifier-features:tracking-protection,socialtracking-protection",
        ],
    )


def test_bug_tags_mixed_categories(caplog):
    convenience = GLOBAL | {"category": "convenience"}
    whiteboard, _ = agent.bug_tags(make_result(SITE_SCOPED, convenience))
    assert whiteboard == [
        "[privacy-team:diagnosed]",
        "[exception-baseline]",
        "[exception-convenience]",
    ]
    assert "mix baseline and convenience" in caplog.text


def test_bug_tags_without_exceptions():
    result = make_result(GLOBAL).model_copy(
        update={"failure_reason": "not_reproducible", "proposed_exceptions": []}
    )
    assert agent.bug_tags(result) == ([], [])


def test_publish_screenshots(tmp_path):
    png = tmp_path / "strict.png"
    png.write_bytes(PNG_SIGNATURE)
    result = make_result(GLOBAL).model_copy(
        update={
            "screenshot_baseline": png,
            "screenshot_target": png,
        }
    )
    publish_file = mock.Mock(side_effect=lambda key, path, _: f"https://x/{key}")

    urls = agent.publish_screenshots(result, publish_file)

    assert urls == {
        "baseline": "https://x/screenshot-baseline.png",
        "target": "https://x/screenshot-target.png",
    }
    publish_file.assert_any_call("screenshot-target.png", png, "image/png")


def test_publish_content_blocking_log(tmp_path):
    path = tmp_path / agent.CONTENT_BLOCKING_LOG_FILE
    publish_file = mock.Mock(side_effect=lambda key, path, _: f"https://x/{key}")

    assert agent.publish_content_blocking_log(path, publish_file) is None
    publish_file.assert_not_called()

    path.write_text('{"strict": []}')
    assert (
        agent.publish_content_blocking_log(path, publish_file)
        == "https://x/content-blocking-log.json"
    )
    publish_file.assert_called_once_with(
        "content-blocking-log.json", path, "application/json"
    )


def test_firefox_devtools_server_passes_log_file(tmp_path, monkeypatch):
    monkeypatch.setattr(mcp_servers, "resolve_bin", lambda name: name)
    log = tmp_path / "log.json"

    assert (
        "ETP_CONTENT_BLOCKING_LOG_FILE"
        not in (mcp_servers.build_firefox_devtools_server(tmp_path)["env"])
    )
    server = mcp_servers.build_firefox_devtools_server(
        tmp_path, content_blocking_log_file=log
    )
    assert server["env"]["ETP_CONTENT_BLOCKING_LOG_FILE"] == str(log)


def test_firefox_devtools_server_passes_filter_list_base_url(tmp_path, monkeypatch):
    monkeypatch.setattr(mcp_servers, "resolve_bin", lambda name: name)
    monkeypatch.delenv("ETP_FILTER_LIST_BASE_URL", raising=False)
    server = mcp_servers.build_firefox_devtools_server(tmp_path)
    assert "ETP_FILTER_LIST_BASE_URL" not in server["env"]

    base_url = "http://127.0.0.1:8000/api/filter-lists"
    monkeypatch.setenv("ETP_FILTER_LIST_BASE_URL", base_url)
    server = mcp_servers.build_firefox_devtools_server(tmp_path)
    assert server["env"]["ETP_FILTER_LIST_BASE_URL"] == base_url


def test_firefox_devtools_server_overrides_exceptions(tmp_path, monkeypatch):
    monkeypatch.setattr(mcp_servers, "resolve_bin", lambda name: name)
    baseline, convenience = mcp_servers.ALLOW_LIST_PREFS.values()

    server = mcp_servers.build_firefox_devtools_server(tmp_path)
    assert not any("allow_list" in arg for arg in server["args"])
    assert not any(name.startswith("ETP_EXCEPTIONS_") for name in server["env"])

    server = mcp_servers.build_firefox_devtools_server(
        tmp_path, exceptions_baseline=False, exceptions_convenience=False
    )
    assert {f"{baseline}=false", f"{convenience}=false"} <= set(server["args"])
    assert server["env"]["ETP_EXCEPTIONS_BASELINE"] == "0"
    assert server["env"]["ETP_EXCEPTIONS_CONVENIENCE"] == "0"

    # Only the overridden category is set.
    server = mcp_servers.build_firefox_devtools_server(
        tmp_path, exceptions_convenience=True
    )
    assert f"{convenience}=true" in server["args"]
    assert not any(arg.startswith(baseline) for arg in server["args"])
    assert server["env"]["ETP_EXCEPTIONS_CONVENIENCE"] == "1"
    assert "ETP_EXCEPTIONS_BASELINE" not in server["env"]


@pytest.fixture
def investigation(tmp_path, monkeypatch):
    """Builds an EtpInvestigation; `build.call_args` has its DevTools server."""
    build = mock.Mock(return_value={})
    monkeypatch.setattr(agent, "build_firefox_devtools_server", build)
    monkeypatch.setattr(agent, "build_exceptions_server", mock.Mock())
    monkeypatch.setattr(agent, "build_tracker_lists_server", mock.Mock())

    def make(**kwargs):
        return agent.EtpInvestigation(
            mock.MagicMock(),
            mock.Mock(),
            tmp_path,
            BugIdInput(bug_id=1),
            {},
            tmp_path,
            **kwargs,
        )

    make.build = build
    return make


def overrides(build):
    kwargs = build.call_args.kwargs
    return kwargs["exceptions_baseline"], kwargs["exceptions_convenience"]


@pytest.mark.parametrize("etp", ["strict", "standard"])
def test_default_exceptions_add_no_note(investigation, etp):
    prompt = investigation(etp=etp).user_prompt()
    assert agent.RETEST_NOTE not in prompt
    assert "allow_list" not in prompt
    assert overrides(investigation.build) == (None, None)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"mode": "retest"},
        {"exceptions_baseline": False},
        # Convenience is moot without baseline.
        {"exceptions_baseline": False, "exceptions_convenience": True},
        {"mode": "retest", "exceptions_baseline": True},
    ],
)
def test_baseline_off_disables_exceptions_and_says_so(investigation, kwargs):
    task = investigation(**kwargs)
    assert agent.RETEST_NOTE in task.user_prompt()
    assert overrides(investigation.build) == (False, False)
    assert task.exceptions == (False, False)


@pytest.mark.parametrize(
    ("etp", "convenience", "exceptions", "applying", "default"),
    [
        (
            "strict",
            True,
            (True, True),
            "both `baseline` and `convenience`",
            "`baseline` only",
        ),
        ("standard", False, (True, False), "only `baseline`", "both"),
    ],
)
def test_convenience_override_says_what_applies(
    investigation, etp, convenience, exceptions, applying, default
):
    task = investigation(etp=etp, exceptions_convenience=convenience)
    prompt = task.user_prompt()
    assert agent.RETEST_NOTE not in prompt
    assert applying in prompt
    assert f"defaults to {default})" in prompt
    assert "`set_etp_mode` keeps it that way" in prompt
    assert overrides(investigation.build) == (None, convenience)
    assert task.exceptions == exceptions


@pytest.mark.parametrize(
    ("etp", "convenience"), [("strict", False), ("standard", True), ("off", True)]
)
def test_override_matching_the_default_is_dropped(investigation, etp, convenience):
    task = investigation(
        etp=etp, exceptions_baseline=True, exceptions_convenience=convenience
    )
    assert "allow_list" not in task.user_prompt()
    assert overrides(investigation.build) == (None, None)
    assert task.exceptions == (True, etp != "strict")


def test_agent_inputs_read_exception_overrides(monkeypatch):
    from hackbot_agents.autowebcompat_etp.__main__ import AgentInputs

    monkeypatch.setenv("BROKER_URL", "http://broker")
    inputs = AgentInputs()
    assert inputs.exceptions_baseline is None
    assert inputs.exceptions_convenience is None

    monkeypatch.setenv("EXCEPTIONS_BASELINE", "true")
    monkeypatch.setenv("EXCEPTIONS_CONVENIENCE", "false")
    monkeypatch.setenv("MODE", "retest")
    inputs = AgentInputs()
    assert inputs.exceptions_baseline is True
    assert inputs.exceptions_convenience is False
    assert inputs.mode == "retest"


def test_final_result_keeps_counts_without_paths(tmp_path):
    png = tmp_path / "strict.png"
    png.write_bytes(PNG_SIGNATURE)
    result = EtpInvestigationResult.model_validate(
        make_result(GLOBAL).model_dump()
        | {"screenshot_target": png, "blocked_trackers": {"target": 38}}
    )

    # As run_autowebcompat_etp builds it, with the paths replaced by URLs.
    final = agent.AutowebcompatEtpResult(
        **result.model_dump(exclude=set(agent.SCREENSHOT_FIELDS.values())),
        exception_records=[],
        whiteboard_tags=[],
        user_story_lines=[],
        existing_exceptions=None,
        existing_shims=None,
        screenshot_urls={"target": "https://x/screenshot-target.png"},
    )

    assert final.blocked_trackers.target == 38


SHIMS_JS = """
const AVAILABLE_SHIMS = [
  {
    id: "InstagramEmbed",
    name: "Instagram embed placeholder",
    bug: "1892173",
    matches: ["https://www.instagram.com/embed.js"],
    unblocksOnOptIn: [
      "*://www.instagram.com/*",
      "*://*.fbcdn.net/*", // covers:
      // "*://scontent.cdninstagram.com/*",
    ],
  },
  {
    id: "AdNexusAST",
    name: "AdNexus AST",
    bug: "1734130",
    matches: ["*://*.adnxs.com/*/ast.js*"],
  },
];
"""


def test_parse_shims():
    shims = agent.parse_shims(SHIMS_JS)

    assert [shim["id"] for shim in shims] == ["InstagramEmbed", "AdNexusAST"]
    assert shims[0] == {
        "id": "InstagramEmbed",
        "name": "Instagram embed placeholder",
        "bug": "1892173",
        # The commented-out pattern is not picked up.
        "patterns": [
            "https://www.instagram.com/embed.js",
            "*://www.instagram.com/*",
            "*://*.fbcdn.net/*",
        ],
    }


def make_shim(**overrides):
    return ProposedShim.model_validate(
        {
            "kind": "opt_in_placeholder",
            "name": "Instagram embed placeholder",
            "matches": ["https://www.instagram.com/embed.js"],
            "unblocksOnOptIn": ["*://www.instagram.com/*"],
            "behavior": "",
            "existing_shim_id": "InstagramEmbed",
            "rationale": "",
        }
        | overrides
    )


def _find_shims(shim):
    response = mock.Mock(text=SHIMS_JS)
    with mock.patch.object(agent.requests, "get", return_value=response):
        return agent.find_existing_shims(shim)


def test_finds_existing_shim_by_host():
    assert _find_shims(make_shim()) == [
        {
            "id": "InstagramEmbed",
            "name": "Instagram embed placeholder",
            "bug": "1892173",
            "patterns": [
                "https://www.instagram.com/embed.js",
                "*://www.instagram.com/*",
            ],
        }
    ]


def test_new_provider_has_no_existing_shim():
    shim = make_shim(
        matches=["*://platform.linkedin.com/in.js*"],
        unblocksOnOptIn=["*://www.linkedin.com/*"],
        existing_shim_id=None,
    )
    assert _find_shims(shim) == []


def test_warns_when_agent_missed_an_existing_shim(caplog):
    _find_shims(make_shim(existing_shim_id=None))
    assert "InstagramEmbed already cover" in caplog.text


def test_no_shim_skips_the_fetch():
    with mock.patch.object(agent.requests, "get") as get:
        assert agent.find_existing_shims(None) == []
    get.assert_not_called()


def test_shims_fetch_failure_returns_none():
    with mock.patch.object(
        agent.requests, "get", side_effect=requests.ConnectionError()
    ):
        assert agent.find_existing_shims(make_shim()) is None


def make_investigation(tmp_path, etp, filter_lists=(), private=False):
    with mock.patch.object(agent, "build_firefox_devtools_server"):
        return agent.EtpInvestigation(
            TaskConfig(),
            RunTracker(),
            tmp_path / "firefox",
            BugIdInput(bug_id=1),
            {"type": "http", "url": "http://broker/mcp"},
            tmp_path,
            etp=etp,
            filter_lists=filter_lists,
            private=private,
        )


def test_user_prompt_strict_target_has_standard_baseline(tmp_path):
    prompt = make_investigation(tmp_path, "strict").user_prompt()
    assert (
        'Target configuration: Strict ETP. Call `set_etp_mode` with {"etp": "strict"}.'
        in prompt
    )
    assert (
        'Baseline configuration: Standard ETP. Call `set_etp_mode` with {"etp": "standard"}.'
        in prompt
    )
    assert "control run" not in prompt
    for stage in ("baseline", "target", "fixed"):
        assert str(tmp_path / f"{stage}.png") in prompt


def test_user_prompt_layers_filter_lists_with_off_baseline(tmp_path):
    prompt = make_investigation(
        tmp_path, "standard", ("easylist", "easyprivacy")
    ).user_prompt()
    assert (
        "Target configuration: Standard ETP + EasyList + EasyPrivacy. Call "
        '`set_etp_mode` with {"etp": "standard", "filter_lists": ["easylist", '
        '"easyprivacy"]}.'
    ) in prompt
    assert (
        'Baseline configuration: ETP off. Call `set_etp_mode` with {"etp": "off"}.'
        in prompt
    )


def test_user_prompt_off_without_lists_is_a_control_run(tmp_path):
    assert "control run" in make_investigation(tmp_path, "off").user_prompt()
    assert (
        "control run"
        not in make_investigation(tmp_path, "off", ("easylist",)).user_prompt()
    )


def test_firefox_devtools_server_private(tmp_path, monkeypatch):
    monkeypatch.setattr(mcp_servers, "resolve_bin", lambda name: name)
    server = mcp_servers.build_firefox_devtools_server(tmp_path)
    assert "ETP_PRIVATE" not in server["env"]
    server = mcp_servers.build_firefox_devtools_server(tmp_path, private=True)
    assert server["env"]["ETP_PRIVATE"] == "1"


def test_private_run_prompts(tmp_path):
    normal = make_investigation(tmp_path, "standard")
    assert agent.PRIVATE_NOTE not in normal.user_prompt()
    assert "normal (not private) window" in normal.user_prompt()
    system = normal.system_prompt()
    assert agent.PRIVATE_BROWSING_MARKER not in system
    assert agent.PRIVATE_BROWSING_NORMAL in system

    private = make_investigation(tmp_path, "standard", private=True)
    assert agent.PRIVATE_NOTE in private.user_prompt()
    system = private.system_prompt()
    assert agent.PRIVATE_BROWSING_MARKER not in system
    assert agent.PRIVATE_BROWSING_NORMAL not in system
    assert agent.PRIVATE_BROWSING_PRIVATE in system


def test_result_class_follows_the_target_lists(tmp_path):
    assert make_investigation(tmp_path, "strict").result_cls is EtpInvestigationResult
    investigation = make_investigation(tmp_path, "strict", ("easylist",))
    assert investigation.result_cls is EtpListsTargetResult
    assert investigation.result_collector.result_cls is EtpListsTargetResult


def test_read_filter_list_versions(tmp_path):
    path = tmp_path / "log.json"
    assert agent.read_filter_list_versions(path, ("easylist",)) is None
    path.write_text(
        json.dumps(
            {
                "strict+easylist": [],
                "filterListVersions": {
                    "easylist": "202611171704",
                    "easyprivacy": None,
                },
            }
        )
    )
    assert agent.read_filter_list_versions(path, ()) is None
    assert agent.read_filter_list_versions(path, ("easylist", "easyprivacy")) == {
        "easylist": "202611171704"
    }
    assert agent.read_filter_list_versions(path, ("easyprivacy",)) is None
    path.write_text("[]")
    assert agent.read_filter_list_versions(path, ("easylist",)) is None


def test_final_result_skips_list_check(tmp_path):
    result = EtpListsTargetResult.model_validate(
        make_result(GLOBAL).model_dump() | {"broken_without_lists": True}
    )
    final = agent.AutowebcompatEtpResult(
        **result.model_dump(exclude=set(agent.SCREENSHOT_FIELDS.values())),
        exception_records=[],
        whiteboard_tags=[],
        user_story_lines=[],
        existing_exceptions=None,
        existing_shims=None,
        screenshot_urls={},
        filter_lists=["easylist"],
        private=True,
        filter_list_versions={"easylist": "202611171704"},
    )
    assert final.broken_without_lists is True
    assert final.private is True


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        ({}, (True, False)),
        ({"exceptions_convenience": True}, (True, True)),
        ({"mode": "retest"}, (False, False)),
    ],
)
def test_run_records_effective_exceptions(tmp_path, monkeypatch, kwargs, expected):
    import asyncio

    monkeypatch.setattr(agent, "Environment", mock.MagicMock())
    monkeypatch.setattr(agent, "firefox_binary", lambda: tmp_path)
    monkeypatch.setattr(agent, "build_firefox_devtools_server", mock.Mock())
    monkeypatch.setattr(agent, "build_exceptions_server", mock.Mock())
    monkeypatch.setattr(agent, "build_tracker_lists_server", mock.Mock())
    monkeypatch.setattr(agent, "find_existing_exceptions", lambda records: [])
    monkeypatch.setattr(
        agent.EtpInvestigation, "run", mock.AsyncMock(return_value=make_result(GLOBAL))
    )

    final = asyncio.run(
        agent.run_autowebcompat_etp(
            TaskConfig(headless=True),
            RunTracker(),
            BugIdInput(bug_id=1),
            {},
            mock.Mock(),
            etp="strict",
            **kwargs,
        )
    )
    assert (final.exceptions_baseline, final.exceptions_convenience) == expected
