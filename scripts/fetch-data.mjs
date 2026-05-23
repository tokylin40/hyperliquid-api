import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const API_URL = "https://api.hyperliquid.xyz/info";
const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const WATCHLIST_FILE = path.join(DATA_DIR, "watchlist.json");
const LATEST_FILE = path.join(DATA_DIR, "latest.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const INTERVAL_MS = 30 * 60 * 1000;

await mkdir(DATA_DIR, { recursive: true });

const watchlist = await readJson(WATCHLIST_FILE, { wallets: [] });
const previous = await readJson(LATEST_FILE, null);
const history = await readJson(HISTORY_FILE, []);

const started = Date.now();
const enabledWallets = (watchlist.wallets || [])
  .filter((wallet) => wallet.enabled !== false)
  .filter((wallet) => isAddress(wallet.address));

const market = await fetchMarket();
const wallets = await Promise.all(enabledWallets.map((wallet) => fetchWallet(wallet, previous)));
const snapshot = buildSnapshot(wallets, market, previous, Date.now() - started);
const nextHistory = appendHistory(history, snapshot);

await writeJson(LATEST_FILE, snapshot);
await writeJson(HISTORY_FILE, nextHistory);

console.log(`Generated ${wallets.length} wallet snapshots at ${snapshot.generatedAt}`);

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
  return {
    totalOiUsd: sum(rows.map((row) => row.oiUsd)),
    topOi: rows
      .filter((row) => row.oiUsd > 0)
      .sort((a, b) => b.oiUsd - a.oiUsd)
      .slice(0, 10),
    avgFunding: avg(rows.filter((row) => Number.isFinite(row.funding)).map((row) => row.funding)),
    prices: Object.fromEntries(rows.map((row) => [row.coin, row.markPx])),
  };
}

async function fetchWallet(wallet, previousSnapshot) {
  try {
    const [account, fills] = await Promise.all([
      postInfo({ type: "clearinghouseState", user: wallet.address }),
      postInfo({
        type: "userFillsByTime",
        user: wallet.address,
        startTime: Date.now() - INTERVAL_MS,
        aggregateByTime: true,
      }).catch(() => []),
    ]);
    const previousWallet = previousSnapshot?.wallets?.find(
      (item) => item.address.toLowerCase() === wallet.address.toLowerCase(),
    );
    return normalizeWallet(wallet, account, fills, previousWallet);
  } catch (error) {
    return {
      alias: wallet.alias || shortenAddress(wallet.address),
      address: wallet.address,
      tags: wallet.tags || [],
      accountValue: 0,
      totalNtlPos: 0,
      longExposure: 0,
      shortExposure: 0,
      netExposure: 0,
      longDelta: 0,
      shortDelta: 0,
      fills30m: 0,
      positions: [],
      error: error.message,
    };
  }
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

  return {
    alias: wallet.alias || shortenAddress(wallet.address),
    address: wallet.address,
    tags: wallet.tags || [],
    accountValue: toNumber(account.marginSummary?.accountValue),
    totalNtlPos: toNumber(account.marginSummary?.totalNtlPos),
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

function buildSnapshot(wallets, market, previous, latencyMs) {
  const generatedAt = new Date().toISOString();
  const longExposure = sum(wallets.map((wallet) => wallet.longExposure || 0));
  const shortExposure = sum(wallets.map((wallet) => wallet.shortExposure || 0));
  const positions = wallets.flatMap((wallet) =>
    wallet.positions.map((pos) => ({
      ...pos,
      walletAlias: wallet.alias,
      walletAddress: wallet.address,
    })),
  );
  return {
    generatedAt,
    intervalMinutes: 30,
    source: "github-actions",
    health: {
      ok: wallets.every((wallet) => !wallet.error),
      latencyMs,
      walletErrors: wallets.filter((wallet) => wallet.error).map((wallet) => ({
        alias: wallet.alias,
        address: wallet.address,
        error: wallet.error,
      })),
    },
    totals: {
      trackedWallets: wallets.length,
      activeWallets: wallets.filter((wallet) => !wallet.error && wallet.positions.length > 0).length,
      longExposure,
      shortExposure,
      netExposure: longExposure - shortExposure,
      longDelta: longExposure - (previous?.totals?.longExposure || 0),
      shortDelta: shortExposure - (previous?.totals?.shortExposure || 0),
    },
    market,
    wallets,
    positions,
    alerts: buildAlerts(wallets, positions, market),
  };
}

function buildAlerts(wallets, positions, market) {
  const positionAlerts = positions
    .filter((pos) => Math.abs(pos.deltaNotional) >= 100000)
    .sort((a, b) => Math.abs(b.deltaNotional) - Math.abs(a.deltaNotional))
    .slice(0, 12)
    .map((pos) => ({
      severity: Math.abs(pos.deltaNotional) >= 1000000 ? "high" : "medium",
      title: `${pos.walletAlias} ${pos.deltaNotional >= 0 ? "added" : "reduced"} ${pos.coin}`,
      message: `${formatMoney(pos.deltaNotional)} 30m delta, ${pos.side.toUpperCase()} ${formatNumber(pos.size)}`,
      time: new Date().toISOString(),
    }));
  const fillAlerts = wallets
    .filter((wallet) => wallet.fills30m > 0)
    .slice(0, 5)
    .map((wallet) => ({
      severity: "info",
      title: `${wallet.alias} had ${wallet.fills30m} fills`,
      message: "Recent fills detected in the last 30 minutes.",
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

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function appendHistory(history, snapshot) {
  const item = { generatedAt: snapshot.generatedAt, totals: snapshot.totals };
  return [...history.filter((old) => old.generatedAt !== snapshot.generatedAt), item].slice(-96);
}

function isAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(address || "").trim());
}

function shortenAddress(address) {
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
