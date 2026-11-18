"""Structured result reporting for the autowebcompat-etp agent."""

import re
from pathlib import Path
from typing import Annotated, ClassVar, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

RESULT_SERVER_NAME = "autowebcompat-etp"

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

# The classifier features an entry in the `url-classifier-exceptions` Remote
# Settings collection can lift.
ClassifierFeature = Literal[
    "tracking-protection",
    "socialtracking-protection",
    "fingerprinting-protection",
    "cryptomining-protection",
    "emailtracking-protection",
    "tracking-annotation",
]

# A WebExtension-style match pattern as used by the exception list, e.g.
# `*://*.example.com/*` or `https://cdn.example.com/*`.
MATCH_PATTERN_RE = re.compile(r"^(\*|https?)://(\*\.)?[^/*:]+(:\d+)?/.*$")


def validate_match_pattern(pattern: str) -> str:
    if not MATCH_PATTERN_RE.match(pattern):
        raise ValueError(
            f"{pattern!r} is not a match pattern like `*://*.example.com/*` with "
            "an explicit host (a bare `*` host is too broad)"
        )
    return pattern


class ProposedException(BaseModel):
    category: Annotated[
        Literal["baseline", "convenience"],
        Field(
            description="""`baseline` if the exception fixes major breakage: the site or a
        core flow on it is unusable (page doesn't load, can't log in, check out, play
        the main video, submit the main form). `convenience` if it fixes a minor or
        ancillary feature (embedded social widgets, "sign in with" buttons, comments,
        maps, chat widgets). Baseline exceptions apply in Strict mode by default;
        convenience exceptions only apply in Strict when the user opts in."""
        ),
    ]

    urlPattern: Annotated[
        str,
        Field(
            description=(
                "Match pattern for the blocked resource(s) to allow, e.g. "
                "`*://platform.linkedin.com/*`. Keep it as narrow as the evidence "
                "allows: prefer the exact blocked host over a `*.` wildcard."
            ),
        ),
    ]

    topLevelUrlPattern: Annotated[
        str | None,
        Field(
            description=(
                "Match pattern for the top-level site the exception is limited to, "
                "e.g. `*://www.example.com/*`. Set it unless the same resource is "
                "known to break many unrelated sites; null makes the exception "
                "global."
            ),
        ),
    ]

    classifierFeatures: Annotated[
        list[ClassifierFeature],
        Field(
            min_length=1,
            description=(
                "Every classifier feature that blocks the resource in Strict mode "
                "and must be lifted to fix the breakage, as shown by the content "
                "blocking log (a host can be on several lists)."
            ),
        ),
    ]

    rationale: Annotated[
        str,
        Field(
            description=(
                "One or two sentences: what the resource does for the site and "
                "why you chose this category and scope."
            ),
        ),
    ]

    @field_validator("urlPattern", mode="after")
    @classmethod
    def validate_url_pattern(cls, pattern: str) -> str:
        return validate_match_pattern(pattern)

    @field_validator("topLevelUrlPattern", mode="after")
    @classmethod
    def validate_top_level_url_pattern(cls, pattern: str | None) -> str | None:
        return None if pattern is None else validate_match_pattern(pattern)


class ProposedShim(BaseModel):
    """A SmartBlock shim for the webcompat addon's `data/shims.js`."""

    kind: Annotated[
        Literal["opt_in_placeholder"] | Literal["stub"],
        Field(
            description="""`opt_in_placeholder` if the shim replaces the blocked widget
        with a placeholder that unblocks the resources when the user clicks it (like
        the Facebook SDK or Instagram/TikTok embed shims). `stub` if a stand-in script
        that defines the API the page expects is enough to fix the breakage while the
        resources stay blocked."""
        ),
    ]

    name: Annotated[
        str,
        Field(
            description="Human-readable shim name, e.g. `Instagram embed placeholder`."
        ),
    ]

    matches: Annotated[
        list[str],
        Field(
            min_length=1,
            description=(
                "Match patterns for the blocked script(s) the shim replaces, as "
                "narrow as the evidence allows, e.g. "
                "`https://platform.instagram.com/*/embeds.js`."
            ),
        ),
    ]

    unblocksOnOptIn: Annotated[
        list[str],
        Field(
            description=(
                "For `opt_in_placeholder`: match patterns for every resource that "
                "must be unblocked after the user clicks, i.e. the set your skip-URL "
                "test showed is needed. Empty for `stub`."
            ),
        ),
    ]

    behavior: Annotated[
        str,
        Field(
            description=(
                "What the shim script must do: for a placeholder, where it appears, "
                "what it shows and what the click does; for a stub, which globals "
                "and functions it must define and what they return."
            ),
        ),
    ]

    existing_shim_id: Annotated[
        str | None,
        Field(
            description=(
                "The `id` of an existing entry in `shims.js` that covers the same "
                "provider and should be extended instead of adding a new shim, or "
                "null if there is none."
            ),
        ),
    ]

    rationale: Annotated[
        str,
        Field(
            description=(
                "One or two sentences: why the exception would only be "
                "`convenience` and why a shim can restore the feature, or for "
                "`anti_adblock`, what the detection checks and how the shim "
                "satisfies it."
            ),
        ),
    ]

    @field_validator("matches", "unblocksOnOptIn", mode="after")
    @classmethod
    def validate_patterns(cls, patterns: list[str]) -> list[str]:
        return [validate_match_pattern(pattern) for pattern in patterns]

    @model_validator(mode="after")
    def validate_unblocks_match_kind(self) -> ProposedShim:
        if self.kind == "opt_in_placeholder" and not self.unblocksOnOptIn:
            raise ValueError("unblocksOnOptIn must not be empty for a placeholder")
        if self.kind == "stub" and self.unblocksOnOptIn:
            raise ValueError("unblocksOnOptIn must be empty for a stub")
        return self


class BlockedTrackers(BaseModel):
    """The number of blocked trackers at each screenshot, keyed like them."""

    baseline: Annotated[
        int | None,
        Field(
            ge=0,
            description="Blocked trackers when you took the baseline screenshot.",
        ),
    ] = None

    target: Annotated[
        int | None,
        Field(
            ge=0,
            description="Blocked trackers when you took the target screenshot.",
        ),
    ] = None

    fixed: Annotated[
        int | None,
        Field(
            ge=0,
            description="Blocked trackers when you took the fixed screenshot.",
        ),
    ] = None


class EtpFindings(BaseModel):
    # The findings of an investigation, with the checks that hold wherever
    # they are stored. EtpInvestigationResult adds the ones that only make
    # sense for what the agent submits.

    summary: Annotated[
        str,
        Field(
            description="""A 2-4 sentence summary of your findings: what breaks in the
        target configuration, which blocked resource causes it, and what fixes it (an exception or a
        shim).

        Hard limit: 500 characters, not counting link URLs. State conclusions, not
        the investigation."""
        ),
    ]

    failure_reason: Annotated[
        (
            Literal["not_etp"]
            | Literal["not_reproducible"]
            | Literal["fixed_by_list_update"]
            | Literal["broken_in_baseline"]
            | Literal["not_fixable_by_exception"]
            | Literal["exception_not_verified"]
            | Literal["anti_adblock"]
            | Literal["blocked"]
            | Literal["blocked_captcha"]
            | Literal["blocked_geo"]
            | Literal["login"]
            | Literal["down"]
            | Literal["other"]
            | None
        ),
        Field(
            description="""`null` if you verified that lifting classifier blocking fixes the
        breakage in the target configuration and propose exceptions or a shim. Otherwise one of:
          * not_etp - The report doesn't describe site breakage that could be caused by
          tracking protection (e.g. a Firefox UI issue, or a webcompat issue that the
          report itself shows happens with default settings)
          * not_reproducible - You ran all the steps but the site works in the target
          configuration too
          * fixed_by_list_update - The site works in the target configuration, and `check_tracker_lists`
          shows that a host serving the broken feature was recently removed from the
          tracker lists: the reporter's profile most likely still had the older lists
          * broken_in_baseline - The breakage also happens in the baseline
          configuration, so the target configuration doesn't cause it
          * not_fixable_by_exception - The target configuration causes the breakage,
          but through something the exception list can't lift: a protection like
          cookie/storage restrictions, fingerprinting protection, query stripping or
          bounce tracking protection, or blocking by the EasyList/EasyPrivacy filter
          lists. Name the blocking list and hosts in the summary
          * exception_not_verified - Classifier blocking causes the breakage, but no
          exception you tested fixed it
          * anti_adblock - The site detects that its ads or trackers are blocked and
          refuses to work (e.g. a "please disable your ad blocker" wall), and allowing
          the blocked resources with the skip-URL prefs works around it. Always propose
          the exceptions that work around it; they are only added if a reviewer opts
          in. If a shim can also satisfy the detection while the resources stay
          blocked (a stub that defines what the detection script checks, e.g. the ad
          library's globals, or a placeholder in place of the ad), propose it too
          * blocked_captcha - Access to the site was blocked by a captcha
          * blocked_geo - Access to the site was blocked based on location
          * blocked - Access to the site was blocked for some other reason
          * login - Reproducing the issue requires completing a login flow
          * down - The site is down or unavailable in a way unrelated to the report
          * other - Any other reason (briefly state it in the summary)
"""
        ),
    ]

    broken_in_baseline: Annotated[
        bool | None,
        Field(
            description=(
                "true if the reported breakage happens in the baseline "
                "configuration, false if the site works there, null if you "
                "couldn't test it."
            ),
        ),
    ]

    broken_in_target: Annotated[
        bool | None,
        Field(
            description=(
                "true if the reported breakage happens in the target "
                "configuration, false if the site works there, null if you "
                "couldn't test it."
            ),
        ),
    ]

    broken_without_lists: Annotated[
        bool | None,
        Field(
            description=(
                "Only when the target configuration has filter lists, "
                "`broken_in_target` is true and the failure reason isn't "
                "`broken_in_baseline`: true if the breakage also happens "
                "with the target's ETP level and no filter lists, false if the "
                "site works then (the filter lists alone cause it). Null "
                "otherwise."
            ),
        ),
    ]

    culprit_prefs: Annotated[
        list[str],
        Field(
            description=(
                "The target-configuration preference(s) behind the breakage, e.g. "
                "`privacy.trackingprotection.socialtracking.enabled`: the classifier "
                "prefs of the features in your verified skip-URL set, or the prefs "
                "whose reversion to the baseline value fixed it. Empty if you didn't "
                "isolate it."
            ),
        ),
    ]

    blocked_resources: Annotated[
        list[str],
        Field(
            description=(
                "Origins the content blocking log shows as blocked in the target "
                "configuration that "
                "are relevant to the breakage, each followed by the blocking "
                "feature(s), e.g. `https://platform.linkedin.com "
                "(socialtracking-protection, tracking-protection)`."
            ),
        ),
    ]

    proposed_exceptions: Annotated[
        list[ProposedException],
        Field(
            description=(
                "The smallest set of exceptions that together fix the breakage. "
                "Empty when you propose a shim instead (except for `anti_adblock`, "
                "which always has them) or `failure_reason` is set to anything "
                "but `anti_adblock`."
            ),
        ),
    ]

    proposed_shim: Annotated[
        ProposedShim | None,
        Field(
            description=(
                "The shim to add instead of exceptions, when the exceptions would "
                "all be `convenience` and a shim can restore the feature, or in "
                "addition to the exceptions when it gets around an `anti_adblock` "
                "wall. Null otherwise."
            ),
        ),
    ] = None

    exception_verified: Annotated[
        bool,
        Field(
            description=(
                "true if, in the target configuration with the blocked resources "
                "allowed via the "
                "skip-URL prefs, they loaded and the reported breakage was gone."
            ),
        ),
    ]

    severity: Annotated[
        Literal["S1", "S2", "S3", "S4"] | None,
        Field(
            description="""The Bugzilla severity of the reported breakage, judged from what you
        observed or, if you couldn't test, from the report:
          * S1 - The site is unusable: it doesn't load or is blank
          * S2 - A core feature or flow is broken with no workaround (can't log in,
          check out, play the main video, submit the main form)
          * S3 - A non-core feature is broken or missing (embedded social posts or
          videos, "sign in with" buttons, comments, maps, chat widgets), or a core one
          has a workaround
          * S4 - Cosmetic: layout glitches or missing decoration with no loss of
          function
        Breakage caused by Strict mode is almost never S1: the user can turn off
        tracking protection for the site, so even a site that doesn't load in Strict
        is usually S2.
        Null if the report doesn't describe site breakage (`not_etp`)."""
        ),
    ]

    priority: Annotated[
        Literal["P1", "P2", "P3"] | None,
        Field(
            description="""The Bugzilla priority, weighing severity against how many users hit
        it. Breakage limited to Strict mode or Private Browsing reaches few users.
          * P1 - S1/S2 on a very popular site (a top global or national site)
          * P2 - S1/S2 on a well-known site, or S3 on a very popular one
          * P3 - Everything else, e.g. S3/S4 on a niche site or forum
        Null when `severity` is null."""
        ),
    ]

    steps: Annotated[
        str,
        Field(
            description=(
                "The ordered steps to reproduce the breakage in the target "
                "configuration and to "
                "verify the exception, as a single numbered list (1., 2., 3., ... one "
                "step per line), including every pref you set, written so another "
                "agent could repeat them with no extra context."
            ),
        ),
    ]

    screenshot_baseline: Annotated[
        Path | None,
        Field(
            description=(
                "The exact `saveTo` path you were given for the baseline "
                "screenshot, after saving it there with `screenshot_page`. Null if "
                "you didn't load the page in the baseline configuration."
            ),
        ),
    ] = None

    screenshot_target: Annotated[
        Path | None,
        Field(
            description=(
                "The exact `saveTo` path you were given for the target screenshot "
                "showing the breakage. Null if you didn't load the page in the "
                "target configuration."
            ),
        ),
    ] = None

    screenshot_fixed: Annotated[
        Path | None,
        Field(
            description=(
                "The exact `saveTo` path you were given for the screenshot in the "
                "target configuration with the skip-URL prefs applied, showing the "
                "fix. Null "
                "unless `exception_verified` is true."
            ),
        ),
    ] = None

    blocked_trackers: Annotated[
        BlockedTrackers,
        Field(
            description=(
                "For each screenshot you took, the `Blocked trackers` count "
                "`get_content_blocking_log` reported right after it, under the "
                "same name as the screenshot field (`target` for "
                "`screenshot_target`). Null for screenshots you didn't take."
            ),
        ),
    ] = BlockedTrackers()

    @field_validator(
        "screenshot_baseline",
        "screenshot_target",
        "screenshot_fixed",
        mode="after",
    )
    @classmethod
    def validate_screenshot(cls, path: Path | None) -> Path | None:
        if path is None:
            return None
        try:
            with path.open("rb") as f:
                is_png = f.read(len(PNG_SIGNATURE)) == PNG_SIGNATURE
        except OSError as exc:
            raise ValueError(
                f"Cannot read screenshot path {path}: {exc.strerror}"
            ) from exc
        if not is_png:
            raise ValueError(f"Screenshot path {path} is not a valid PNG image")
        return path

    @model_validator(mode="after")
    def validate_fix_matches_outcome(self) -> EtpFindings:
        has_shim = self.proposed_shim is not None
        if self.failure_reason is None:
            if bool(self.proposed_exceptions) == has_shim:
                raise ValueError(
                    "when failure_reason is null, propose either exceptions or a "
                    "shim, not both"
                )
            if not self.exception_verified:
                raise ValueError(
                    "failure_reason must be exception_not_verified (not null) when "
                    "exception_verified is false"
                )
        elif self.failure_reason == "anti_adblock":
            if not self.proposed_exceptions:
                raise ValueError(
                    "failure_reason anti_adblock needs proposed_exceptions, even "
                    "with a proposed_shim"
                )
            if not self.exception_verified:
                raise ValueError(
                    "failure_reason anti_adblock requires exception_verified: report "
                    "exception_not_verified if no exception you tested fixed it"
                )
        elif self.proposed_exceptions or has_shim:
            raise ValueError(
                "proposed_exceptions and proposed_shim must be empty when "
                "failure_reason is set to anything but anti_adblock"
            )
        if (self.severity is None) != (self.priority is None):
            raise ValueError("set both severity and priority, or neither")
        return self


class EtpInvestigationResult(EtpFindings):
    # What the agent submits: the findings, checked against the screenshots it
    # saved and the run's target configuration.

    # Whether the target configuration blocks with filter lists, which decides
    # when `broken_without_lists` is required. True in EtpListsTargetResult.
    target_has_lists: ClassVar[bool] = False

    @model_validator(mode="after")
    def validate_blocked_trackers_have_screenshots(self) -> EtpInvestigationResult:
        for stage, count in self.blocked_trackers:
            if count is not None and getattr(self, f"screenshot_{stage}") is None:
                raise ValueError(
                    f"blocked_trackers.{stage} is set, but screenshot_{stage} is "
                    "null: give the count only for screenshots you took"
                )
        return self

    @model_validator(mode="after")
    def validate_broken_without_lists(self) -> EtpInvestigationResult:
        if not (
            self.target_has_lists
            and self.broken_in_target is True
            and self.failure_reason != "broken_in_baseline"
        ):
            if self.broken_without_lists is not None:
                raise ValueError(
                    "broken_without_lists must be null unless the target "
                    "configuration has filter lists, broken_in_target is true and "
                    "the breakage isn't in the baseline"
                )
            return self
        if self.broken_without_lists is None:
            raise ValueError(
                "the target configuration has filter lists and broke: call "
                "set_etp_mode with the target's etp and no filter_lists, load the "
                "page again, follow the steps, and set broken_without_lists to "
                "whether it still breaks"
            )
        if self.broken_without_lists is False and (
            self.failure_reason != "not_fixable_by_exception"
            or self.proposed_exceptions
            or self.proposed_shim is not None
        ):
            raise ValueError(
                "broken_without_lists is false, so the filter lists alone cause "
                "the breakage and no exception can lift them: set failure_reason "
                "to not_fixable_by_exception and propose no exceptions or shim"
            )
        return self


class EtpListsTargetResult(EtpInvestigationResult):
    """The result of a run whose target configuration has filter lists."""

    target_has_lists: ClassVar[bool] = True
