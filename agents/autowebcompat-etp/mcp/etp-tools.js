// ETP tools for the autowebcompat-etp agent, inserted into the Firefox DevTools
// MCP bundle by patch-mcp.mjs at image build time.
//
// Each tool runs its chrome-privileged code the way the bundle's own
// get/set_firefox_prefs do: switch to the browser window's chrome context, run,
// then switch back to content in a `finally`. Unlike select_privileged_context,
// that never leaves the session stuck in chrome, so the page tools keep working.

// `isAsync` runs the script with executeAsyncScript: it must call its last
// argument with the result.
async function etpRunChrome(script, { isAsync = false } = {}, ...scriptArgs) {
  const { getFirefox: getFirefox2 } = await Promise.resolve().then(
    () => (init_src(), src_exports)
  );
  const firefox3 = await getFirefox2();
  const tree = await firefox3.sendBiDiCommand("browsingContext.getTree", {
    "moz:scope": "chrome",
  });
  const contexts = tree.contexts || [];
  if (contexts.length === 0) {
    throw new Error(
      "No privileged contexts available. Ensure MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 is set."
    );
  }
  const driver = firefox3.getDriver();
  const originalContextId = firefox3.getCurrentContextId();
  try {
    await driver.switchTo().window(contexts[0].context);
    await driver.setContext("chrome");
    return isAsync
      ? await driver.executeAsyncScript(script, ...scriptArgs)
      : await driver.executeScript(script, ...scriptArgs);
  } finally {
    try {
      await driver.setContext("content");
      if (originalContextId) {
        await driver.switchTo().window(originalContextId);
      }
    } catch {}
  }
}

// Filter lists the content classifier can block with, next to or without the
// tracker lists. `probe` is a URL the list blocks and the other lists don't, so
// a match shows that this list in particular is loaded.
const ETP_FILTER_LISTS = {
  easylist: {
    name: "EasyList",
    url: "https://easylist.to/easylist/easylist.txt",
    probe: "https://ib.adnxs.com/ut/v3/prebid",
  },
  easyprivacy: {
    name: "EasyPrivacy",
    url: "https://easylist.to/easylist/easyprivacy.txt",
    probe: "https://www.google-analytics.com/analytics.js",
  },
};

// Set by the local runner, which serves cached copies of the lists as
// `${base}/${key}.txt`: Firefox loads them, and the versions are read, from there.
const ETP_FILTER_LIST_BASE_URL = (
  process.env.ETP_FILTER_LIST_BASE_URL || ""
).replace(/\/+$/, "");
if (ETP_FILTER_LIST_BASE_URL) {
  for (const [key, list] of Object.entries(ETP_FILTER_LISTS)) {
    list.url = `${ETP_FILTER_LIST_BASE_URL}/${key}.txt`;
  }
}

const ETP_LEVELS = ["off", "standard", "strict"];

// The configuration last set with set_etp_mode (e.g. "strict+easylist"), which
// get_content_blocking_log records its logs under. Firefox starts in Standard.
let etpCurrentMode = "standard";

// Set by the harness to override whether each category of the ETP exception
// list applies: "1" turns the category's allow_list pref on, "0" off, unset
// leaves Firefox's default for the ETP category (Strict: baseline only;
// Standard: both). Firefox ignores convenience while baseline is off. Skip-URL
// prefs still apply; they aren't part of either category. The older
// ETP_DISABLE_EXCEPTIONS=1 (retest mode) means both "0".
const ETP_EXCEPTION_CATEGORIES = ["baseline", "convenience"];
const ETP_EXCEPTION_OVERRIDES = Object.fromEntries(
  ETP_EXCEPTION_CATEGORIES.map((c) => {
    const value = process.env["ETP_EXCEPTIONS_" + c.toUpperCase()];
    if (value === "1" || value === "0") {
      return [c, value === "1"];
    }
    return [c, process.env.ETP_DISABLE_EXCEPTIONS === "1" ? false : null];
  })
);

// Set by the harness for a Private Browsing run: every set_etp_mode closes the
// private window it opened before and opens a fresh one, whose tab becomes the
// selected page, so each configuration is tested in a new private session.
const ETP_PRIVATE = process.env.ETP_PRIVATE === "1";

// The `! Version:` header of each filter list set_etp_mode loaded, by list key.
const etpFilterListVersions = {};

// Reads a filter list's `! Version:` header, which sits in its first lines:
// stops reading once it is found, or after 64 KB. Null if it isn't there.
async function etpFetchListVersion(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30e3);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (text.length < 65536) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
      const match = text.match(/^! Version: *(\S+)/m);
      if (match) {
        return match[1];
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// Closes the private windows (and so ends the private session, dropping its
// cookies and site data), then opens a new private window. Calls back once its
// first tab exists, with whether the old session was seen to end.
const ETP_OPEN_PRIVATE_WINDOW_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const { BrowserWindowTracker } = ChromeUtils.importESModule(
    "resource:///modules/BrowserWindowTracker.sys.mjs"
  );
  const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/PrivateBrowsingUtils.sys.mjs"
  );
  const old = [...Services.wm.getEnumerator("navigator:browser")].filter((w) =>
    PrivateBrowsingUtils.isWindowPrivate(w)
  );
  const exited = old.length
    ? new Promise((resolve) => {
        const topic = "last-pb-context-exited";
        const observer = () => {
          Services.obs.removeObserver(observer, topic);
          resolve(true);
        };
        Services.obs.addObserver(observer, topic);
        setTimeout(() => resolve(false), 10000);
        for (const w of old) {
          w.close();
        }
      })
    : Promise.resolve(true);
  exited
    .then((sessionEnded) =>
      BrowserWindowTracker.promiseOpenWindow({ private: true }).then(() => ({
        sessionEnded,
      }))
    )
    .then(done, (e) => done({ error: String(e) }));
`;

// Opens a fresh private window (see ETP_OPEN_PRIVATE_WINDOW_SCRIPT) and makes
// its tab the selected page, the way select_page does, so the page tools act
// on it. Returns whether the previous private session ended.
async function etpOpenPrivateWindow() {
  const { getFirefox: getFirefox2 } = await Promise.resolve().then(
    () => (init_src(), src_exports)
  );
  const firefox3 = await getFirefox2();
  const driver = firefox3.getDriver();
  const before = new Set(await driver.getAllWindowHandles());
  const result = await etpRunChrome(ETP_OPEN_PRIVATE_WINDOW_SCRIPT, {
    isAsync: true,
  });
  if (result.error) {
    throw new Error(`Opening a private window failed: ${result.error}`);
  }
  const deadline = Date.now() + 10e3;
  for (;;) {
    const handles = await driver.getAllWindowHandles();
    const added = handles.filter((handle) => !before.has(handle));
    if (added.length) {
      await driver.switchTo().window(added[0]);
      firefox3.setCurrentContextId(added[0]);
      await firefox3.refreshTabs();
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error("The private window opened, but its tab never appeared");
    }
    await new Promise((resolve2) => setTimeout(resolve2, 250));
  }
  const isPrivate = await etpRunChrome(
    ETP_SELECTED_BROWSER_PREAMBLE + "return isPrivate;",
    {},
    firefox3.getCurrentContextId()
  );
  if (!isPrivate) {
    throw new Error("The selected page is not in a private window");
  }
  return result;
}

// Chrome-script preamble that finds the <browser> of the selected page (the
// script's first argument is its context ID) and whether it is private.
const ETP_SELECTED_BROWSER_PREAMBLE = `
  const { NavigableManager } = ChromeUtils.importESModule(
    "chrome://remote/content/shared/NavigableManager.sys.mjs"
  );
  const browser = NavigableManager.getBrowserById(arguments[0]);
  if (!browser) {
    throw new Error("No tab for the selected page " + arguments[0]);
  }
  const isPrivate = browser.browsingContext.usePrivateBrowsing;
`;

const ETP_SET_MODE_SCRIPT = `
  // listUrls is the test_list_urls value when filter lists are selected, else
  // null.
  // exceptionOverrides maps baseline/convenience to true/false, or null for
  // the category's default.
  const [etp, listUrls, exceptionOverrides] = arguments;
  const category = "browser.contentblocking.category";
  const CC = "privacy.trackingprotection.content.";
  // ETP off: every tracker feature off and cookies unrestricted.
  const OFF_PREFS = {
    "privacy.trackingprotection.enabled": false,
    "privacy.trackingprotection.pbmode.enabled": false,
    "privacy.trackingprotection.socialtracking.enabled": false,
    "privacy.trackingprotection.cryptomining.enabled": false,
    "privacy.trackingprotection.fingerprinting.enabled": false,
    "privacy.trackingprotection.emailtracking.enabled": false,
    "privacy.trackingprotection.emailtracking.pbmode.enabled": false,
    "network.cookie.cookieBehavior": 0,
    "network.cookie.cookieBehavior.pbmode": 0,
  };
  // The service ignores pref changes until it exists. Getting it creates it,
  // but fails while it is disabled, after creating it.
  try {
    Cc["@mozilla.org/content-classifier-service;1"].getService(
      Ci.nsIContentClassifierService
    );
  } catch {}
  // The harness starts Firefox with the content classifier's pref mirror off,
  // so the classic URL classifier blocks the category's tracker lists and
  // honors the skip-URL prefs. The content classifier only runs the filter
  // lists. Clearing protection.enabled drops its engines, and setting
  // test_list_urls afterwards is always a change, which is what makes the
  // classifier download the lists (enabling it alone does not).
  const URLCLASSIFIER_OFF =
    "privacy.trackingprotection.urlclassifier.disable_for_channel_classifier";
  Services.prefs.clearUserPref(URLCLASSIFIER_OFF);
  for (const p of [
    "protection.enabled",
    "protection.engines",
    "protection.engines.pbmode",
    "protection.test_list_urls",
  ]) {
    Services.prefs.clearUserPref(CC + p);
  }
  // The Remote Agent's recommended prefs turn tracker blocking in private
  // windows off on the default branch, which Standard falls back to: restore
  // Firefox's own default, so Standard blocks trackers in private windows.
  Services.prefs
    .getDefaultBranch("")
    .setBoolPref("privacy.trackingprotection.pbmode.enabled", true);
  // ContentBlockingPrefs observes the category pref and synchronously applies
  // the category's prefs, but only on a change: go through another category
  // first, so re-selecting the current one still reapplies them.
  Services.prefs.setStringPref(
    category,
    etp === "standard" ? "strict" : "standard"
  );
  if (etp === "off") {
    for (const [p, value] of Object.entries(OFF_PREFS)) {
      if (typeof value === "boolean") {
        Services.prefs.setBoolPref(p, value);
      } else {
        Services.prefs.setIntPref(p, value);
      }
    }
    Services.prefs.setStringPref(category, "custom");
  } else {
    Services.prefs.setStringPref(category, etp);
  }
  if (listUrls !== null) {
    // An enabled content classifier makes Nightly skip the URL classifier for
    // every channel; keep it running so the filter lists block next to the
    // category's tracker lists instead of in place of them.
    Services.prefs.setBoolPref(URLCLASSIFIER_OFF, false);
    Services.prefs.setIntPref(CC + "mirror.mode", 0);
    Services.prefs.setStringPref(CC + "protection.engines", "test_block");
    Services.prefs.setStringPref(CC + "protection.engines.pbmode", "test_block");
    Services.prefs.setBoolPref(CC + "protection.enabled", true);
    Services.prefs.setStringPref(CC + "protection.test_list_urls", listUrls);
  }
  // Switching the category resets these (Strict turns baseline on and
  // convenience off, Standard clears both), so apply the overrides again after
  // it. ContentBlockingPrefs ignores them when matching the category, which
  // stays as set above.
  const allowListPref = (c) =>
    "privacy.trackingprotection.allow_list." + c + ".enabled";
  for (const [c, value] of Object.entries(exceptionOverrides)) {
    if (value !== null) {
      Services.prefs.setBoolPref(allowListPref(c), value);
    }
  }
  const { ContentBlockingPrefs } = ChromeUtils.importESModule(
    "moz-src:///browser/components/protections/ContentBlockingPrefs.sys.mjs"
  );
  const read = (branch, p) => {
    try {
      switch (branch.getPrefType(p)) {
        case branch.PREF_BOOL: return branch.getBoolPref(p);
        case branch.PREF_INT: return branch.getIntPref(p);
        case branch.PREF_STRING: return branch.getStringPref(p);
      }
    } catch {}
    return null;
  };
  const defaults = Services.prefs.getDefaultBranch("");
  const changed = {};
  for (const p of new Set([
    ...Object.keys(ContentBlockingPrefs.CATEGORY_PREFS.strict),
    ...Object.keys(OFF_PREFS),
  ])) {
    const value = read(Services.prefs, p);
    const standard = read(defaults, p);
    if (value !== standard) {
      changed[p] = { value, standard };
    }
  }
  return {
    category: Services.prefs.getStringPref(category),
    changed,
    exceptions: Object.fromEntries(
      Object.keys(exceptionOverrides).map((c) => [
        c,
        Services.prefs.getBoolPref(allowListPref(c), false),
      ])
    ),
    engines: Services.prefs.getStringPref(CC + "protection.engines", ""),
    enginesPbmode: Services.prefs.getStringPref(
      CC + "protection.engines.pbmode",
      ""
    ),
    mirrorMode: Services.prefs.getIntPref(CC + "mirror.mode", -1),
    // The URL classifier is only skipped while the content classifier is on.
    urlClassifierOn: !(
      Services.prefs.getBoolPref(URLCLASSIFIER_OFF, false) &&
      Services.prefs.getBoolPref(CC + "protection.enabled", false)
    ),
  };
`;

// Clears cookies, site data and caches, so the next load is a first visit like
// in a fresh Private Browsing window. Otherwise state from the previous mode
// carries over: e.g. a bot-protection cookie earned in Standard lets the site
// skip the challenge that breaks in Strict. Calls back with the flags of the
// cleaners that failed (0 if none).
const ETP_CLEAR_DATA_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const S = Ci.nsIClearDataService;
  Services.clearData.deleteData(
    S.CLEAR_ALL_CACHES | S.CLEAR_COOKIES_AND_SITE_DATA,
    { onDataDeleted: (failedFlags) => done({ failedFlags }) }
  );
`;

// Starts the downloads Strict mode depends on, once per session, and reports
// their progress on every call: the tracker lists (Safe Browsing tables of the
// mozilla provider) and the url-classifier-exceptions Remote Settings
// collection. State lives on the chrome window, which persists between scripts.
//
// List updates are serialized, and each one is bracketed by
// safebrowsing-update-begin (data: provider) and safebrowsing-update-finished
// (data: "success", "update error: ..." or "download error: <status>"), so the
// result of a mozilla update is the "finished" that follows its "begin".
const ETP_LISTS_STATUS_SCRIPT = `
  const PROVIDER = "mozilla";
  const lastUpdate = () =>
    Services.prefs.getStringPref(
      "browser.safebrowsing.provider." + PROVIDER + ".lastupdatetime", ""
    );
  let state = window.__etpLists;
  if (!state) {
    state = window.__etpLists = { lists: {}, rs: { done: false } };
    if (lastUpdate() === "") {
      let provider = null;
      const observer = {
        observe(subject, topic, data) {
          if (topic === "safebrowsing-update-begin") {
            provider = data;
          } else if (provider === PROVIDER) {
            state.lists.result = data;
          }
        },
      };
      Services.obs.addObserver(observer, "safebrowsing-update-begin");
      Services.obs.addObserver(observer, "safebrowsing-update-finished");
      try {
        const started = Cc["@mozilla.org/url-classifier/listmanager;1"]
          .getService(Ci.nsIUrlListManager)
          .forceUpdates(
            Services.prefs.getStringPref(
              "browser.safebrowsing.provider." + PROVIDER + ".lists"
            )
          );
        if (!started) {
          state.lists.result = "update error: the list manager could not start an update";
        }
      } catch (e) {
        state.lists.result = "update error: " + e;
      }
    }
    const { RemoteSettings } = ChromeUtils.importESModule(
      "resource://services-settings/remote-settings.sys.mjs"
    );
    RemoteSettings.pollChanges({ trigger: "manual" })
      .then(() => RemoteSettings("url-classifier-exceptions").get())
      .then((records) => { state.rs = { done: true, exceptions: records.length }; })
      .catch((e) => { state.rs = { done: true, error: String(e) }; });
  }
  const result = state.lists.result ?? null;
  return {
    lists: {
      lastUpdate: lastUpdate(),
      result,
      failed: result !== null && result !== "success",
    },
    exceptionList: state.rs,
  };
`;

const ETP_LISTS_TIMEOUT_MS = 120e3;

// Waits until the tracker lists and the exception list are downloaded. Throws
// as soon as either download fails, or on timeout, with the status attached.
async function etpEnsureProtectionLists() {
  const deadline = Date.now() + ETP_LISTS_TIMEOUT_MS;
  for (;;) {
    const status = await etpRunChrome(ETP_LISTS_STATUS_SCRIPT);
    const details = JSON.stringify(status, null, 2);
    if (status.lists.failed) {
      throw new Error(`Updating the tracker lists failed:\n${details}`);
    }
    if (status.exceptionList.error) {
      throw new Error(`Syncing the ETP exception list failed:\n${details}`);
    }
    if (status.lists.lastUpdate !== "" && status.exceptionList.done) {
      return status;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${
          ETP_LISTS_TIMEOUT_MS / 1e3
        }s waiting for the tracker ` +
          `lists and the ETP exception list:\n${details}`
      );
    }
    await new Promise((resolve2) => setTimeout(resolve2, 2e3));
  }
}

// Reports whether the content classifier's "test_block" engine blocks `url`.
// Until the downloads finish the engine doesn't exist (NS_ERROR_NOT_AVAILABLE);
// a list whose download fails is left out of it, so its probe never matches.
const ETP_PROBE_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const url = arguments[0];
  const service = Cc["@mozilla.org/content-classifier-service;1"].getService(
    Ci.nsIContentClassifierService
  );
  const request = {
    url,
    sourceUrl: "https://example.com/",
    topWindowUrl: "https://example.com/",
    requestType: "script",
    privateBrowsing: false,
    forceThirdPartyToTop: false,
    isNonRecommendedAddon: false,
  };
  const notBuilt = (e) => e?.result === Cr.NS_ERROR_NOT_AVAILABLE;
  try {
    service
      .probeFeature("test_block", request)
      .then((r) => done({ ready: r.matched }))
      .catch((e) => done(notBuilt(e) ? { ready: false } : { error: String(e) }));
  } catch (e) {
    done(notBuilt(e) ? { ready: false } : { error: String(e) });
  }
`;

// Waits until the content classifier blocks with each of `lists`. Throws on
// timeout, which also covers a failed download.
async function etpWaitForFilterLists(lists) {
  const deadline = Date.now() + ETP_LISTS_TIMEOUT_MS;
  for (const list of lists) {
    for (;;) {
      const status = await etpRunChrome(
        ETP_PROBE_SCRIPT,
        { isAsync: true },
        list.probe
      );
      if (status.error) {
        throw new Error(
          `Probing the content classifier failed: ${status.error}`
        );
      }
      if (status.ready) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${ETP_LISTS_TIMEOUT_MS / 1e3}s waiting for the ` +
            `content classifier to load the ${list.name} list from ` +
            `${list.url} (it still doesn't block ${list.probe}); the ` +
            "download may have failed."
        );
      }
      await new Promise((resolve2) => setTimeout(resolve2, 1e3));
    }
  }
}

// Which categories of the ETP exception list apply, from the allow_list prefs
// set_etp_mode left, and whether this run overrides Firefox's defaults.
function etpDescribeExceptions({ baseline, convenience }) {
  const applying = baseline
    ? convenience
      ? "baseline and convenience entries apply"
      : "only baseline entries apply (convenience off)"
    : "no entries apply (baseline off" +
      (convenience ? ", so the convenience pref is ignored" : "") +
      ")";
  const overridden = ETP_EXCEPTION_CATEGORIES.filter(
    (c) => ETP_EXCEPTION_OVERRIDES[c] !== null
  );
  return (
    `ETP exception list: ${applying}. ` +
    (overridden.length
      ? `This run sets ${overridden
          .map((c) => `${c} ${ETP_EXCEPTION_OVERRIDES[c] ? "on" : "off"}`)
          .join(" and ")} in every mode; set_etp_mode keeps that, so don't ` +
        "change the privacy.trackingprotection.allow_list.* prefs.\n"
      : "These are the category's defaults.\n")
  );
}

async function handleSetEtpMode(args2) {
  try {
    const { etp, filter_lists: listNames = [] } = args2 || {};
    if (!ETP_LEVELS.includes(etp)) {
      throw new Error(
        `etp must be one of ${ETP_LEVELS.map((m) => `"${m}"`).join(", ")}`
      );
    }
    const unknown = listNames.filter((name) => !(name in ETP_FILTER_LISTS));
    if (unknown.length) {
      throw new Error(
        `unknown filter list(s) ${unknown.join(", ")}; use ${Object.keys(
          ETP_FILTER_LISTS
        ).join(", ")}`
      );
    }
    const filterLists = Object.keys(ETP_FILTER_LISTS)
      .filter((name) => listNames.includes(name))
      .map((name) => ETP_FILTER_LISTS[name]);
    // Without the tracker lists, Standard and Strict block nothing: make sure
    // they are there before switching, and fail instead of handing back a mode
    // that silently doesn't block.
    const lists = etp !== "off" ? await etpEnsureProtectionLists() : null;
    const result = await etpRunChrome(
      ETP_SET_MODE_SCRIPT,
      {},
      etp,
      filterLists.length ? filterLists.map((list) => list.url).join("|") : null,
      ETP_EXCEPTION_OVERRIDES
    );
    // The configuration's prefs are applied now, even if a later step fails.
    etpCurrentMode = [
      etp,
      ...Object.keys(ETP_FILTER_LISTS).filter((n) => listNames.includes(n)),
    ].join("+");
    // Read the list versions while Firefox downloads the lists; a failure only
    // leaves the version unknown.
    const listKeys = Object.keys(ETP_FILTER_LISTS).filter((n) =>
      listNames.includes(n)
    );
    const versions = Promise.all(
      listKeys.map((key) =>
        etpFetchListVersion(ETP_FILTER_LISTS[key].url).then(
          (version) => ({ key, version }),
          (e) => ({ key, version: null, error: String(e?.message ?? e) })
        )
      )
    );
    if (filterLists.length) {
      await etpWaitForFilterLists(filterLists);
    }
    const listVersions = await versions;
    for (const { key, version } of listVersions) {
      etpFilterListVersions[key] = version;
    }
    if (listVersions.length) {
      await etpUpdateContentBlockingLogFile((logs) => {
        logs.filterListVersions = { ...etpFilterListVersions };
      });
    }
    const { failedFlags } = await etpRunChrome(ETP_CLEAR_DATA_SCRIPT, {
      isAsync: true,
    });
    if (failedFlags) {
      throw new Error(
        `Clearing cookies, site data and caches failed (flags ${failedFlags})`
      );
    }
    const privateWindow = ETP_PRIVATE ? await etpOpenPrivateWindow() : null;
    const changed = Object.entries(result.changed);
    return successResponse(
      `ETP category is now ${result.category}. ` +
        (changed.length
          ? "Prefs off their Standard values:\n" +
            changed
              .map(
                ([p, { value, standard }]) =>
                  `${p} = ${JSON.stringify(value)} (Standard: ${JSON.stringify(
                    standard
                  )})`
              )
              .join("\n") +
            "\n"
          : "All of its prefs are at their Standard values.\n") +
        etpDescribeExceptions(result.exceptions) +
        (lists
          ? `Tracker lists updated ${new Date(
              Number(lists.lists.lastUpdate)
            ).toISOString()}; ${
              lists.exceptionList.exceptions
            } ETP exception records.\n`
          : "") +
        (filterLists.length
          ? `Also blocking with ${filterLists
              .map((list, i) => {
                const { version, error } = listVersions[i];
                return (
                  `the ${list.name} list (${list.url}, version ` +
                  `${version ?? `unknown: ${error ?? "no ! Version: header"}`})`
                );
              })
              .join(" and ")} in the content classifier, next to whatever ` +
            "the category blocks; they are loaded and blocking. Resources they block show as STATE_BLOCKED_TRACKING_CONTENT " +
            "(or STATE_REPLACED_TRACKING_CONTENT when shimmed), and the skip-URL prefs don't lift them.\n"
          : "") +
        `Content classifier engines: ${result.engines || "(none)"} (Private ` +
        `Browsing: ${result.enginesPbmode || "(none)"}, mirror mode ` +
        `${result.mirrorMode}); URL classifier ${
          result.urlClassifierOn ? "on" : "skipped"
        }.\n` +
        "Cleared cookies, site data and caches, so the next load is a first visit.\n" +
        (privateWindow
          ? "Closed the previous private window" +
            (privateWindow.sessionEnded
              ? ""
              : " (its session was not seen to end)") +
            " and opened a fresh one; its tab is now the selected page. Test " +
            "in it: load the URL there with navigate_page, and don't select " +
            "another page.\n"
          : "") +
        "Reload the page (navigate_page) for the change to apply to it."
    );
  } catch (error2) {
    return errorResponse(
      error2 instanceof Error ? error2 : new Error(String(error2))
    );
  }
}

// Decodes the selected page's content blocking log (its tab can be in a
// private window); the flag names come from nsIWebProgressListener so they stay
// correct across Firefox versions.
const ETP_CONTENT_BLOCKING_LOG_SCRIPT = `
  const done = arguments[arguments.length - 1];
  ${ETP_SELECTED_BROWSER_PREAMBLE}
  const L = Ci.nsIWebProgressListener;
  const names = Object.keys(L).filter((k) =>
    /^STATE_.*(BLOCKED|LOADED|REPLACED|ALLOWED|COOKIES|PARTITIONED)/.test(k)
  );
  Promise.resolve(browser.getContentBlockingLog())
    .then((raw) => {
      const log = JSON.parse(raw || "{}");
      const origins = {};
      for (const [origin, entries] of Object.entries(log)) {
        origins[origin] = entries.map(([state, blocked, count]) => ({
          flags: names.filter((k) => state & L[k]),
          blocked,
          count,
        }));
      }
      done({ url: browser.currentURI.spec, private: isPrivate, origins });
    })
    .catch((e) => done({ error: String(e) }));
`;

// Flags of a tracker request the classifier blocked, or replaced with a shim
// (which also keeps the tracker from loading). Not mixed-content, Safe Browsing
// or cookie blocking.
const ETP_BLOCKED_TRACKER_FLAG_RE =
  /^STATE_(BLOCKED|REPLACED)_(TRACKING|SOCIALTRACKING|EMAILTRACKING|FINGERPRINTING|CRYPTOMINING)_CONTENT$/;

// The origins in `origins` (as decoded by ETP_CONTENT_BLOCKING_LOG_SCRIPT)
// with a blocked tracker.
function etpBlockedTrackers(origins) {
  return Object.keys(origins).filter((origin) =>
    origins[origin].some((entry) =>
      entry.flags.some((flag) => ETP_BLOCKED_TRACKER_FLAG_RE.test(flag))
    )
  );
}

// The JSON file named by ETP_CONTENT_BLOCKING_LOG_FILE holds every log
// get_content_blocking_log returned, under the mode last set with
// set_etp_mode, and the versions of the filter lists set_etp_mode loaded:
// { [mode]: [{ time, url, private, blockedTrackers, origins }, ...],
//   filterListVersions: { easylist: "202611170830", ... } }. The agent then
// publishes the file with the run, so the full logs don't have to go through
// its context. Does nothing if the variable isn't set.
async function etpUpdateContentBlockingLogFile(update) {
  const path = process.env.ETP_CONTENT_BLOCKING_LOG_FILE;
  if (!path) {
    return;
  }
  const { readFile, writeFile } = await import("node:fs/promises");
  let logs = {};
  try {
    logs = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") {
      throw e;
    }
  }
  update(logs);
  await writeFile(path, JSON.stringify(logs, null, 2));
}

async function etpRecordContentBlockingLog(mode, result, blocked) {
  await etpUpdateContentBlockingLogFile((logs) => {
    (logs[mode] ??= []).push({
      time: new Date().toISOString(),
      url: result.url,
      private: result.private,
      blockedTrackers: blocked,
      origins: result.origins,
    });
  });
}

async function handleGetContentBlockingLog() {
  try {
    // Async, since getContentBlockingLog() may return a promise.
    const { getFirefox: getFirefox2 } = await Promise.resolve().then(
      () => (init_src(), src_exports)
    );
    const firefox3 = await getFirefox2();
    const result = await etpRunChrome(
      ETP_CONTENT_BLOCKING_LOG_SCRIPT,
      { isAsync: true },
      firefox3.getCurrentContextId()
    );
    if (result.error) {
      throw new Error(result.error);
    }
    const blocked = etpBlockedTrackers(result.origins);
    await etpRecordContentBlockingLog(etpCurrentMode, result, blocked);
    return successResponse(
      `Content blocking log for ${result.url}` +
        (result.private ? " (private window)" : "") +
        ":\n" +
        `Blocked trackers: ${blocked.length}` +
        (blocked.length ? ` (${blocked.join(", ")})` : "") +
        "\n" +
        JSON.stringify(result.origins, null, 2)
    );
  } catch (error2) {
    return errorResponse(
      error2 instanceof Error ? error2 : new Error(String(error2))
    );
  }
}

// navigate_page only waits for "interactive" (HTML parsed), before the
// scripts, iframes and widgets a page needs have loaded. Waiting inside
// evaluate_script instead fails: the bundle aborts every BiDi command after
// 10s. So poll document.readyState with short, separate commands until the
// load event, then give late scripts a moment. A page that never reaches
// "complete" is reported, not treated as an error: being stuck loading can be
// exactly the breakage under investigation.
const ETP_PAGE_STATE_EXPRESSION =
  "JSON.stringify({ readyState: document.readyState, url: location.href })";

async function handleWaitForPageLoad(args2) {
  try {
    const { timeoutSeconds = 30, settleSeconds = 2 } = args2 || {};
    const { getFirefox: getFirefox2 } = await Promise.resolve().then(
      () => (init_src(), src_exports)
    );
    const firefox3 = await getFirefox2();
    const started = Date.now();
    const deadline = started + timeoutSeconds * 1e3;
    let state = null;
    for (;;) {
      try {
        const result = await firefox3.sendBiDiCommand("script.evaluate", {
          expression: ETP_PAGE_STATE_EXPRESSION,
          target: { context: firefox3.getCurrentContextId() },
          awaitPromise: false,
        });
        if (result.type === "success") {
          state = JSON.parse(result.result.value);
        }
      } catch {
        // Mid-navigation the old document can go away under the command, and
        // a busy page can time it out; keep polling until the deadline.
      }
      if (
        (state && state.readyState === "complete") ||
        Date.now() >= deadline
      ) {
        break;
      }
      await new Promise((resolve2) => setTimeout(resolve2, 500));
    }
    const waited = ((Date.now() - started) / 1e3).toFixed(1);
    if (!state || state.readyState !== "complete") {
      return successResponse(
        `The page did not finish loading within ${timeoutSeconds}s: ` +
          `readyState is ${state ? `"${state.readyState}"` : "unknown"}` +
          (state ? ` at ${state.url}` : "") +
          ". If the report says the page is stuck loading, this is the breakage."
      );
    }
    await new Promise((resolve2) => setTimeout(resolve2, settleSeconds * 1e3));
    return successResponse(
      `The page finished loading after ${waited}s (${state.url}); waited ` +
        `${settleSeconds}s more for late scripts.`
    );
  } catch (error2) {
    return errorResponse(
      error2 instanceof Error ? error2 : new Error(String(error2))
    );
  }
}

var waitForPageLoadTool = {
  name: "wait_for_page_load",
  description:
    'Wait until the selected page has fully loaded (document.readyState is "complete"), then a little longer for late scripts. Call it after navigate_page and after clicks that load content, instead of waiting inside evaluate_script. Reports a page that never finishes loading instead of failing.',
  inputSchema: {
    type: "object",
    properties: {
      timeoutSeconds: {
        type: "number",
        description: "How long to wait for the load (default 30)",
      },
      settleSeconds: {
        type: "number",
        description: "Extra wait after the load for late scripts (default 2)",
      },
    },
  },
};

var setEtpModeTool = {
  name: "set_etp_mode",
  description:
    "Switch Enhanced Tracking Protection to a configuration at runtime (no restart): an ETP category (off, standard or strict) plus any of the EasyList and EasyPrivacy filter lists, all blocking at once. Firefox applies all of the category's prefs at once; the response lists the ones off their Standard values and the content classifier engines. \"off\" turns every tracker feature off and leaves cookies unrestricted. Filter lists block via the content classifier, next to the category's tracker lists, and the skip-URL prefs don't lift them; the switch waits until they are downloaded and blocking, and fails if they aren't. Switching to standard or strict fails with an error if the tracker lists or the ETP exception list can't be downloaded. Also clears all cookies, site data and caches, so the next load is a first visit (logins and site state are lost). In a Private Browsing run, it then closes the private window it opened last and opens a fresh one, whose tab becomes the selected page. The response gives each filter list's version. Reload the page afterwards. Requires MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1.",
  inputSchema: {
    type: "object",
    properties: {
      etp: {
        type: "string",
        enum: ETP_LEVELS,
        description: "ETP category to switch to",
      },
      filter_lists: {
        type: "array",
        items: { type: "string", enum: Object.keys(ETP_FILTER_LISTS) },
        description:
          "Filter lists to block with as well (default none): easylist (ads), easyprivacy (trackers)",
      },
    },
    required: ["etp"],
  },
};

var getContentBlockingLogTool = {
  name: "get_content_blocking_log",
  description:
    "Return the content blocking log of the selected tab: every third-party origin with its STATE_* flags (e.g. STATE_BLOCKED_SOCIALTRACKING_CONTENT names the feature that blocked it), headed by the number of blocked trackers: origins with a STATE_BLOCKED_* or STATE_REPLACED_* tracker flag. Does not change the selected page. Requires MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1.",
  inputSchema: { type: "object", properties: {} },
};
