const API_URL = "https://api.hyperliquid.xyz/info";
const REFRESH_MS = 30 * 60 * 1000;
const STORE_WALLETS = "hlwr.wallets";
const STORE_HISTORY = "hlwr.history";
const STORE_THEME = "hlwr.theme";

const els = {
  statusLine: document.querySelector("#statusLine"),
  liveDot: document.querySelector("#liveDot"),
  refreshNow: document.querySelector("#refreshNow"),
  addWallet: document.querySelector("#addWallet"),
  walletForm: document.querySelector("#walletForm"),
  walletAlias: document.querySelector("#walletAlias"),
  walletAddress: document.querySelector("#walletAddress"),
  walletList: document.querySelector("#walletList"),
  watchlistCount: document.querySelector("#watchlistCount"),
  clearLocal: document.querySelector("#clearLocal"),
  trackedWallets: document.querySelector("#trackedWallets"),
  activeWallets: document.querySelector("#activeWallets"),
  netExposure: document.querySelector("#netExposure"),
  longExposure: document.querySelector("#longExposure"),
  shortExposure: document.querySelector("#shortExposure"),
  longDelta: document.querySelector("#longDelta"),
  shortDelta: document.querySelector("#shortDelta"),
  longShare: document.querySelector("#longShare"),
  shortShare: document.querySelector("#shortShare"),
  exposureMix: document.querySelector("#exposureMix"),
  snapshotMeta: document.querySelector("#snapshotMeta"),
  marketOi: document.querySelector("#marketOi"),
  marketFunding: document.querySelector("#marketFunding"),
  topOiList: document.querySelector("#topOiList"),
  deltaRows: document.querySelector("#deltaRows"),
  alertTape: document.querySelector("#alertTape"),
  apiHealth: document.querySelector("#apiHealth"),
  apiLatency: document.querySelector("#apiLatency"),
  dataAge: document.querySelector("#dataAge"),
  healthBar: document.querySelector("#healthBar"),
  searchBox: document.querySelector("#searchBox"),
  exportCsv: document.querySelector("#exportCsv"),
  chart: document.querySelector("#exposureChart"),
  themeToggle: document.querySelector("#themeToggle"),
};

const state = {
  watchlist: [],
  snapshot: null,
  history: [],
  filter: "all",
  query: "",
  latency: null,
};

init();

async function init() {
  applyTheme(localStorage.getItem(STORE_THEME) || "light");
  bindEvents();
  await loadBootstrapData();
  await refreshLiveData(false);
  setInterval(() => refreshLiveData(false), REFRESH_MS);
}

function bindEvents() {
  els.refreshNow.addEventListener("click", () => refreshLiveData(true));
  els.addWallet.addEventListener("click", () => {
    els.walletForm.hidden = !els.walletForm.hidden;
    if (!els.walletForm.hidden) els.walletAlias.focus();
  });
  els.walletForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const alias = els.walletAlias.value.trim() || "Smart Wallet";
    const address = normalizeAddress(els.walletAddress.value);
    if (!isAddress(address)) {
      setStatus("地址格式不正確，請輸入 42 字元 0x 開頭地址。", true);
      return;
    }
    upsertWallet({ alias, address, enabled: true, source: "local" });
    els.walletAlias.value = "";
    els.walletAddress.value = "";
    els.walletForm.hidden = true;
    saveLocalWallets();
    refreshLiveData(true);
  });
  els.clearLocal.addEventListener("click", () => {
    localStorage.removeItem(STORE_WALLETS);
    state.watchlist = state.watchlist.filter((wallet) => wallet.source !== "local");
    renderAll();
  });
  els.searchBox.addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLowerCase();
    renderTable();
  });
  document.querySelectorAll(".segmented button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".segmented button").forEach((item) => item.classList.remove("is-selected"));
      button.classList.add("is-selected");
      state.filter = button.dataset.filter;
      renderTable();
    });
  });
  els.exportCsv.addEventListener("click", exportCsv);
  els.themeToggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
  });
}

async function loadBootstrapData() {
  const [watchlist, latest, history] = await Promise.allSettled([
    fetchJson("./data/watchlist.json"),
    fetchJson("./data/latest.json"),
    fetchJson("./data/history.json"),
  ]);

  const fileWallets = watchlist.status === "fulfilled" ? watchlist.value.wallets || [] : [];
  const localWallets = readLocalWallets();
  state.watchlist = dedupeWallets([
    ...fileWallets.filter((wallet) => wallet.enabled !== false).map((wallet) => ({ ...wallet, source: "repo" })),
    ...localWallets.map((wallet) => ({ ...wallet, source: "local" })),
  ]);

  if (latest.status === "fulfilled" && latest.value?.generatedAt) {
    state.snapshot = latest.value;
  }

  if (history.status === "fulfilled" && Array.isArray(history.value)) {
    state.history = history.value;
  } else {
    state.history = readHistory();
  }

  renderAll();
}

async function refreshLiveData(manual) {
  try {
    setStatus(manual ? "正在手動刷新 Hyperliquid API..." : "背景刷新 Hyperliquid API 中...");
    const start = performance.now();
    const market = await fetchMarket();
    state.latency = Math.round(performance.now() - start);

    const enabledWallets = state.watchlist.filter((wallet) => wallet.enabled !== false);
    const previous = state.snapshot;
    const wallets = await Promise.all(enabledWallets.map((wallet) => fetchWallet(wallet, previous)));
    const snapshot = buildSnapshot(wallets, market, previous);
    state.snapshot = snapshot;
    state.history = appendHistory(state.history, snapshot);
    saveHistory(state.history);
    renderAll();
    setStatus(`已更新：${formatDateTime(snapshot.generatedAt)}，下一次約 30 分鐘後。`);
  } catch (error) {
    console.error(error);
    const hasSnapshot = Boolean(state.snapshot?.generatedAt);
    setStatus(
      hasSnapshot
        ? `已使用最新 repo 快照；瀏覽器即時 API 讀取失敗：${error.message}`
        : `API 讀取失敗：${error.message}`,
      true,
    );
    els.apiHealth.textContent = hasSnapshot ? "Repo snapshot active" : "API error";
    els.liveDot.classList.add("is-warn");
  }
}

async function fetchMarket() {
  const payload = await postInfo({ type: "metaAndAssetCtxs" });
  const meta = payload?.[0] || { universe: [] };
  const contexts = payload?.[1] || [];
  const rows = meta.universe.map((asset, index) => {
    const ctx = contexts[index] || {};
    const markPx = toNumber(ctx.markPx || ctx.midPx || ctx.oraclePx);
    const openInterest = toNumber(ctx.openInterest);
    const oiUsd = Math.abs(openInterest * markPx);
    return {
      coin: asset.name,
      markPx,
      openInterest,
      oiUsd,
      funding: toNumber(ctx.funding),
    };
  });
  const totalOiUsd = sum(rows.map((row) => row.oiUsd));
  const topOi = rows
    .filter((row) => row.oiUsd > 0)
    .sort((a, b) => b.oiUsd - a.oiUsd)
    .slice(0, 6);
  const avgFunding = avg(rows.filter((row) => Number.isFinite(row.funding)).map((row) => row.funding));
  return { totalOiUsd, topOi, avgFunding, prices: Object.fromEntries(rows.map((row) => [row.coin, row.markPx])) };
}

async function fetchWallet(wallet, previousSnapshot) {
  const [account, fills] = await Promise.all([
    postInfo({ type: "clearinghouseState", user: wallet.address }),
    postInfo({
      type: "userFillsByTime",
      user: wallet.address,
      startTime: Date.now() - REFRESH_MS,
      aggregateByTime: true,
    }).catch(() => []),
  ]);
  const previousWallet = previousSnapshot?.wallets?.find(
    (item) => item.address.toLowerCase() === wallet.address.toLowerCase(),
  );
  return normalizeWallet(wallet, account, fills, previousWallet);
}

async function postInfo(body) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Hyperliquid API ${response.status}`);
  return response.json();
}

function normalizeWallet(wallet, account, fills, previousWallet) {
  const positions = (account.assetPositions || [])
    .map((item) => {
      const pos = item.position || item;
      const coin = pos.coin;
      const size = toNumber(pos.szi);
      const side = size >= 0 ? "long" : "short";
      const notional = Math.abs(toNumber(pos.positionValue || pos.notionalValue));
      const previousPosition = previousWallet?.positions?.find((old) => old.coin === coin);
      const prevSize = previousPosition?.size || 0;
      const prevNotional = previousPosition?.notional || 0;
      return {
        coin,
        side,
        size,
        entryPx: toNumber(pos.entryPx),
        leverage: pos.leverage?.value || pos.leverage || null,
        liquidationPx: toNumber(pos.liquidationPx),
        notional,
        unrealizedPnl: toNumber(pos.unrealizedPnl),
        returnOnEquity: toNumber(pos.returnOnEquity),
        deltaSize: size - prevSize,
        deltaNotional: notional - prevNotional,
      };
    })
    .filter((pos) => Math.abs(pos.size) > 0);

  const longExposure = sum(positions.filter((pos) => pos.side === "long").map((pos) => pos.notional));
  const shortExposure = sum(positions.filter((pos) => pos.side === "short").map((pos) => pos.notional));
  const previousLong = previousWallet?.longExposure || 0;
  const previousShort = previousWallet?.shortExposure || 0;
  const accountValue = toNumber(account.marginSummary?.accountValue);
  const totalNtlPos = toNumber(account.marginSummary?.totalNtlPos);

  return {
    alias: wallet.alias || shortenAddress(wallet.address),
    address: wallet.address,
    tags: wallet.tags || [],
    accountValue,
    totalNtlPos,
    longExposure,
    shortExposure,
    netExposure: longExposure - shortExposure,
    longDelta: longExposure - previousLong,
    shortDelta: shortExposure - previousShort,
    fills30m: Array.isArray(fills) ? fills.length : 0,
    positions,
    error: null,
  };
}

function buildSnapshot(wallets, market, previous) {
  const generatedAt = new Date().toISOString();
  const activeWallets = wallets.filter((wallet) => !wallet.error && wallet.positions.length > 0).length;
  const longExposure = sum(wallets.map((wallet) => wallet.longExposure || 0));
  const shortExposure = sum(wallets.map((wallet) => wallet.shortExposure || 0));
  const prevLong = previous?.totals?.longExposure || 0;
  const prevShort = previous?.totals?.shortExposure || 0;
  const positions = wallets.flatMap((wallet) =>
    wallet.positions.map((pos) => ({
      ...pos,
      walletAlias: wallet.alias,
      walletAddress: wallet.address,
    })),
  );
  const alerts = buildAlerts(wallets, positions, market);
  return {
    generatedAt,
    intervalMinutes: 30,
    source: "client-live",
    totals: {
      trackedWallets: wallets.length,
      activeWallets,
      longExposure,
      shortExposure,
      netExposure: longExposure - shortExposure,
      longDelta: longExposure - prevLong,
      shortDelta: shortExposure - prevShort,
    },
    market,
    wallets,
    positions,
    alerts,
  };
}

function buildAlerts(wallets, positions, market) {
  const positionAlerts = positions
    .filter((pos) => Math.abs(pos.deltaNotional) >= 100000)
    .sort((a, b) => Math.abs(b.deltaNotional) - Math.abs(a.deltaNotional))
    .slice(0, 8)
    .map((pos) => ({
      severity: Math.abs(pos.deltaNotional) >= 1000000 ? "high" : "medium",
      title: `${pos.walletAlias} ${pos.deltaNotional >= 0 ? "added" : "reduced"} ${pos.coin}`,
      message: `${formatMoney(pos.deltaNotional)} 30m delta, ${pos.side.toUpperCase()} ${formatNumber(pos.size)}`,
      time: new Date().toISOString(),
    }));
  const fillAlerts = wallets
    .filter((wallet) => wallet.fills30m > 0)
    .slice(0, 4)
    .map((wallet) => ({
      severity: "info",
      title: `${wallet.alias} had ${wallet.fills30m} fills`,
      message: "最近 30 分鐘偵測到成交紀錄。",
      time: new Date().toISOString(),
    }));
  const marketAlert = {
    severity: "info",
    title: "Market context refreshed",
    message: `Total perp OI ${formatMoney(market.totalOiUsd)}, avg funding ${formatPercent(market.avgFunding)}`,
    time: new Date().toISOString(),
  };
  return [...positionAlerts, ...fillAlerts, marketAlert];
}

function renderAll() {
  renderWalletList();
  renderMetrics();
  renderMarket();
  renderTable();
  renderAlerts();
  renderHealth();
  drawChart();
}

function renderWalletList() {
  els.walletList.innerHTML = "";
  const wallets = state.watchlist;
  els.watchlistCount.textContent = `${wallets.length} wallets`;
  if (wallets.length === 0) {
    els.walletList.append(document.querySelector("#emptyState").content.cloneNode(true));
    return;
  }
  wallets.forEach((wallet) => {
    const data = state.snapshot?.wallets?.find((item) => item.address.toLowerCase() === wallet.address.toLowerCase());
    const row = document.createElement("article");
    row.className = "wallet-row";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(wallet.alias || shortenAddress(wallet.address))}</strong>
        <code>${shortenAddress(wallet.address)}</code>
      </div>
      <div class="wallet-stats">
        <b class="${(data?.netExposure || 0) >= 0 ? "positive" : "negative"}">${formatMoney(data?.netExposure || 0)}</b>
        <span>${data?.positions?.length || 0} positions</span>
      </div>
    `;
    els.walletList.append(row);
  });
}

function renderMetrics() {
  const totals = state.snapshot?.totals || {};
  const longExposure = totals.longExposure || 0;
  const shortExposure = totals.shortExposure || 0;
  const gross = longExposure + shortExposure;
  const longPct = gross ? (longExposure / gross) * 100 : 0;
  const shortPct = gross ? (shortExposure / gross) * 100 : 0;
  els.trackedWallets.textContent = totals.trackedWallets || state.watchlist.length || 0;
  els.activeWallets.textContent = `Active ${totals.activeWallets || 0}`;
  els.netExposure.textContent = formatMoney(totals.netExposure || 0);
  els.netExposure.className = (totals.netExposure || 0) >= 0 ? "positive" : "negative";
  els.longExposure.textContent = formatMoney(longExposure);
  els.shortExposure.textContent = formatMoney(shortExposure);
  els.longDelta.textContent = `30m change ${formatMoney(totals.longDelta || 0)}`;
  els.shortDelta.textContent = `30m change ${formatMoney(totals.shortDelta || 0)}`;
  els.longShare.style.width = `${longPct}%`;
  els.shortShare.style.width = `${shortPct}%`;
  els.exposureMix.textContent = gross
    ? `${formatPercent(longPct / 100)} Long / ${formatPercent(shortPct / 100)} Short`
    : "等待快照";
  els.snapshotMeta.textContent = state.snapshot?.generatedAt
    ? `Last snapshot ${formatDateTime(state.snapshot.generatedAt)}`
    : "Snapshot baseline 尚未建立";
}

function renderMarket() {
  const market = state.snapshot?.market || {};
  els.marketOi.textContent = formatMoney(market.totalOiUsd || 0);
  els.marketFunding.textContent = `Funding avg ${formatPercent(market.avgFunding || 0)}`;
  els.topOiList.innerHTML = "";
  const max = Math.max(...(market.topOi || []).map((row) => row.oiUsd), 1);
  (market.topOi || []).forEach((row) => {
    const item = document.createElement("div");
    item.className = "oi-row";
    item.innerHTML = `
      <span>${escapeHtml(row.coin)}</span>
      <div class="oi-bar"><span style="width:${Math.max(4, (row.oiUsd / max) * 100)}%"></span></div>
      <b>${formatMoney(row.oiUsd)}</b>
    `;
    els.topOiList.append(item);
  });
}

function renderTable() {
  const positions = (state.snapshot?.positions || [])
    .filter((pos) => {
      if (state.filter === "long" && pos.side !== "long") return false;
      if (state.filter === "short" && pos.side !== "short") return false;
      if (state.filter === "changed" && Math.abs(pos.deltaNotional || 0) < 1) return false;
      if (!state.query) return true;
      return `${pos.walletAlias} ${pos.walletAddress} ${pos.coin}`.toLowerCase().includes(state.query);
    })
    .sort((a, b) => Math.abs(b.deltaNotional || 0) - Math.abs(a.deltaNotional || 0));

  els.deltaRows.innerHTML = "";
  if (positions.length === 0) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="9">尚無持倉資料。加入 watchlist 後會建立第一筆 baseline，下一次刷新即可看到變化。</td>`;
    els.deltaRows.append(row);
    return;
  }
  positions.forEach((pos, index) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${index + 1}</td>
      <td>${escapeHtml(pos.walletAlias)}</td>
      <td><strong>${escapeHtml(pos.coin)}</strong></td>
      <td><span class="side-pill ${pos.side}">${pos.side.toUpperCase()}</span></td>
      <td>${formatNumber(pos.size)}</td>
      <td class="${pos.deltaSize >= 0 ? "positive" : "negative"}">${formatNumber(pos.deltaSize || 0)}</td>
      <td>${formatMoney(pos.notional || 0)}</td>
      <td class="${pos.deltaNotional >= 0 ? "positive" : "negative"}">${formatMoney(pos.deltaNotional || 0)}</td>
      <td class="${pos.unrealizedPnl >= 0 ? "positive" : "negative"}">${formatMoney(pos.unrealizedPnl || 0)}</td>
    `;
    els.deltaRows.append(row);
  });
}

function renderAlerts() {
  const alerts = state.snapshot?.alerts || [];
  els.alertTape.innerHTML = "";
  if (alerts.length === 0) {
    els.alertTape.innerHTML = `<div class="empty-state"><strong>沒有警報</strong><p>大額變化會在下一次快照比較後出現。</p></div>`;
    return;
  }
  alerts.slice(0, 10).forEach((alert) => {
    const row = document.createElement("article");
    row.className = "alert-row";
    row.innerHTML = `
      <time>${formatTime(alert.time)}</time>
      <div>
        <span class="alert-severity ${alert.severity}">${alert.severity.toUpperCase()}</span>
        <strong>${escapeHtml(alert.title)}</strong>
        <p>${escapeHtml(alert.message)}</p>
      </div>
    `;
    els.alertTape.append(row);
  });
}

function renderHealth() {
  const generatedAt = state.snapshot?.generatedAt;
  els.apiLatency.textContent = state.latency == null ? "-- ms" : `${state.latency} ms`;
  els.dataAge.textContent = generatedAt ? relativeAge(generatedAt) : "--";
  els.apiHealth.textContent = state.snapshot ? "All systems operational" : "Waiting for data";
  els.healthBar.style.width = state.snapshot ? "100%" : "15%";
  els.liveDot.classList.toggle("is-warn", !state.snapshot);
}

function drawChart() {
  const ctx = els.chart.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = els.chart.getBoundingClientRect();
  els.chart.width = rect.width * dpr;
  els.chart.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const width = rect.width;
  const height = rect.height;
  ctx.clearRect(0, 0, width, height);
  ctx.font = "12px system-ui";
  const history = state.history.length
    ? state.history
    : state.snapshot
      ? [{ generatedAt: state.snapshot.generatedAt, totals: state.snapshot.totals }]
      : [];
  const padding = { top: 24, right: 24, bottom: 34, left: 58 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  ctx.strokeStyle = getCss("--line");
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (plotH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }
  if (history.length === 0) {
    ctx.fillStyle = getCss("--muted");
    ctx.fillText("等待第一筆快照", padding.left, padding.top + 30);
    return;
  }
  const values = history.flatMap((item) => [
    item.totals?.longExposure || 0,
    -(item.totals?.shortExposure || 0),
    item.totals?.netExposure || 0,
  ]);
  const maxAbs = Math.max(...values.map((value) => Math.abs(value)), 1);
  const scaleY = (value) => padding.top + plotH / 2 - (value / maxAbs) * (plotH / 2) * 0.9;
  const scaleX = (index) => padding.left + (history.length === 1 ? plotW : (plotW / (history.length - 1)) * index);

  drawArea(ctx, history.map((item) => item.totals?.longExposure || 0), scaleX, scaleY, "rgba(0, 127, 104, 0.32)");
  drawArea(ctx, history.map((item) => -(item.totals?.shortExposure || 0)), scaleX, scaleY, "rgba(225, 29, 46, 0.26)");
  drawLine(ctx, history.map((item) => item.totals?.netExposure || 0), scaleX, scaleY, getCss("--text"));
  ctx.fillStyle = getCss("--muted");
  ctx.fillText(formatMoney(maxAbs), 8, padding.top + 4);
  ctx.fillText(formatMoney(-maxAbs), 8, padding.top + plotH);
}

function drawArea(ctx, values, scaleX, scaleY, color) {
  if (values.length === 0) return;
  const zero = scaleY(0);
  ctx.beginPath();
  values.forEach((value, index) => {
    const x = scaleX(index);
    const y = scaleY(value);
    if (index === 0) ctx.moveTo(x, zero);
    ctx.lineTo(x, y);
  });
  ctx.lineTo(scaleX(values.length - 1), zero);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawLine(ctx, values, scaleX, scaleY, color) {
  if (values.length === 0) return;
  ctx.beginPath();
  values.forEach((value, index) => {
    const x = scaleX(index);
    const y = scaleY(value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function exportCsv() {
  const rows = state.snapshot?.positions || [];
  const header = ["walletAlias", "walletAddress", "coin", "side", "size", "deltaSize", "notional", "deltaNotional", "unrealizedPnl"];
  const csv = [header.join(",")]
    .concat(rows.map((row) => header.map((key) => JSON.stringify(row[key] ?? "")).join(",")))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `hyperliquid-whale-radar-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function upsertWallet(wallet) {
  const existing = state.watchlist.findIndex((item) => item.address.toLowerCase() === wallet.address.toLowerCase());
  if (existing >= 0) state.watchlist[existing] = { ...state.watchlist[existing], ...wallet };
  else state.watchlist.push(wallet);
}

function dedupeWallets(wallets) {
  const seen = new Map();
  wallets.forEach((wallet) => {
    const address = normalizeAddress(wallet.address);
    if (!isAddress(address)) return;
    seen.set(address.toLowerCase(), { ...wallet, address, alias: wallet.alias || shortenAddress(address) });
  });
  return [...seen.values()];
}

function readLocalWallets() {
  try {
    return JSON.parse(localStorage.getItem(STORE_WALLETS) || "[]");
  } catch {
    return [];
  }
}

function saveLocalWallets() {
  const localWallets = state.watchlist.filter((wallet) => wallet.source === "local");
  localStorage.setItem(STORE_WALLETS, JSON.stringify(localWallets));
}

function readHistory() {
  try {
    return JSON.parse(localStorage.getItem(STORE_HISTORY) || "[]");
  } catch {
    return [];
  }
}

function saveHistory(history) {
  localStorage.setItem(STORE_HISTORY, JSON.stringify(history.slice(-96)));
}

function appendHistory(history, snapshot) {
  const item = { generatedAt: snapshot.generatedAt, totals: snapshot.totals };
  return [...history.filter((old) => old.generatedAt !== snapshot.generatedAt), item].slice(-96);
}

async function fetchJson(url) {
  const response = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.json();
}

function setStatus(message, warn = false) {
  els.statusLine.textContent = message;
  els.liveDot.classList.toggle("is-warn", warn);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(STORE_THEME, theme);
}

function getCss(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function normalizeAddress(address) {
  return String(address || "").trim();
}

function isAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function shortenAddress(address) {
  if (!address) return "--";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function avg(values) {
  return values.length ? sum(values) / values.length : 0;
}

function formatMoney(value) {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value || 0);
}

function formatPercent(value) {
  return `${((value || 0) * 100).toFixed(3)}%`;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("zh-TW", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "Asia/Taipei",
  }).format(new Date(value));
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-TW", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Taipei",
  }).format(new Date(value));
}

function relativeAge(value) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
