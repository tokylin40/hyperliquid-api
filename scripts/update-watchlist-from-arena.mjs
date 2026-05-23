import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ARENA_URL = "https://arena.freedomcore.io/";
const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const DATA_DIR = path.join(process.cwd(), "data");
const WATCHLIST_FILE = path.join(DATA_DIR, "watchlist.json");
const MIN_PNL = 1;
const MIN_WIN_RATE = 0.95;
const MIN_TRADES = 100;
const MIN_VOLUME = 500000;
const TARGET_WALLETS = 20;

const html = await fetchText(ARENA_URL);
const leaderboard = parseLeaderboard(html);
const candidates = leaderboard
  .filter(
    (row) =>
      row.pnl >= MIN_PNL &&
      row.winRate >= MIN_WIN_RATE &&
      row.trades >= MIN_TRADES &&
      row.volume >= MIN_VOLUME,
  )
  .sort((a, b) => b.score - a.score)
  .slice(0, 45);

const enriched = [];
for (const candidate of candidates) {
  const live = await fetchHyperliquidState(candidate.address);
  enriched.push({ ...candidate, ...live });
}

const active = enriched.filter((row) => row.openPositions > 0);
const selected = [...active, ...enriched.filter((row) => row.openPositions === 0)]
  .slice(0, TARGET_WALLETS)
  .map((row, index) => ({
    alias: `Arena ${row.tier} #${row.rank}`,
    address: row.address,
    tags: [
      "arena",
      "high-winrate",
      row.tier.toLowerCase(),
      row.style.toLowerCase(),
      row.openPositions > 0 ? "active-position" : "no-open-position",
    ],
    enabled: true,
    source: "arena.freedomcore.io",
    notes: `${formatPct(row.winRate)} win rate, ${formatUsd(row.pnl)} 30d PnL, ${row.trades} trades, ${formatUsd(row.volume)} 30d volume, ${row.style}; selected ${index + 1}/${TARGET_WALLETS}.`,
    metrics: {
      arenaRank: row.rank,
      tier: row.tier,
      style: row.style,
      score: row.score,
      pnl30d: row.pnl,
      roi30d: row.roi,
      winRate30d: row.winRate,
      trades30d: row.trades,
      volume30d: row.volume,
      accountValue: row.accountValue,
      openPositions: row.openPositions,
      totalNotionalPosition: row.totalNotionalPosition,
    },
  }));

const output = {
  updatedAt: new Date().toISOString(),
  source: ARENA_URL,
  methodology: {
    filters: {
      pnl30dMin: MIN_PNL,
      winRate30dMin: MIN_WIN_RATE,
      trades30dMin: MIN_TRADES,
      volume30dMin: MIN_VOLUME,
    },
    selection:
      "Sort filtered ARENA leaderboard rows by composite score, prefer addresses with live open Hyperliquid perp positions, then keep the top 20.",
    caveat:
      "ARENA/FreedomCore is a third-party leaderboard. Current positions are fetched from Hyperliquid public API. This is not investment advice.",
  },
  wallets: selected,
};

await mkdir(DATA_DIR, { recursive: true });
await writeFile(WATCHLIST_FILE, `${JSON.stringify(output, null, 2)}\n`, "utf8");

console.log(`Selected ${selected.length} wallets from ${leaderboard.length} ARENA rows.`);
console.table(
  selected.map((wallet) => ({
    alias: wallet.alias,
    address: `${wallet.address.slice(0, 8)}...${wallet.address.slice(-4)}`,
    winRate: formatPct(wallet.metrics.winRate30d),
    pnl30d: formatUsd(wallet.metrics.pnl30d),
    trades: wallet.metrics.trades30d,
    openPositions: wallet.metrics.openPositions,
    accountValue: formatUsd(wallet.metrics.accountValue),
  })),
);

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Hyperliquid Whale Radar watchlist updater",
    },
  });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.text();
}

function parseLeaderboard(source) {
  const rowPattern =
    /<tr data-score="([^"]+)" data-pnl="([^"]+)" data-roi="([^"]+)" data-wr="([^"]+)" data-sharpe="([^"]+)" data-trades="([^"]+)" data-vol="([^"]+)">([\s\S]*?)<\/tr>/g;
  return [...source.matchAll(rowPattern)]
    .map((match) => {
      const body = match[8];
      const address = body.match(/\/wallet\/(0x[a-fA-F0-9]{40})\//)?.[1];
      const rank = Number(body.match(/<td class="rank-cell">(\d+)<\/td>/)?.[1]);
      const tier = body.match(/tier-\d">(T\d)<\/span>/)?.[1] || "T?";
      const styles = [...body.matchAll(/<td><span class="tier-badge tier-\d">([^<]+)<\/span><\/td>/g)];
      const style = styles.at(-1)?.[1] || "Mixed";
      return {
        rank,
        tier,
        style,
        address,
        score: Number(match[1]),
        pnl: Number(match[2]),
        roi: Number(match[3]),
        winRate: Number(match[4]),
        trades: Number(match[6]),
        volume: Number(match[7]),
      };
    })
    .filter((row) => row.address && Number.isFinite(row.rank));
}

async function fetchHyperliquidState(address) {
  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "clearinghouseState", user: address }),
  });
  if (!response.ok) throw new Error(`Hyperliquid API ${response.status} for ${address}`);
  const account = await response.json();
  const positions = (account.assetPositions || []).filter((item) => {
    const size = Number((item.position || item).szi);
    return Number.isFinite(size) && Math.abs(size) > 0;
  });
  return {
    accountValue: Number(account.marginSummary?.accountValue || 0),
    openPositions: positions.length,
    totalNotionalPosition: Number(account.marginSummary?.totalNtlPos || 0),
  };
}

function formatPct(value) {
  return `${(value * 100).toFixed(value >= 1 ? 0 : 1)}%`;
}

function formatUsd(value) {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}
