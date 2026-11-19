import os
import time
from datetime import UTC, datetime
from pathlib import Path

import pytest
from hackbot_agents.autowebcompat_etp import browser

APPLICATION_INI = (
    "[App]\nVendor=Mozilla\nName=Firefox\nVersion=147.0a1\nBuildID=20261118093012\n"
)


def today() -> str:
    return datetime.now(UTC).date().isoformat()


@pytest.fixture
def install(monkeypatch):
    """Stand in for the download: a `firefox/firefox` file in the install dir."""
    calls = []

    def fake_install(install_dir: Path) -> Path:
        calls.append(install_dir)
        binary = install_dir / "firefox" / "firefox"
        binary.parent.mkdir()
        binary.write_text("#!/bin/sh\n")
        return binary

    monkeypatch.setattr(browser, "install_firefox_nightly", fake_install)
    monkeypatch.delenv("LOCAL_FIREFOX", raising=False)
    return calls


# --- firefox_build -------------------------------------------------------------


def test_firefox_build_linux(tmp_path):
    (tmp_path / "application.ini").write_text(APPLICATION_INI)
    assert browser.firefox_build(tmp_path / "firefox") == ("147.0a1", "20261118093012")


def test_firefox_build_macos(tmp_path):
    contents = tmp_path / "Nightly.app" / "Contents"
    (contents / "Resources").mkdir(parents=True)
    (contents / "Resources" / "application.ini").write_text(APPLICATION_INI)
    binary = contents / "MacOS" / "firefox"
    assert browser.firefox_build(binary) == ("147.0a1", "20261118093012")


def test_firefox_build_without_application_ini(tmp_path):
    assert browser.firefox_build(tmp_path / "firefox") == (None, None)


def test_firefox_build_with_a_broken_application_ini(tmp_path):
    (tmp_path / "application.ini").write_text("[App]\nVersion=147.0a1\n")
    assert browser.firefox_build(tmp_path / "firefox") == (None, None)


# --- the Nightly cache ---------------------------------------------------------


def test_cache_installs_once_a_day(tmp_path, install):
    first = browser.cached_firefox_nightly(tmp_path)
    second = browser.cached_firefox_nightly(tmp_path)
    assert first == second == tmp_path / today() / "firefox" / "firefox"
    assert first.is_file()
    assert len(install) == 1
    # Nothing is left behind from the install.
    assert [entry.name for entry in tmp_path.iterdir()] == [today()]


def test_cache_drops_other_days_and_stale_installs(tmp_path, install):
    old = tmp_path / "2026-01-01"
    (old / "firefox").mkdir(parents=True)
    (old / "firefox" / "firefox").write_text("")
    (old / browser.BINARY_FILE).write_text("firefox/firefox")
    stale = tmp_path / f"{browser.INSTALLING_PREFIX}stale"
    stale.mkdir()
    long_ago = time.time() - browser.INSTALLING_MAX_AGE - 60
    os.utime(stale, (long_ago, long_ago))
    in_progress = tmp_path / f"{browser.INSTALLING_PREFIX}other-run"
    in_progress.mkdir()
    unrelated = tmp_path / "notes"
    unrelated.mkdir()

    browser.cached_firefox_nightly(tmp_path)

    assert sorted(entry.name for entry in tmp_path.iterdir()) == sorted(
        [today(), in_progress.name, unrelated.name]
    )


def test_cache_reinstalls_an_entry_without_its_binary(tmp_path, install):
    binary = browser.cached_firefox_nightly(tmp_path)
    binary.unlink()
    assert browser.cached_firefox_nightly(tmp_path).is_file()
    assert len(install) == 2


def test_firefox_binary_uses_the_cache(tmp_path, install, monkeypatch):
    monkeypatch.setenv("FIREFOX_CACHE_DIR", str(tmp_path / "cache"))
    binary = browser.firefox_binary()
    assert binary == tmp_path / "cache" / today() / "firefox" / "firefox"


def test_firefox_binary_without_a_usable_cache(tmp_path, install, monkeypatch):
    blocker = tmp_path / "cache"
    blocker.write_text("a file, not a directory")
    monkeypatch.setenv("FIREFOX_CACHE_DIR", str(blocker))
    monkeypatch.setattr(browser.Path, "home", lambda: tmp_path)
    binary = browser.firefox_binary()
    assert binary.is_file()
    assert binary.parent.parent.name.startswith("firefox-nightly-")


def test_firefox_binary_prefers_a_local_build(tmp_path, install, monkeypatch):
    local = tmp_path / "firefox"
    local.write_text("")
    local.chmod(0o755)
    monkeypatch.setenv("LOCAL_FIREFOX", str(local))
    monkeypatch.setenv("FIREFOX_CACHE_DIR", str(tmp_path))
    assert browser.firefox_binary() == local
    assert not install


def test_firefox_binary_rejects_a_missing_local_build(tmp_path, install, monkeypatch):
    monkeypatch.setenv("LOCAL_FIREFOX", str(tmp_path / "missing"))
    with pytest.raises(FileNotFoundError, match="not an executable file"):
        browser.firefox_binary()
    assert not install
