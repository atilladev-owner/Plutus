/*
  Plutus site script. Shared across every page. Plain script, no modules, no build step.
  Four responsibilities: the theme toggle, the in page link handler, the copy control, and
  the live desk module that reads the public exchange endpoints.

  Money is always split from a string, never divided or parsed as a float: USDT carries six
  minor unit decimals, BTC and ETH carry eight.
*/
(function () {
  "use strict";

  var THEME_KEY = "plutus-theme";

  /* ---- Theme: applied immediately, before the rest of the page is parsed, so there is no
     flash of the wrong theme. Falls back to the system preference through CSS alone when
     storage is unavailable or nothing has been chosen yet. */

  function readStoredTheme() {
    try {
      var value = window.localStorage.getItem(THEME_KEY);
      return value === "light" || value === "dark" ? value : null;
    } catch (err) {
      return null;
    }
  }

  function writeStoredTheme(value) {
    try {
      if (value === null) window.localStorage.removeItem(THEME_KEY);
      else window.localStorage.setItem(THEME_KEY, value);
    } catch (err) {
      /* Storage unavailable: the choice applies to this load only. */
    }
  }

  function applyTheme(value) {
    var root = document.documentElement;
    if (value === null) root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", value);
  }

  function nextTheme(current) {
    if (current === "light") return "dark";
    if (current === "dark") return null;
    return "light";
  }

  function themeLabel(value) {
    if (value === "light") return "Light";
    if (value === "dark") return "Dark";
    return "System";
  }

  applyTheme(readStoredTheme());

  function initThemeToggle() {
    var button = document.querySelector("[data-theme-toggle]");
    if (!button) return;
    var label = button.querySelector("[data-role='theme-label']");
    var icons = button.querySelectorAll("[data-theme-icon]");

    function render(value) {
      var name = value === null ? "system" : value;
      if (label) label.textContent = themeLabel(value);
      icons.forEach(function (icon) {
        icon.hidden = icon.getAttribute("data-theme-icon") !== name;
      });
      button.setAttribute("aria-label", "Theme, currently " + themeLabel(value) + ". Activate to change it.");
    }

    render(readStoredTheme());
    button.addEventListener("click", function () {
      var next = nextTheme(readStoredTheme());
      writeStoredTheme(next);
      applyTheme(next);
      render(next);
    });
  }

  /* ---- In page links: replace the address instead of pushing a history entry, so the
     back button leaves the page rather than walking a stack of section jumps. */

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function initInPageLinks() {
    var links = document.querySelectorAll('a[href^="#"]');
    links.forEach(function (link) {
      link.addEventListener("click", function (event) {
        var hash = link.getAttribute("href");
        if (!hash || hash.length < 2) return;
        var target = document.getElementById(hash.slice(1));
        if (!target) return;
        event.preventDefault();
        target.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
        window.history.replaceState(null, "", hash);
      });
    });
  }

  /* ---- Copy control: copies the exact text in data-copy and shows "Copied" for two
     seconds, falling back to a hidden textarea when the async clipboard API is missing. */

  function legacyCopy(text) {
    try {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-1000px";
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch (err) {
      return false;
    }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return legacyCopy(text); },
      );
    }
    return Promise.resolve(legacyCopy(text));
  }

  function initCopyButtons() {
    var buttons = document.querySelectorAll("[data-copy]");
    buttons.forEach(function (button) {
      var label = button.querySelector("[data-role='copy-label']");
      var original = label ? label.textContent : null;
      var revertTimer = null;
      button.addEventListener("click", function () {
        var text = button.getAttribute("data-copy") || "";
        copyText(text).then(function (ok) {
          if (!ok) return;
          button.setAttribute("data-copied", "true");
          if (label) label.textContent = "Copied";
          if (revertTimer) window.clearTimeout(revertTimer);
          revertTimer = window.setTimeout(function () {
            button.removeAttribute("data-copied");
            if (label && original !== null) label.textContent = original;
          }, 2000);
        });
      });
    });
  }

  /* ---- Money, formatted from minor units by splitting the string. Never a division, never
     a float. Trailing zeros beyond two decimal places are trimmed, also by slicing, not by
     rounding a number. */

  function formatMinor(raw, decimals) {
    if (raw === null || raw === undefined) return null;
    var negative = raw.charAt(0) === "-";
    var digits = negative ? raw.slice(1) : raw;
    while (digits.length <= decimals) digits = "0" + digits;
    var whole = digits.slice(0, digits.length - decimals);
    var fraction = digits.slice(digits.length - decimals);
    var end = fraction.length;
    while (end > 2 && fraction.charAt(end - 1) === "0") end -= 1;
    fraction = fraction.slice(0, end);
    var grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (negative ? "-" : "") + grouped + "." + fraction;
  }

  function formatRelative(sinceMs, nowMs) {
    var deltaSeconds = Math.trunc((nowMs - sinceMs) / 1000);
    if (deltaSeconds < 1) return "just now";
    if (deltaSeconds < 60) return deltaSeconds + (deltaSeconds === 1 ? " second ago" : " seconds ago");
    var deltaMinutes = Math.trunc(deltaSeconds / 60);
    if (deltaMinutes < 60) return deltaMinutes + (deltaMinutes === 1 ? " minute ago" : " minutes ago");
    var deltaHours = Math.trunc(deltaMinutes / 60);
    return deltaHours + (deltaHours === 1 ? " hour ago" : " hours ago");
  }

  /* ---- The live desk: reads the public book, ticker and verify endpoints with fetch, no
     key required. Polls the book and ticker every five seconds while the tab is visible,
     verifies once per load, and treats a 429 on verify as a recent check rather than a
     failure. */

  function fetchJSON(url) {
    return fetch(url, { headers: { Accept: "application/json" } }).then(function (res) {
      return res
        .json()
        .catch(function () { return null; })
        .then(function (body) { return { status: res.status, ok: res.ok, body: body }; });
    });
  }

  function skeletonRows(count) {
    var out = "";
    for (var i = 0; i < count; i += 1) out += '<div class="skel skel-row"></div>';
    return out;
  }

  function flashRow(row) {
    row.setAttribute("data-changed", "true");
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () {
        row.removeAttribute("data-changed");
      });
    });
  }

  function renderLevels(container, levels, baseDecimals, quoteDecimals, previousMap, flash) {
    if (!levels || levels.length === 0) {
      container.innerHTML = '<p class="desk-empty">No resting orders on this side right now.</p>';
      return new Map();
    }
    var next = new Map();
    var fragment = document.createDocumentFragment();
    levels.forEach(function (level) {
      next.set(level.price, level.quantity);
      var changed = flash && previousMap !== null && (!previousMap.has(level.price) || previousMap.get(level.price) !== level.quantity);
      var row = document.createElement("div");
      row.className = "book-row";
      var price = document.createElement("span");
      price.className = "book-price";
      price.textContent = formatMinor(level.price, quoteDecimals);
      var quantity = document.createElement("span");
      quantity.className = "book-qty";
      quantity.textContent = formatMinor(level.quantity, baseDecimals);
      row.appendChild(price);
      row.appendChild(quantity);
      fragment.appendChild(row);
      if (changed) flashRow(row);
    });
    container.innerHTML = "";
    container.appendChild(fragment);
    return next;
  }

  function initLiveDesk() {
    var desk = document.querySelector("[data-live-desk]");
    if (!desk) return;

    var market = desk.getAttribute("data-market") || "BTC-USDT";
    var baseDecimals = Number(desk.getAttribute("data-base-decimals")) || 8;
    var quoteDecimals = Number(desk.getAttribute("data-quote-decimals")) || 6;

    var statusDot = desk.querySelector("[data-role='status-dot']");
    var statusText = desk.querySelector("[data-role='status-text']");
    var bidRows = desk.querySelector("[data-role='bid-rows']");
    var askRows = desk.querySelector("[data-role='ask-rows']");
    var tickerLast = desk.querySelector("[data-role='ticker-last']");
    var verifyText = desk.querySelector("[data-role='verify-text']");
    var updated = desk.querySelector("[data-role='desk-updated']");

    var bidMap = null;
    var askMap = null;
    var haveRead = false;
    var lastReadAt = null;
    var pollTimer = null;

    function setStatus(state, text) {
      if (statusDot) statusDot.setAttribute("data-state", state);
      if (statusText) statusText.textContent = text;
    }

    function showSkeleton() {
      if (bidRows) bidRows.innerHTML = skeletonRows(5);
      if (askRows) askRows.innerHTML = skeletonRows(5);
      if (tickerLast) tickerLast.innerHTML = '<span class="skel skel-line" style="width:110px"></span>';
      setStatus("loading", "Reading the book");
    }

    function updateRelativeTime() {
      if (!updated || lastReadAt === null) return;
      updated.textContent = "Last read " + formatRelative(lastReadAt, Date.now());
    }

    function renderFailure(reason) {
      setStatus("warn", "Read failed");
      if (bidRows) bidRows.innerHTML = '<p class="desk-failed">Could not read the book: ' + reason + '.</p>';
      if (askRows) askRows.innerHTML = "";
      if (tickerLast) tickerLast.textContent = "Unavailable";
    }

    function poll() {
      var flash = reducedMotion() ? false : true;
      Promise.all([
        fetchJSON("/v1/exchange/markets/" + market + "/book?depth=5"),
        fetchJSON("/v1/exchange/markets/" + market + "/ticker"),
      ]).then(function (results) {
        var bookRes = results[0];
        var tickerRes = results[1];
        if (!bookRes.ok || !bookRes.body) {
          renderFailure("the server answered " + bookRes.status);
          return;
        }
        var book = bookRes.body;
        bidMap = renderLevels(bidRows, book.bids, baseDecimals, quoteDecimals, haveRead ? bidMap : null, flash);
        askMap = renderLevels(askRows, book.asks, baseDecimals, quoteDecimals, haveRead ? askMap : null, flash);
        if (tickerRes.ok && tickerRes.body && tickerLast) {
          tickerLast.textContent = tickerRes.body.last === null
            ? "No trades yet"
            : formatMinor(tickerRes.body.last, quoteDecimals) + " USDT";
        } else if (tickerLast) {
          tickerLast.textContent = "Unavailable";
        }
        haveRead = true;
        lastReadAt = Date.now();
        setStatus("ok", "Live");
        updateRelativeTime();
      }, function (err) {
        renderFailure(err && err.message ? err.message : "a network error");
      });
    }

    function renderVerify(text) {
      if (!verifyText) return;
      verifyText.classList.remove("verify-ok", "verify-warn");
      verifyText.textContent = text.message;
      if (text.state === "ok") verifyText.classList.add("verify-ok");
      if (text.state === "warn") verifyText.classList.add("verify-warn");
    }

    function verifyOnce() {
      if (verifyText) verifyText.textContent = "Checking the chain now";
      fetchJSON("/v1/exchange/verify").then(function (res) {
        if (res.status === 429) {
          renderVerify({ state: "checked", message: "Checked recently, limited to two reads a minute" });
          return;
        }
        if (!res.ok || !res.body) {
          renderVerify({ state: "warn", message: "Could not verify: the server answered " + res.status });
          return;
        }
        if (res.body.ok) {
          renderVerify({ state: "ok", message: "Every asset sums to zero, " + res.body.entries_checked + " entries checked" });
        } else {
          renderVerify({ state: "warn", message: "Chain check failed at entry " + (res.body.first_bad_seq || "unknown") });
        }
      }, function (err) {
        renderVerify({ state: "warn", message: "Could not verify: " + (err && err.message ? err.message : "a network error") });
      });
    }

    showSkeleton();
    poll();
    verifyOnce();

    window.setInterval(updateRelativeTime, 1000);
    pollTimer = window.setInterval(function () {
      if (document.visibilityState === "visible") poll();
    }, 5000);

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") poll();
    });

    window.addEventListener("pagehide", function () {
      if (pollTimer) window.clearInterval(pollTimer);
    });
  }

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  ready(function () {
    initThemeToggle();
    initInPageLinks();
    initCopyButtons();
    initLiveDesk();
  });
})();
