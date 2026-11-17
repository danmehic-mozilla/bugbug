"""Firefox ETP web-compatibility agent.

Drives an agent that checks whether a broken-site report is caused by
Enhanced Tracking Protection's Strict mode and, if a classifier list blocks a
resource the site needs, proposes entries for the `url-classifier-exceptions`
Remote Settings collection. The bug is passed either inline as ``bug_data``
text or a Bugzilla ``bug_id`` (read via Bugzilla broker).
"""

import json
import logging
import re
import sys
import tempfile
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, Literal, get_args

import json5
import requests
from autowebcompat_tools.environment import Environment
from autowebcompat_tools.inputs import AutoWebcompatInput, BugDataInput, BugIdInput
from autowebcompat_tools.task import RunTracker, Task, TaskConfig
from claude_agent_sdk import McpServerConfig
from pydantic import model_validator

from .browser import firefox_binary
from .config import BUGZILLA_READ_TOOLS, DEVTOOLS_TOOLS, PRIVILEGED_TOOLS
from .exceptions import (
    EXCEPTIONS_SERVER_NAME,
    FIND_EXCEPTIONS_TOOL,
    build_exceptions_server,
    find_existing_exceptions,
    hosts_overlap,
    pattern_host,
)
from .mcp_servers import build_firefox_devtools_server
from .result import (
    RESULT_SERVER_NAME,
    ClassifierFeature,
    EtpInvestigationResult,
    EtpListsTargetResult,
    ProposedShim,
)
from .tracker_lists import (
    CHECK_TRACKER_LISTS_TOOL,
    TRACKER_LISTS_SERVER_NAME,
    build_tracker_lists_server,
)

HERE = Path(__file__).resolve().parent

logger = logging.getLogger("autowebcompat-etp")

SHIMS_URL = (
    "https://raw.githubusercontent.com/mozilla-firefox/firefox/main/"
    "browser/extensions/webcompat/data/shims.js"
)

PublishFile = Callable[[str, Path, str | None], str]

# How the harness runs the agent: `investigate` a new report, or `retest` an old
# one with Firefox's ETP exception list turned off, to see whether the site
# still breaks without the exceptions it may already have. `retest` is the same
# as turning the baseline exceptions off.
Mode = Literal["investigate", "retest"]

# The configuration the agent investigates (the target): an ETP category plus
# any filter lists, all blocking at once. Its baseline is Standard for a Strict
# target, else ETP off with no lists.
EtpLevel = Literal["off", "standard", "strict"]
FilterList = Literal["easylist", "easyprivacy"]
FILTER_LISTS: tuple[FilterList, ...] = ("easylist", "easyprivacy")
FILTER_LIST_NAMES = {"easylist": "EasyList", "easyprivacy": "EasyPrivacy"}
ETP_NAMES = {"off": "ETP off", "standard": "Standard ETP", "strict": "Strict ETP"}


def baseline_etp(etp: EtpLevel) -> EtpLevel:
    return "standard" if etp == "strict" else "off"


def default_exceptions(etp: EtpLevel) -> tuple[bool, bool]:
    """Whether the baseline and convenience exceptions apply by default.

    Strict turns convenience off (ContentBlockingPrefs); Standard and Off leave
    both allow_list prefs at their default, on.
    """
    return True, etp != "strict"


def exception_overrides(
    etp: EtpLevel,
    baseline: bool | None = None,
    convenience: bool | None = None,
    mode: Mode = "investigate",
) -> tuple[bool | None, bool | None]:
    """The allow_list overrides for a run, None where the ETP level's default stays.

    `retest` turns baseline off. With baseline off, convenience is set off too:
    Firefox ignores it then, and the pref says what applies. An override equal
    to the target level's default is dropped, so it doesn't leak into the
    baseline configuration.
    """
    if mode == "retest" or baseline is False:
        return False, False
    if convenience == default_exceptions(etp)[1]:
        convenience = None
    return None, convenience


def effective_exceptions(
    etp: EtpLevel, baseline: bool | None, convenience: bool | None
) -> tuple[bool, bool]:
    """Whether the baseline and convenience exceptions apply in the target."""
    default_baseline, default_convenience = default_exceptions(etp)
    applies = default_baseline if baseline is None else baseline
    return applies, applies and (
        default_convenience if convenience is None else convenience
    )


def describe_config(etp: EtpLevel, filter_lists: Sequence[FilterList] = ()) -> str:
    """E.g. "Strict ETP + EasyList + EasyPrivacy"."""
    return " + ".join(
        [ETP_NAMES[etp], *(FILTER_LIST_NAMES[name] for name in filter_lists)]
    )


def set_etp_mode_args(etp: EtpLevel, filter_lists: Sequence[FilterList] = ()) -> str:
    args: dict[str, Any] = {"etp": etp}
    if filter_lists:
        args["filter_lists"] = list(filter_lists)
    return json.dumps(args)


CONTROL_NOTE = """This is a control run: the target blocks nothing. Load the page in the target
configuration, follow the steps, take the target screenshot and read the
content blocking log, then submit: `not_reproducible` if the site works,
`not_etp` if it breaks (with nothing blocked, blocking can't cause it). Leave
the baseline fields null and propose no fix."""

RETEST_NOTE = """\
This is a retest of an older report. In this Firefox, the ETP exception list is
disabled in every mode (`set_etp_mode` keeps it off; don't change the
`privacy.trackingprotection.allow_list.*` prefs): neither `baseline` nor
`convenience` entries apply, while the skip-URL prefs still work for testing.
Follow your task procedure as usual. `find_etp_exceptions` still shows the live
list, so in the summary name the existing entries for this bug or site, and say
whether the breakage still happens without them (they are still needed) or not
(the site no longer needs them). In step 3, an existing exception cannot explain
a site that works here."""

EXCEPTIONS_NOTE = """\
In this Firefox, {applying} in every mode ({level} defaults to {default}).
`set_etp_mode` keeps it that way, so don't change the
`privacy.trackingprotection.allow_list.*` prefs. The skip-URL prefs still work
for testing. An existing exception in a category that applies here can explain
a site that works; one in a category that doesn't apply can't."""
EXCEPTIONS_APPLYING = {
    (True, True): "both `baseline` and `convenience` ETP exception entries apply",
    (True, False): "only `baseline` ETP exception entries apply (not `convenience`)",
}
DEFAULT_EXCEPTIONS_NAMES = {(True, True): "both", (True, False): "`baseline` only"}

PRIVATE_NOTE = """\
This is a Private Browsing run: test the baseline and the target in a private
window. Every `set_etp_mode` call closes the private window and opens a fresh
one, whose tab becomes the selected page; load the URL there with
`navigate_page` and don't select another page. `get_content_blocking_log` says
"(private window)" when it reads that tab."""

# Where the system prompt says how to test Private Browsing reports.
PRIVATE_BROWSING_MARKER = "<!-- private-browsing -->"
PRIVATE_BROWSING_NORMAL = """\
Private Browsing windows block trackers even in Standard mode, so a report that
says "broken in Private Browsing" is usually the same tracker blocking that
Strict mode does in normal windows: test it in the target configuration in a
normal window."""
PRIVATE_BROWSING_PRIVATE = """\
Private Browsing windows block trackers even in Standard mode. This run tests
every configuration in a private window (see the user message), so test the
target configuration as given, also for reports about Private Browsing."""

# Screenshot stage -> result field holding the path the agent saved it to.
SCREENSHOT_FIELDS = {
    "baseline": "screenshot_baseline",
    "target": "screenshot_target",
    "fixed": "screenshot_fixed",
}

# Where get_content_blocking_log records every log it returns, by ETP mode,
# and set_etp_mode the versions of the filter lists it loaded.
CONTENT_BLOCKING_LOG_FILE = "content-blocking-log.json"


class AutowebcompatEtpResult(EtpInvestigationResult):
    exception_records: list[dict[str, Any]]
    whiteboard_tags: list[str]
    user_story_lines: list[str]
    existing_exceptions: list[dict[str, Any]] | None
    existing_shims: list[dict[str, Any]] | None
    screenshot_urls: dict[str, str]
    content_blocking_log_url: str | None = None
    mode: Mode = "investigate"
    etp: EtpLevel = "strict"
    filter_lists: list[FilterList] = []
    private: bool = False
    # Whether the baseline and convenience categories of the ETP exception list
    # applied in the target (None in runs from before they were recorded).
    exceptions_baseline: bool | None = None
    exceptions_convenience: bool | None = None
    # The `! Version:` header of each filter list set_etp_mode loaded, by list.
    filter_list_versions: dict[str, str] | None = None

    @model_validator(mode="after")
    def validate_blocked_trackers_have_screenshots(self) -> AutowebcompatEtpResult:
        # The screenshot paths are left out here, and the agent's submission
        # was already checked against them.
        return self

    @model_validator(mode="after")
    def validate_broken_without_lists(self) -> AutowebcompatEtpResult:
        # Checked against the target when the agent submitted it.
        return self


class EtpInvestigation(Task[EtpInvestigationResult]):
    name = "etp_investigation"
    result_cls = EtpInvestigationResult
    result_server_name = RESULT_SERVER_NAME

    def __init__(
        self,
        task_config: TaskConfig,
        run_tracker: RunTracker,
        firefox_path: Path,
        input_data: AutoWebcompatInput,
        bugzilla_mcp_server: McpServerConfig,
        screenshot_dir: Path,
        content_blocking_log_file: Path | None = None,
        mode: Mode = "investigate",
        etp: EtpLevel = "strict",
        filter_lists: tuple[FilterList, ...] = (),
        private: bool = False,
        exceptions_baseline: bool | None = None,
        exceptions_convenience: bool | None = None,
    ):
        # The submission is validated against the target: with filter lists,
        # broken_without_lists is required when it breaks.
        self.result_cls = (
            EtpListsTargetResult if filter_lists else EtpInvestigationResult
        )
        super().__init__(task_config, run_tracker)
        self.input_data = input_data
        self.mode = mode
        self.etp = etp
        self.filter_lists = filter_lists
        self.private = private
        overrides = exception_overrides(
            etp, exceptions_baseline, exceptions_convenience, mode
        )
        self.exceptions = effective_exceptions(etp, *overrides)
        self.screenshot_paths = {
            stage: screenshot_dir / f"{stage}.png" for stage in SCREENSHOT_FIELDS
        }
        self.add_mcp_server(
            "firefox-devtools",
            build_firefox_devtools_server(
                firefox_path,
                headless=task_config.headless,
                content_blocking_log_file=content_blocking_log_file,
                exceptions_baseline=overrides[0],
                exceptions_convenience=overrides[1],
                private=private,
            ),
            DEVTOOLS_TOOLS + PRIVILEGED_TOOLS,
        )
        self.add_mcp_server(
            EXCEPTIONS_SERVER_NAME, build_exceptions_server(), [FIND_EXCEPTIONS_TOOL]
        )
        self.add_mcp_server(
            TRACKER_LISTS_SERVER_NAME,
            build_tracker_lists_server(),
            [CHECK_TRACKER_LISTS_TOOL],
        )
        if self.input_data.type == "bug_id":
            self.add_mcp_server("bugzilla", bugzilla_mcp_server, BUGZILLA_READ_TOOLS)

    def subject(self) -> Any:
        return self.input_data.subject()

    def system_prompt(self) -> str:
        return (
            (HERE / "prompts" / "system.md")
            .read_text()
            .replace(
                PRIVATE_BROWSING_MARKER,
                PRIVATE_BROWSING_PRIVATE if self.private else PRIVATE_BROWSING_NORMAL,
            )
        )

    def user_prompt(self) -> str:
        if isinstance(self.input_data, BugDataInput):
            report = (
                "Here is the web-compatibility report to work on:\n\n"
                f"{self.input_data.bug_data}\n\n"
                "Follow your task procedure."
            )
        else:
            report = (
                f"The web-compatibility report to work on is Bugzilla bug {self.input_data.bug_id}. "
                "Fetch it using the Bugzilla MCP tools, then follow your task procedure."
            )
        if not self.exceptions[0]:
            report = f"{report}\n\n{RETEST_NOTE}"
        elif self.etp != "off" and self.exceptions != default_exceptions(self.etp):
            default = default_exceptions(self.etp)
            note = EXCEPTIONS_NOTE.format(
                applying=EXCEPTIONS_APPLYING[self.exceptions],
                level=ETP_NAMES[self.etp],
                default=DEFAULT_EXCEPTIONS_NAMES[default],
            )
            report = f"{report}\n\n{note}"
        target = describe_config(self.etp, self.filter_lists)
        baseline = baseline_etp(self.etp)
        report += (
            f"\n\nTarget configuration: {target}. Call `set_etp_mode` with "
            f"{set_etp_mode_args(self.etp, self.filter_lists)}.\n"
            f"Baseline configuration: {describe_config(baseline)}. Call "
            f"`set_etp_mode` with {set_etp_mode_args(baseline)}."
        )
        report += (
            f"\n\n{PRIVATE_NOTE}"
            if self.private
            else "\n\nThis run tests in a normal (not private) window."
        )
        if self.etp == "off" and not self.filter_lists:
            report += f"\n\n{CONTROL_NOTE}"
        paths = self.screenshot_paths
        return (
            f"{report}\n\n"
            "Screenshot paths (pass these exactly as `saveTo`):\n"
            f"- Baseline: {paths['baseline']}\n"
            f"- Target: {paths['target']}\n"
            f"- Target with the fix: {paths['fixed']}"
        )


def exception_records(
    result: EtpInvestigationResult, input_data: AutoWebcompatInput
) -> list[dict[str, Any]]:
    """Turn the proposals into records shaped like the Remote Settings collection."""
    bug_ids = [str(input_data.bug_id)] if isinstance(input_data, BugIdInput) else []
    records = []
    for proposal in result.proposed_exceptions:
        record: dict[str, Any] = {
            "bugIds": bug_ids,
            "category": proposal.category,
            "urlPattern": proposal.urlPattern,
            "classifierFeatures": proposal.classifierFeatures,
        }
        if proposal.topLevelUrlPattern is not None:
            record["topLevelUrlPattern"] = proposal.topLevelUrlPattern
        records.append(record)
    return records


def trackers_blocked_host(pattern: str) -> str:
    """The host of a match pattern, keeping a leading `*.` wildcard."""
    match = re.match(r"^[^:]+://([^/:]+)", pattern)
    return match.group(1) if match else pattern


def bug_tags(result: EtpInvestigationResult) -> tuple[list[str], list[str]]:
    """The whiteboard tags and user story lines that mark the bug as diagnosed.

    Follows https://wiki.mozilla.org/Privacy/Docs/How_To_Triage_ETP-Strict_Website_Breakage:
    the Remote Settings bot picks up diagnosed bugs with an `[exception-*]`
    category tag and the hosts and classifier features in the user story.
    Returns empty lists unless the agent proposes exceptions.
    """
    proposals = result.proposed_exceptions
    if not proposals:
        return [], []
    categories = [
        category
        for category in ("baseline", "convenience")
        if any(p.category == category for p in proposals)
    ]
    if len(categories) > 1:
        logger.warning(
            "proposed exceptions mix baseline and convenience; the bug's tags "
            "can only carry one category"
        )
    hosts = list(dict.fromkeys(trackers_blocked_host(p.urlPattern) for p in proposals))
    features = [
        feature
        for feature in get_args(ClassifierFeature)
        if any(feature in p.classifierFeatures for p in proposals)
    ]
    whiteboard = ["[privacy-team:diagnosed]"] + [f"[exception-{c}]" for c in categories]
    user_story = [
        "trackers-blocked:" + ",".join(hosts),
        "classifier-features:" + ",".join(features),
    ]
    return whiteboard, user_story


def url_patterns(value: Any) -> list[str]:
    """Every URL pattern in a shim entry, however deeply it is nested.

    Patterns appear as plain strings in `matches` and `unblocksOnOptIn`, in
    `{patterns: [...]}` objects inside them, and in `contentScripts[].matches`.
    """
    if isinstance(value, str):
        return [value] if "://" in value else []
    if isinstance(value, list):
        return [pattern for item in value for pattern in url_patterns(item)]
    if isinstance(value, dict):
        return [pattern for item in value.values() for pattern in url_patterns(item)]
    return []


def parse_shims(source: str) -> list[dict[str, Any]]:
    """Pull each shim's id, name, bug and URL patterns out of `shims.js`.

    The file is JavaScript, but `AVAILABLE_SHIMS` is a plain literal (unquoted
    keys, trailing commas, comments), which JSON5 can parse.
    """
    start = source.index("[", source.index("const AVAILABLE_SHIMS"))
    end = source.index("\n];", start) + len("\n]")
    shims = []
    for entry in json5.loads(source[start:end]):
        shims.append(
            {key: entry[key] for key in ("id", "name", "bug") if key in entry}
            | {"patterns": url_patterns(entry)}
        )
    return shims


def find_existing_shims(shim: ProposedShim | None) -> list[dict[str, Any]] | None:
    """Existing shims whose URL patterns cover a host the proposal touches.

    Returns None if `shims.js` couldn't be fetched.
    """
    if shim is None:
        return []
    try:
        response = requests.get(SHIMS_URL, timeout=60)
        response.raise_for_status()
        existing = parse_shims(response.text)
    except requests.RequestException, ValueError:
        logger.exception("could not fetch or parse the existing shims")
        return None

    hosts = {pattern_host(p) for p in shim.matches + shim.unblocksOnOptIn}
    matches = []
    for entry in existing:
        overlapping = [
            pattern
            for pattern in entry["patterns"]
            if any(hosts_overlap(pattern_host(pattern), host) for host in hosts)
        ]
        if overlapping:
            matches.append(
                {key: entry[key] for key in ("id", "name", "bug") if key in entry}
                | {"patterns": overlapping}
            )

    found = [match["id"] for match in matches]
    if found and shim.existing_shim_id not in found:
        logger.warning(
            "agent proposed shim with existing_shim_id=%s, but %s already cover "
            "its hosts",
            shim.existing_shim_id,
            ", ".join(found),
        )
    return matches


def publish_screenshots(
    result: EtpInvestigationResult, publish_file: PublishFile
) -> dict[str, str]:
    """Publish the screenshots the agent saved; return their URLs by stage."""
    urls = {}
    for stage, field in SCREENSHOT_FIELDS.items():
        path = getattr(result, field)
        if path is not None:
            urls[stage] = publish_file(f"screenshot-{stage}.png", path, "image/png")
    return urls


def read_filter_list_versions(
    path: Path, filter_lists: Sequence[FilterList]
) -> dict[str, str] | None:
    """The versions of `filter_lists` set_etp_mode recorded in the log file.

    None if there are no lists, or set_etp_mode never read their versions.
    """
    try:
        versions = json.loads(path.read_text()).get("filterListVersions")
    except OSError, ValueError, AttributeError:
        return None
    if not isinstance(versions, dict):
        return None
    known = {
        name: version
        for name, version in versions.items()
        if name in filter_lists and isinstance(version, str)
    }
    return known or None


def publish_content_blocking_log(path: Path, publish_file: PublishFile) -> str | None:
    """Publish the content blocking logs the MCP server recorded, if any."""
    if not path.is_file():
        return None
    return publish_file(CONTENT_BLOCKING_LOG_FILE, path, "application/json")


async def run_autowebcompat_etp(
    config: TaskConfig,
    tracker: RunTracker,
    input_data: AutoWebcompatInput,
    bugzilla_mcp_server: McpServerConfig,
    publish_file: PublishFile,
    mode: Mode = "investigate",
    etp: EtpLevel = "strict",
    filter_lists: tuple[FilterList, ...] = (),
    private: bool = False,
    exceptions_baseline: bool | None = None,
    exceptions_convenience: bool | None = None,
) -> AutowebcompatEtpResult:
    """Investigate an ETP breakage report and return the proposed fix.

    `exceptions_baseline` and `exceptions_convenience` turn that category of
    the ETP exception list on or off in every configuration; None keeps the
    ETP level's default. `retest` mode turns baseline off. With `private`,
    every configuration is tested in a private window.

    Raises :class:`AgentError` if the agent ends in an error.
    """
    with Environment() as env:
        # Outside Linux (a native run) there is no Xvfb: Firefox opens a real window.
        if not config.headless and sys.platform == "linux":
            env.start_xvfb()

        firefox_path = firefox_binary()
        screenshot_dir = Path(tempfile.mkdtemp(prefix="autowebcompat-etp-screenshots-"))
        log_dir = Path(tempfile.mkdtemp(prefix="autowebcompat-etp-logs-"))
        content_blocking_log_file = log_dir / CONTENT_BLOCKING_LOG_FILE
        investigation = EtpInvestigation(
            config,
            tracker,
            firefox_path,
            input_data,
            bugzilla_mcp_server,
            screenshot_dir,
            content_blocking_log_file,
            mode,
            etp,
            filter_lists,
            private,
            exceptions_baseline,
            exceptions_convenience,
        )
        result = await investigation.run()

    records = exception_records(result, input_data)
    whiteboard_tags, user_story_lines = bug_tags(result)
    return AutowebcompatEtpResult(
        # The local paths mean nothing outside the container; the URLs replace them.
        **result.model_dump(exclude=set(SCREENSHOT_FIELDS.values())),
        exception_records=records,
        whiteboard_tags=whiteboard_tags,
        user_story_lines=user_story_lines,
        existing_exceptions=find_existing_exceptions(records),
        existing_shims=find_existing_shims(result.proposed_shim),
        screenshot_urls=publish_screenshots(result, publish_file),
        content_blocking_log_url=publish_content_blocking_log(
            content_blocking_log_file, publish_file
        ),
        mode=mode,
        etp=etp,
        filter_lists=list(filter_lists),
        private=private,
        exceptions_baseline=investigation.exceptions[0],
        exceptions_convenience=investigation.exceptions[1],
        filter_list_versions=read_filter_list_versions(
            content_blocking_log_file, filter_lists
        ),
    )
