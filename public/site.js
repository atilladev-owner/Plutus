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

  /* ---- Skip link target on /docs: the six plain pages set tabindex="-1" directly on
     #main in their own markup, but Scalar's mount point (#app) is rendered by the shared
     docs shell, so the same "you are now here" focus target is added here instead. A no-op
     on the six plain pages, which have no #app. */

  function initSkipLinkTarget() {
    var app = document.getElementById("app");
    if (app && !app.hasAttribute("tabindex")) app.setAttribute("tabindex", "-1");
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

  /* ---- Verify: shared between the live desk's own proof line and the standalone verify
     panel on the limits page, so the fetch and the reading of the response live in one
     place. A 429 reads as "checked recently" rather than a failure, since the public verify
     route is limited to two reads a minute per address. */

  function interpretVerify(res) {
    if (res.status === 429) {
      return { state: "checked", message: "Checked recently, limited to two reads a minute" };
    }
    if (!res.ok || !res.body) {
      return { state: "warn", message: "Could not verify: the server answered " + res.status };
    }
    if (res.body.ok) {
      return { state: "ok", message: "Every asset sums to zero, " + res.body.entries_checked + " entries checked" };
    }
    return { state: "warn", message: "Chain check failed at entry " + (res.body.first_bad_seq || "unknown") };
  }

  function checkVerify(url) {
    return fetchJSON(url).then(interpretVerify, function (err) {
      return { state: "warn", message: "Could not verify: " + (err && err.message ? err.message : "a network error") };
    });
  }

  function skeletonRows(count) {
    var out = "";
    for (var i = 0; i < count; i += 1) out += '<div class="skel skel-row"></div>';
    return out;
  }

  function skeletonTradeRows(count) {
    var out = "";
    for (var i = 0; i < count; i += 1) {
      out += '<tr class="trade-row skel-trade-row"><td colspan="4"><span class="skel skel-line"></span></td></tr>';
    }
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
    var relativeTimer = null;

    function setStatus(state, text) {
      if (statusDot) statusDot.setAttribute("data-state", state);
      if (statusText) statusText.textContent = text;
    }

    function showSkeleton() {
      if (bidRows) bidRows.innerHTML = skeletonRows(5);
      if (askRows) askRows.innerHTML = skeletonRows(5);
      if (tickerLast) tickerLast.innerHTML = '<span class="skel skel-line"></span>';
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
      verifyText.classList.remove("verify-ok", "verify-warn", "verify-checked");
      verifyText.textContent = text.message;
      if (text.state === "ok") verifyText.classList.add("verify-ok");
      if (text.state === "warn") verifyText.classList.add("verify-warn");
      // A 429 is "checked recently", not a failure: styled explicitly rather than left to
      // inherit its parent's muted colour by default.
      if (text.state === "checked") verifyText.classList.add("verify-checked");
    }

    function verifyOnce() {
      if (verifyText) verifyText.textContent = "Checking the chain now";
      checkVerify("/v1/exchange/verify").then(renderVerify);
    }

    function startTimers() {
      if (!relativeTimer) relativeTimer = window.setInterval(updateRelativeTime, 1000);
      if (!pollTimer) {
        pollTimer = window.setInterval(function () {
          if (document.visibilityState === "visible") poll();
        }, 5000);
      }
    }

    showSkeleton();
    poll();
    verifyOnce();
    startTimers();

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") poll();
    });

    window.addEventListener("pagehide", function () {
      if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
      if (relativeTimer) { window.clearInterval(relativeTimer); relativeTimer = null; }
    });

    window.addEventListener("pageshow", function () {
      startTimers();
    });
  }

  /* ---- The standalone verify panel on the limits page: the same public proof the desk's
     own proof line shows, run once per load, with no book or ticker beside it. */

  function initVerifyPanel() {
    var panel = document.querySelector("[data-verify-panel]");
    if (!panel) return;
    var dot = panel.querySelector("[data-role='verify-panel-dot']");
    var status = panel.querySelector("[data-role='verify-panel-status']");
    var text = panel.querySelector("[data-role='verify-panel-text']");

    if (status) status.textContent = "Checking";
    if (text) text.textContent = "Checking the chain now";

    checkVerify("/v1/exchange/verify").then(function (result) {
      if (text) {
        text.classList.remove("verify-ok", "verify-warn", "verify-checked");
        text.textContent = result.message;
        if (result.state === "ok") text.classList.add("verify-ok");
        if (result.state === "warn") text.classList.add("verify-warn");
        // A 429 is "checked recently", not a failure: styled explicitly rather than left
        // to inherit its parent's muted colour by default.
        if (result.state === "checked") text.classList.add("verify-checked");
      }
      if (dot) dot.setAttribute("data-state", result.state === "warn" ? "warn" : "ok");
      if (status) status.textContent = result.state === "warn" ? "Failed" : "Live";
    });
  }

  /* ---- The exchange page's board: extends the desk module above rather than duplicating
     its fetch or formatting logic. formatMinor, fetchJSON, renderLevels, skeletonRows,
     formatRelative and reducedMotion are the exact functions the home page's live desk
     already uses; this module only adds the orchestration the exchange page needs beyond a
     single five level book: ten levels a side, a fuller ticker strip, the last twenty
     trades, a candles chart drawn as SVG, a market switcher that re points every reader at
     once, and the public event stream read live through EventSource. */

  var MARKET_DECIMALS = {
    "BTC-USDT": { base: 8, quote: 6 },
    "ETH-USDT": { base: 8, quote: 6 },
  };

  function decimalsFor(market) {
    return MARKET_DECIMALS[market] || { base: 8, quote: 6 };
  }

  function baseOf(market) { return market.split("-")[0]; }
  function quoteOf(market) { return market.split("-")[1]; }

  function renderCandles(figure, candles, decimals, market) {
    if (!figure) return;
    if (!candles || candles.length === 0) {
      figure.innerHTML = '<p class="desk-empty">No trades yet to draw candles from.</p>';
      return;
    }
    var ordered = candles.slice().reverse();
    var highs = ordered.map(function (c) { return BigInt(c.high); });
    var lows = ordered.map(function (c) { return BigInt(c.low); });
    var maxPrice = highs[0];
    var minPrice = lows[0];
    for (var i = 1; i < ordered.length; i += 1) {
      if (highs[i] > maxPrice) maxPrice = highs[i];
      if (lows[i] < minPrice) minPrice = lows[i];
    }
    var width = 640;
    var height = 260;
    // Wide enough for a six figure whole number plus its fraction ("100,223.32"), the
    // longest a grid label plausibly gets, right anchored 8px in from this margin's edge.
    var marginLeft = 96;
    var marginRight = 12;
    // Room for the one axis title above the plot: a unit appended to all five grid labels
    // was wide enough, past "80,223.32 USDT", to clip past the SVG's own left edge under
    // text-anchor="end", so the unit is named once here instead.
    var marginTop = 26;
    var marginBottom = 12;
    var chartWidth = width - marginLeft - marginRight;
    var chartHeight = height - marginTop - marginBottom;
    // A zero price range (every candle at the same price, most often because there is only
    // one candle so far) would otherwise draw all five grid lines on top of one another at
    // the same value: padded half a percent of the price each side purely for the axis, so
    // the lines read as distinct prices around the flat one rather than five copies of it.
    // The candle body itself still draws from the real, unpadded price. A span too small to
    // change the market's own formatted string reads exactly the same way to a viewer (five
    // grid lines all labelled the identical price), so it is treated as flat too, rather
    // than only an exact zero span.
    var flat = formatMinor(minPrice.toString(), decimals.quote) === formatMinor(maxPrice.toString(), decimals.quote);
    var pad = flat ? (maxPrice / 200n === 0n ? 1n : maxPrice / 200n) : 0n;
    var axisMax = maxPrice + pad;
    var axisMin = minPrice - pad;
    var span = axisMax - axisMin;
    var spanNumber = Number(span);

    function yFor(priceStr) {
      var offset = Number(axisMax - BigInt(priceStr));
      return marginTop + (offset / spanNumber) * chartHeight;
    }

    var count = ordered.length;
    var slot = chartWidth / count;
    var bodyWidth = slot * 0.6;
    var quoteUnit = quoteOf(market);

    // The axis title, named once, rather than repeating the unit on all five grid labels
    // (which clipped past the chart's left edge on a wide price: see marginTop above).
    var gridLines = '<text x="' + marginLeft + '" y="16" style="font-family: var(--font-mono); font-size: 11px; fill: var(--muted);">Price, ' + quoteUnit + '</text>';
    var gridSteps = 4;
    for (var g = 0; g <= gridSteps; g += 1) {
      var gy = marginTop + (g / gridSteps) * chartHeight;
      var priceAtLine = axisMax - (span * BigInt(g)) / BigInt(gridSteps);
      gridLines += '<line x1="' + marginLeft + '" y1="' + gy + '" x2="' + (width - marginRight) + '" y2="' + gy + '" style="stroke: var(--data-2); stroke-width: 1;"></line>';
      gridLines += '<text x="' + (marginLeft - 8) + '" y="' + (gy + 4) + '" text-anchor="end" style="font-family: var(--font-mono); font-size: 11px; fill: var(--muted);">' + formatMinor(priceAtLine.toString(), decimals.quote) + '</text>';
    }

    var bars = "";
    ordered.forEach(function (c, idx) {
      var x = marginLeft + idx * slot + (slot - bodyWidth) / 2;
      var openY = yFor(c.open);
      var closeY = yFor(c.close);
      var highY = yFor(c.high);
      var lowY = yFor(c.low);
      var up = BigInt(c.close) >= BigInt(c.open);
      var color = up ? "var(--accent)" : "var(--ink)";
      var top = Math.min(openY, closeY);
      var bodyHeight = Math.max(Math.abs(closeY - openY), 1.5);
      var cx = x + bodyWidth / 2;
      bars += '<line x1="' + cx + '" y1="' + highY + '" x2="' + cx + '" y2="' + lowY + '" style="stroke: ' + color + '; stroke-width: 1;"></line>';
      bars += '<rect x="' + x + '" y="' + top + '" width="' + bodyWidth + '" height="' + bodyHeight + '" style="fill: ' + color + ';"></rect>';
    });

    var svg = '<svg class="candles-chart" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-labelledby="candles-title" xmlns="http://www.w3.org/2000/svg">'
      + '<title id="candles-title">One minute candles for ' + market + ', the most recent ' + count + ' minutes</title>'
      + gridLines + bars
      + '</svg>';
    // A truly flat range (most often exactly one candle so far) reads oddly as "ranging
    // from X to X"; said plainly instead, at the one price every candle here actually
    // traded at.
    var caption = flat
      ? '<figcaption class="diagram-caption">One candle so far for ' + market + ', at '
        + formatMinor(maxPrice.toString(), decimals.quote) + ' ' + quoteUnit + '.</figcaption>'
      : '<figcaption class="diagram-caption">' + count + ' one minute candles for ' + market
        + ', accent for up and ink for down, ranging from ' + formatMinor(minPrice.toString(), decimals.quote)
        + ' to ' + formatMinor(maxPrice.toString(), decimals.quote) + ' ' + quoteUnit + '.</figcaption>';
    figure.innerHTML = svg + caption;
  }

  function initExchangeBoard() {
    var root = document.querySelector("[data-exchange-page]");
    if (!root) return;

    var switches = document.querySelectorAll("[data-market-switch]");
    var marketLabel = document.querySelector("[data-role='board-market-label']");
    var boardStatusDot = document.querySelector("[data-role='board-status-dot']");
    var boardStatusText = document.querySelector("[data-role='board-status-text']");
    var bidRows = document.querySelector("[data-role='bid-rows']");
    var askRows = document.querySelector("[data-role='ask-rows']");
    var boardUpdated = document.querySelector("[data-role='board-updated']");
    var statLast = document.querySelector("[data-role='stat-last']");
    var statHigh = document.querySelector("[data-role='stat-high']");
    var statLow = document.querySelector("[data-role='stat-low']");
    var statBaseVol = document.querySelector("[data-role='stat-base-vol']");
    var statQuoteVol = document.querySelector("[data-role='stat-quote-vol']");
    var tradesBody = document.querySelector("[data-role='trades-body']");
    var candlesFigure = document.querySelector("[data-role='candles-figure']");
    var candlesStatusDot = document.querySelector("[data-role='candles-status-dot']");
    var candlesStatusText = document.querySelector("[data-role='candles-status-text']");
    var streamStatusDot = document.querySelector("[data-role='stream-status-dot']");
    var streamStatusText = document.querySelector("[data-role='stream-status-text']");
    var streamCount = document.querySelector("[data-role='stream-count']");
    var streamCode = document.querySelector("[data-role='stream-code']");
    var streamCopyBtn = document.querySelector("[data-role='stream-copy']");

    var currentMarket = root.getAttribute("data-market") || "BTC-USDT";
    var bidMap = null;
    var askMap = null;
    var haveRead = false;
    var lastReadAt = null;
    var pollTimer = null;
    var boardTimeTimer = null;
    var eventSource = null;
    var eventsReceived = 0;

    function setBoardStatus(state, text) {
      if (boardStatusDot) boardStatusDot.setAttribute("data-state", state);
      if (boardStatusText) boardStatusText.textContent = text;
    }

    function showBoardSkeleton() {
      if (bidRows) bidRows.innerHTML = skeletonRows(10);
      if (askRows) askRows.innerHTML = skeletonRows(10);
      if (tradesBody) tradesBody.innerHTML = skeletonTradeRows(6);
      // Every one of these carries a static "Needs JavaScript" default in the markup, for
      // the no script case: with the script running, that text must never be visible even
      // for a moment, so all five swap to a skeleton here, synchronously, before the first
      // fetch this module makes.
      [statLast, statHigh, statLow, statBaseVol, statQuoteVol].forEach(function (el) {
        if (el) { el.innerHTML = '<span class="skel skel-line"></span>'; el.classList.remove("value-warn"); }
      });
      if (candlesFigure) candlesFigure.innerHTML = '<p class="desk-empty">Reading candles</p>';
      setBoardStatus("loading", "Reading the book");
    }

    function updateBoardTime() {
      if (!boardUpdated || lastReadAt === null) return;
      boardUpdated.textContent = "Last read " + formatRelative(lastReadAt, Date.now());
    }

    function renderBoardFailure(reason) {
      setBoardStatus("warn", "Read failed");
      if (bidRows) bidRows.innerHTML = '<p class="desk-failed">Could not read the book: ' + reason + '.</p>';
      if (askRows) askRows.innerHTML = "";
    }

    // Ticker and trades each fail on their own terms, in --warn with the reason, exactly
    // like the book above: a book read succeeding does not mean the ticker or the trades
    // read did too, so each gets its own failed state rather than silently keeping
    // whatever it last showed.
    function renderTickerFailure(reason) {
      var text = "Could not read: " + reason + ".";
      [statLast, statHigh, statLow, statBaseVol, statQuoteVol].forEach(function (el) {
        if (el) { el.textContent = text; el.classList.add("value-warn"); }
      });
    }

    function renderTradesFailure(reason) {
      if (!tradesBody) return;
      tradesBody.innerHTML = '<tr class="trade-row"><td colspan="4" class="desk-failed">Could not read trades: ' + reason + '.</td></tr>';
    }

    function renderTicker(ticker, decimals, market) {
      var quote = quoteOf(market);
      var base = baseOf(market);
      [statLast, statHigh, statLow, statBaseVol, statQuoteVol].forEach(function (el) {
        if (el) el.classList.remove("value-warn");
      });
      if (statLast) statLast.textContent = ticker.last === null ? "No trades yet" : formatMinor(ticker.last, decimals.quote) + " " + quote;
      if (statHigh) statHigh.textContent = ticker.high_24h === null ? "No trades yet" : formatMinor(ticker.high_24h, decimals.quote) + " " + quote;
      if (statLow) statLow.textContent = ticker.low_24h === null ? "No trades yet" : formatMinor(ticker.low_24h, decimals.quote) + " " + quote;
      if (statBaseVol) statBaseVol.textContent = ticker.base_volume_24h === null ? "No trades yet" : formatMinor(ticker.base_volume_24h, decimals.base) + " " + base;
      if (statQuoteVol) statQuoteVol.textContent = ticker.quote_volume_24h === null ? "No trades yet" : formatMinor(ticker.quote_volume_24h, decimals.quote) + " " + quote;
    }

    function renderTrades(trades, decimals, market) {
      if (!tradesBody) return;
      if (!trades || trades.length === 0) {
        tradesBody.innerHTML = '<tr class="trade-row"><td colspan="4">No trades yet on this market.</td></tr>';
        return;
      }
      var quote = quoteOf(market);
      var base = baseOf(market);
      var now = Date.now();
      var rows = trades.map(function (t) {
        var when = formatRelative(new Date(t.created_at).getTime(), now);
        return "<tr class=\"trade-row\"><td>" + when + "</td><td class=\"mono\">" + formatMinor(t.price, decimals.quote) + " " + quote
          + "</td><td class=\"mono\">" + formatMinor(t.quantity, decimals.base) + " " + base
          + "</td><td class=\"mono\">" + formatMinor(t.notional, decimals.quote) + " " + quote + "</td></tr>";
      });
      tradesBody.innerHTML = rows.join("");
    }

    function pollBoard() {
      var market = currentMarket;
      var decimals = decimalsFor(market);
      var flash = reducedMotion() ? false : true;
      Promise.all([
        fetchJSON("/v1/exchange/markets/" + market + "/book?depth=10"),
        fetchJSON("/v1/exchange/markets/" + market + "/ticker"),
        fetchJSON("/v1/exchange/markets/" + market + "/trades?limit=20"),
      ]).then(function (results) {
        if (market !== currentMarket) return;
        var bookRes = results[0];
        var tickerRes = results[1];
        var tradesRes = results[2];
        // Ticker and trades read and fail independently of the book: a book read
        // succeeding says nothing about whether the other two did.
        if (tickerRes.ok && tickerRes.body) renderTicker(tickerRes.body, decimals, market);
        else renderTickerFailure("the server answered " + tickerRes.status);
        if (tradesRes.ok && tradesRes.body) renderTrades(tradesRes.body.data, decimals, market);
        else renderTradesFailure("the server answered " + tradesRes.status);
        if (!bookRes.ok || !bookRes.body) {
          renderBoardFailure("the server answered " + bookRes.status);
          return;
        }
        bidMap = renderLevels(bidRows, bookRes.body.bids, decimals.base, decimals.quote, haveRead ? bidMap : null, flash);
        askMap = renderLevels(askRows, bookRes.body.asks, decimals.base, decimals.quote, haveRead ? askMap : null, flash);
        haveRead = true;
        lastReadAt = Date.now();
        setBoardStatus("ok", "Live");
        updateBoardTime();
      }, function (err) {
        var reason = err && err.message ? err.message : "a network error";
        renderBoardFailure(reason);
        renderTickerFailure(reason);
        renderTradesFailure(reason);
      });
    }

    function pollCandles() {
      var market = currentMarket;
      var decimals = decimalsFor(market);
      if (candlesStatusDot) candlesStatusDot.setAttribute("data-state", "loading");
      if (candlesStatusText) candlesStatusText.textContent = "Reading candles";
      fetchJSON("/v1/exchange/markets/" + market + "/candles?interval=1m&limit=60").then(function (res) {
        if (market !== currentMarket) return;
        if (!res.ok || !res.body) {
          if (candlesFigure) candlesFigure.innerHTML = '<p class="desk-failed">Could not read candles: the server answered ' + res.status + '.</p>';
          if (candlesStatusDot) candlesStatusDot.setAttribute("data-state", "warn");
          if (candlesStatusText) candlesStatusText.textContent = "Read failed";
          return;
        }
        renderCandles(candlesFigure, res.body.data, decimals, market);
        if (candlesStatusDot) candlesStatusDot.setAttribute("data-state", "ok");
        if (candlesStatusText) candlesStatusText.textContent = "Live";
      }, function (err) {
        if (candlesFigure) candlesFigure.innerHTML = '<p class="desk-failed">Could not read candles: ' + (err && err.message ? err.message : "a network error") + '.</p>';
        if (candlesStatusDot) candlesStatusDot.setAttribute("data-state", "warn");
        if (candlesStatusText) candlesStatusText.textContent = "Read failed";
      });
    }

    function closeStream() {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    }

    function updateStreamCode() {
      var display = 'const stream = new EventSource(\n  "/v1/exchange/stream?channels=book:' + currentMarket + ',trades:' + currentMarket + '&since=0"\n);\nstream.onmessage = (event) => {\n  const { channel, seq, data } = JSON.parse(event.data);\n};';
      if (streamCode) streamCode.textContent = display;
      if (streamCopyBtn) streamCopyBtn.setAttribute("data-copy", display);
    }

    function openStream() {
      closeStream();
      eventsReceived = 0;
      if (streamCount) streamCount.textContent = "0";
      if (!window.EventSource) {
        if (streamStatusDot) streamStatusDot.setAttribute("data-state", "warn");
        if (streamStatusText) streamStatusText.textContent = "This browser does not support EventSource";
        return;
      }
      if (streamStatusDot) streamStatusDot.setAttribute("data-state", "loading");
      if (streamStatusText) streamStatusText.textContent = "Connecting";
      var url = "/v1/exchange/stream?channels=book:" + currentMarket + ",trades:" + currentMarket + "&since=0";
      var source = new EventSource(url);
      eventSource = source;
      source.addEventListener("open", function () {
        if (streamStatusDot) streamStatusDot.setAttribute("data-state", "ok");
        if (streamStatusText) streamStatusText.textContent = "Live";
      });
      source.addEventListener("message", function () {
        eventsReceived += 1;
        if (streamCount) streamCount.textContent = String(eventsReceived);
      });
      source.addEventListener("reconnect", function () {
        if (streamStatusText) streamStatusText.textContent = "Reconnecting after the five minute limit";
      });
      source.addEventListener("error", function () {
        if (streamStatusDot) streamStatusDot.setAttribute("data-state", "warn");
        if (streamStatusText) streamStatusText.textContent = "Stream read failed, the browser will retry";
      });
    }

    function setMarket(market) {
      currentMarket = market;
      switches.forEach(function (btn) {
        var isActive = btn.getAttribute("data-market-switch") === market;
        btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
      if (marketLabel) marketLabel.textContent = market;
      bidMap = null;
      askMap = null;
      haveRead = false;
      showBoardSkeleton();
      pollBoard();
      pollCandles();
      updateStreamCode();
      openStream();
    }

    switches.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var market = btn.getAttribute("data-market-switch");
        if (market && market !== currentMarket) setMarket(market);
      });
    });

    function startTimers() {
      if (!boardTimeTimer) boardTimeTimer = window.setInterval(updateBoardTime, 1000);
      if (!pollTimer) {
        pollTimer = window.setInterval(function () {
          if (document.visibilityState === "visible") { pollBoard(); pollCandles(); }
        }, 5000);
      }
    }

    showBoardSkeleton();
    pollBoard();
    pollCandles();
    updateStreamCode();
    openStream();
    startTimers();

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") { pollBoard(); pollCandles(); }
    });

    window.addEventListener("pagehide", function () {
      if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
      if (boardTimeTimer) { window.clearInterval(boardTimeTimer); boardTimeTimer = null; }
      closeStream();
    });

    window.addEventListener("pageshow", function () {
      startTimers();
    });
  }

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  ready(function () {
    initThemeToggle();
    initSkipLinkTarget();
    initInPageLinks();
    initCopyButtons();
    initLiveDesk();
    initExchangeBoard();
    initVerifyPanel();
  });
})();
