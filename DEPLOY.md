# 部署與設備需求

本文件說明怎麼把這個專案（線上牌桌：大老二／德州撲克／大富翁／台灣麻將）架起來給大家連線遊玩。
專案本身的規則、架構細節請看 [README.md](README.md)（給玩家／概觀）與 [CLAUDE.md](CLAUDE.md)（給開發者）。

## 一、需要什麼設備

**只需要一台機器**，不需要虛擬機、不需要資料庫、不需要額外的雲端服務：

| 項目 | 需求 |
| --- | --- |
| 硬體 | 一般文書筆電／桌機／小型雲端主機即可，2 核心 CPU、2GB 記憶體以上就足夠（狀態全部存在記憶體裡，人數不多的話負擔很小） |
| 作業系統 | Windows / macOS / Linux 皆可，本文件以 Windows 為主，指令另附 macOS／Linux 對照 |
| 執行環境 | [Node.js](https://nodejs.org/) 18 LTS 以上（開發時用的是 v24），內建的 npm 就夠，不用另外裝 |
| 磁碟空間 | 專案原始碼很小，但 `npm install` 後 `node_modules` 約數百 MB，抓 1GB 空間 |
| 網路 | 只要主機和玩家在同一個區網（同 Wi-Fi／同辦公室網路）即可，不需要對外的網域或固定 IP；要讓外部的人連線才需要對外開通連接埠或使用可對外的雲端主機 |

**沒有** node_modules（依賴套件）— 那些檔案體積龐大且平台相依，本壓縮檔刻意不包含，
請照下面步驟在目標機器上用 `npm install` 重新安裝。

## 二、解壓縮

把這個 zip 解壓縮到任意資料夾即可，例如 `C:\apps\riffle-main`（Windows）或 `~/apps/riffle-main`（macOS／Linux）。
解開後應該會看到 `client/`、`server/`、`shared/`、`package.json` 等檔案。

## 三、安裝依賴套件

打開終端機（Windows 用 PowerShell 或命令提示字元，macOS/Linux 用 Terminal），切到專案資料夾，執行：

```bash
npm install
```

這是 npm workspaces 專案，一次 `npm install` 會把 `shared` / `server` / `client` 三個子套件的依賴一起裝好。

## 四、啟動伺服器

### 方式 A：測試／開發用（前後端各自跑，改程式碼會自動重載）

```bash
npm run dev
```

會同時啟動：
- 後端 API + Socket.IO：`http://localhost:3001`
- 前端頁面：`http://localhost:5173`（打開瀏覽器連這個網址）

### 方式 B：正式提供給大家玩（打包成一份、單一連接埠對外）

```bash
npm run serve
```

這個指令會先把前端打包，再讓後端用單一服務同時提供 API 與網頁，預設監聽 `0.0.0.0:80`
（所有網卡、80 埠），啟動時終端機會印出這台機器在區網內的可連線位址（例如 `http://192.168.1.23`），
把這個網址給同網段的其他人，開瀏覽器輸入暱稱就能加入。

> Windows 的 80 埠常被 IIS 或 `http.sys` 占用而出現 `EADDRINUSE`；改用別的埠即可：
> ```bash
> npm start -w server -- --port 8080
> ```
> 若看到 `EACCES`（沒有權限監聽該埠），用系統管理員／root 身分執行，或換一個 1024 以上的埠號。

只要 `client/dist` 資料夾存在（也就是跑過 `npm run build` 或 `npm run serve`），後端就會一併把
網頁吐出來；沒打包過的話只有 API 可用，網頁要另外用 `npm run dev -w client` 開。

## 五、想固定連接埠 / 只開放本機

命令列參數優先於環境變數，範例：

```bash
npm start -w server -- --port 8080 --host 127.0.0.1   # 換埠、只開放本機
npm run dev -w client -- --port 3000                  # 開發模式下 Vite 自己的連接埠
```

## 六、驗證伺服器有跑起來

伺服器內建健康檢查端點，啟動後可以用瀏覽器或指令確認：

```bash
curl http://localhost:3001/healthz
```

回傳 `{"ok":true}` 就代表後端正常。方式 B（`npm run serve`）啟動後直接連前面印出的網址即可整組一起測。

## 七、想長期開著（背景執行 / 開機自動啟動，選用）

單純測試玩玩不需要這一步；如果要當作長駐服務，建議：

- **Windows**：用工作排程器（Task Scheduler）設定開機執行 `npm run serve`，或用
  [PM2](https://pm2.keymetrics.io/)（`npm install -g pm2` 後 `pm2 start npm --name riffle -- run serve`）。
- **Linux**：用 `systemd` 寫一個服務單元執行 `npm run serve`，或同樣用 PM2。

這些都是選用的維運手法，不是本專案必需，最單純的情況下直接在終端機跑 `npm run serve` 開著視窗即可。

## 八、常見問題

- **沒有 Node.js 怎麼辦？** 去 [nodejs.org](https://nodejs.org/) 下載 LTS 版安裝即可，安裝完終端機
  重開一次再執行 `node -v` 確認有版本號跑出來。
- **`npm install` 很久或失敗？** 檢查網路連線；公司網路如果有 proxy，需要另外設定 npm 的 proxy。
- **要多開幾個玩家測試？** 直接在瀏覽器多開幾個分頁即可（不用開無痕），每個分頁是獨立玩家；
  重新整理（F5）還是同一個人，會接回原本座位與手牌——這是設計上的行為，不是 bug。
