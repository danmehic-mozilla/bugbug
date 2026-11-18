"""Find the Firefox for the agent to drive: a local build, or a fresh Nightly."""

import configparser
import logging
import os
import platform
import shutil
import tempfile
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import mozdownload
import mozinstall

logger = logging.getLogger("autowebcompat-etp")

# How many earlier days of Nightly to try if the latest build can't be fetched.
NIGHTLY_FALLBACK_DAYS = 3

# In a cached install, the file naming the binary, relative to the install.
BINARY_FILE = "BINARY"
# A cache entry another run is still installing, unless it is older than this.
INSTALLING_PREFIX = ".installing-"
INSTALLING_MAX_AGE = 3600


def firefox_binary() -> Path:
    """`LOCAL_FIREFOX` if set (a local build, for native runs), else a fresh Nightly.

    With `FIREFOX_CACHE_DIR` set, the Nightly is downloaded once a day and
    reused by the runs after it.
    """
    if local := os.environ.get("LOCAL_FIREFOX"):
        logger.info("using the local Firefox at %s", local)
        return Path(local)
    if cache := os.environ.get("FIREFOX_CACHE_DIR"):
        try:
            return cached_firefox_nightly(Path(cache))
        except OSError:
            logger.exception("could not use the Firefox cache at %s", cache)
    return install_firefox_nightly(
        Path(tempfile.mkdtemp(prefix="firefox-nightly-", dir=Path.home()))
    )


def firefox_build(binary: Path) -> tuple[str | None, str | None]:
    """The version and build ID of the Firefox at `binary`, from application.ini.

    (None, None) if the file isn't there or can't be read.
    """
    for ini in (
        binary.parent / "application.ini",
        # macOS: Nightly.app/Contents/MacOS/firefox.
        binary.parent.parent / "Resources" / "application.ini",
    ):
        parser = configparser.ConfigParser()
        try:
            if not parser.read(ini):
                continue
            return parser.get("App", "Version"), parser.get("App", "BuildID")
        except configparser.Error, OSError:
            logger.exception("could not read %s", ini)
    return None, None


def cached_binary(install: Path) -> Path | None:
    """The binary of a finished cache entry, or None."""
    try:
        binary = install / (install / BINARY_FILE).read_text().strip()
    except OSError:
        return None
    return binary if binary.is_file() else None


def prune_cache(cache: Path, keep: str) -> None:
    """Remove the installs of other days, and installs that never finished."""
    for entry in cache.iterdir():
        if not entry.is_dir() or entry.name == keep:
            continue
        if entry.name.startswith(INSTALLING_PREFIX):
            if time.time() - entry.stat().st_mtime < INSTALLING_MAX_AGE:
                continue
        elif cached_binary(entry) is None:
            # Not one of ours.
            continue
        shutil.rmtree(entry, ignore_errors=True)


def cached_firefox_nightly(cache: Path) -> Path:
    """Today's Nightly from `cache`, installing it there first if it is missing.

    Entries are keyed by the UTC day of the download. An install is built in
    a directory of its own and renamed into place, so runs starting at the
    same time never see a half-installed Firefox.
    """
    cache.mkdir(parents=True, exist_ok=True)
    day = datetime.now(UTC).date().isoformat()
    install = cache / day
    if binary := cached_binary(install):
        logger.info("using the cached Firefox nightly at %s", binary)
        return binary
    # An entry is renamed into place whole, so one without its binary is broken.
    shutil.rmtree(install, ignore_errors=True)

    staging = Path(tempfile.mkdtemp(prefix=INSTALLING_PREFIX, dir=cache))
    binary = install_firefox_nightly(staging)
    (staging / BINARY_FILE).write_text(str(binary.relative_to(staging)))
    try:
        staging.rename(install)
    except OSError:
        # Another run installed it meanwhile; use that one.
        shutil.rmtree(staging, ignore_errors=True)
    binary = cached_binary(install)
    if binary is None:
        raise OSError(f"no Firefox in the cache entry {install}")
    prune_cache(cache, keep=day)
    return binary


def install_firefox_nightly(install_dir: Path) -> Path:
    # mozdownload doesn't correctly get arm builds for arm linux
    mozdownload_platform = (
        "linux-arm64"
        if platform.system() == "Linux" and platform.machine() in ("aarch64", "arm64")
        else None
    )

    logger.info("downloading Firefox nightly...")
    kwargs: dict[str, str] = {"branch": "mozilla-central"}
    scraper = None
    # The newest Nightly's folder is sometimes not yet listed on the archive,
    # in which case mozdownload raises NotFoundError; fall back to earlier days.
    for days_back in range(NIGHTLY_FALLBACK_DAYS + 1):
        if days_back:
            day = datetime.now(UTC).date() - timedelta(days=days_back)
            kwargs["date"] = day.isoformat()
            logger.warning("falling back to Firefox nightly from %s", day)
        try:
            scraper = mozdownload.FactoryScraper(
                "daily",
                platform=mozdownload_platform,
                destination=str(install_dir),
                **kwargs,
            )
            break
        except mozdownload.errors.NotFoundError:
            if days_back == NIGHTLY_FALLBACK_DAYS:
                raise
            logger.exception("could not find Firefox nightly build")
    archive = scraper.download()

    install_path = mozinstall.install(archive, str(install_dir))
    binary = Path(mozinstall.get_binary(install_path, "firefox"))
    # The archive is only needed to install from.
    Path(archive).unlink(missing_ok=True)

    logger.info("installed Firefox at %s", binary)
    return binary
