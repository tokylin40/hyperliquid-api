# Hyperliquid Whale Radar

一個可部署到 GitHub Pages 的 Hyperliquid smart wallet 監控網站。網站會讀取公開 `info` endpoint，追蹤 watchlist 地址的 perp 持倉，並透過 GitHub Actions 每 30 分鐘更新一次 `data/latest.json` 與 `data/history.json`。

## 資料來源

- Hyperliquid `POST https://api.hyperliquid.xyz/info`
- `metaAndAssetCtxs`: 市場 mark price、funding、open interest
- `clearinghouseState`: 指定地址的 perp account summary 與 open positions
- `userFillsByTime`: 指定地址最近 30 分鐘 fills

官方文件：<https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint>

## 設定 smart wallet 清單

編輯 `data/watchlist.json`：

```json
{
  "wallets": [
    {
      "alias": "Example Whale",
      "address": "0x0000000000000000000000000000000000000000",
      "tags": ["manual"],
      "enabled": true
    }
  ]
}
```

Hyperliquid 公開 API 可以查詢指定地址，但不能直接列出所有「聰明大戶」。因此這個專案把 smart wallet 定義為你維護的 watchlist，並用快照差分分析持倉變化。

## 本機預覽

這是純靜態網站。建議用內建靜態伺服器預覽，避免瀏覽器限制本機 `fetch`：

```bash
npm run serve
```

## GitHub Pages 發佈

1. 建立 GitHub repo 並推上 `main` branch。
2. 到 repo 的 Settings -> Pages，將 source 設成 GitHub Actions。
3. 執行 `Deploy GitHub Pages` workflow。
4. `Refresh Hyperliquid data` workflow 會每 30 分鐘更新資料，也可以手動 `workflow_dispatch`。

## 注意

- 這不是投資建議，只是公開資料監控。
- 第一筆快照是 baseline；要等下一次 30 分鐘刷新才會有真正的 delta。
- GitHub Actions 排程可能有數分鐘延遲，屬 GitHub 平台正常行為。
