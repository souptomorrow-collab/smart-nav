# 智慧導航 🧭

一套以 **Mapbox** 打造的完整網頁導航系統（PWA）。電腦、iPhone、Android 的瀏覽器都能使用，手機可「加入主畫面」後以全螢幕 App 模式執行。

## 功能總覽

| 分類 | 功能 |
|---|---|
| 地圖 | Mapbox Standard 3D 地圖（含 3D 建築）、衛星影像、日間 / 夜間模式、即時路況圖層、2D/3D 切換 |
| 搜尋 | 地點 / 地址自動完成搜尋（支援中文）、座標直接輸入（`25.034, 121.564`）、反向查詢「這是哪裡？」 |
| 路線規劃 | 開車（含即時路況）/ 步行 / 騎車三種模式、替代路線比較、多停靠點（最多 12 站）、起訖點交換、路況壅塞著色、完整轉彎步驟清單 |
| 逐步導航 | GPS 即時追蹤、3D 跟隨視角、轉彎横幅與圖示、**中文語音播報**、剩餘時間 / 距離 / 預計抵達時間、目前時速與**速限顯示**、偏離路線**自動重新規劃**、路線總覽、抵達偵測 |
| 模擬導航 | 沒有 GPS（例如桌機）也能沿路線模擬行駛，測試整個導航流程 |
| 個人化 | 收藏地點、搜尋歷史（儲存在瀏覽器本機） |
| PWA | 可安裝到手機主畫面、應用程式外殼離線快取 |

## 快速開始

1. **取得 Mapbox 金鑰（免費）**
   前往 [account.mapbox.com](https://account.mapbox.com/access-tokens/) 註冊並複製「Default public token」（`pk.` 開頭）。免費額度每月 5 萬次地圖載入，個人使用綽綽有餘。

2. **啟動**
   雙擊 `start.bat`（會自動用 Python 或 Node 開一個本機伺服器並打開瀏覽器），或手動執行：

   ```
   python -m http.server 8080
   ```

   然後開啟 <http://localhost:8080>。

3. 首次開啟會要求輸入 Mapbox 金鑰，貼上後即可使用。金鑰只存在你自己瀏覽器的 localStorage。

## 使用方式

- **搜尋**：上方搜尋框輸入地點，或直接輸入「緯度, 經度」。
- **右鍵（手機長按）地圖**：導航到這裡 / 從這裡出發 / 加入收藏 / 這是哪裡。
- **規劃路線**：搜尋框右側的路線按鈕，或地點卡上的「導航到這裡」。可切換 🚗🚶🚲、新增停靠點、點選灰色替代路線比較。
- **開始導航**：真實 GPS 導航；**模擬導航**：沿路線自動模擬行駛（適合在電腦上展示）。
- **導航中**：拖曳地圖可自由查看（出現「重新置中」）、🗺️ 路線總覽、🔊 靜音切換。

## 在手機上使用（GPS 需要 HTTPS）

瀏覽器規定：**定位功能只在 `https://` 或 `localhost` 下可用**。在電腦上用 localhost 沒問題，但手機透過區網 IP（`http://192.168.x.x:8080`）開啟時 GPS 會被封鎖。解決方式任選一種：

- **部署到免費靜態網站**（最推薦）：把整個資料夾拖到 [Netlify Drop](https://app.netlify.com/drop)，或放上 GitHub Pages / Cloudflare Pages，取得 https 網址。
- **開通道**：`npx localtunnel --port 8080` 或 `cloudflared tunnel --url http://localhost:8080`。

部署後在手機瀏覽器開啟 → 選單「加入主畫面」→ 即可像 App 一樣全螢幕使用。

## Android Auto 路線圖（第二階段）

Android Auto **無法執行網頁應用**，Google 要求導航類 App 必須是原生 Android App：

1. 以 Kotlin 建立 Android 專案，整合 **Mapbox Navigation SDK for Android**（內建 Android Auto 擴充模組 `mapbox-navigation-android-auto`，提供車機模板 UI）。
2. 使用 `androidx.car.app`（Car App Library），宣告 `androidx.car.app.category.NAVIGATION` 類別。
3. 開發期以 **Desktop Head Unit（DHU）模擬器** 測試；要在真車上使用需上架 Google Play 導航分類（需通過 Google 審查）。

需要安裝 Android Studio 之後，就可以進行這個階段。

## 專案結構

```
index.html            頁面結構
css/style.css         樣式（響應式，支援手機）
js/app.js             主程式：UI 與各模組整合
js/map.js             地圖初始化、樣式 / 路況 / 3D 切換
js/search.js          Geocoding 搜尋與自動完成
js/routing.js         Directions 路線規劃與路線繪製（壅塞著色）
js/navigation.js      逐步導航引擎（吸附、語音、偏航重規劃、模擬）
js/voice.js           Web Speech 中文語音
js/places.js          收藏與歷史（localStorage）
js/config.js          設定與金鑰管理
js/utils.js           地理計算與格式化
manifest.webmanifest  PWA 設定
sw.js                 Service Worker（離線外殼快取）
start.bat             一鍵啟動本機伺服器
```

## 技術說明

- 地圖：Mapbox GL JS v3.29（Standard 樣式，3D 建築與光照）
- 路線：Mapbox Directions API（`driving-traffic` / `walking` / `cycling`，含壅塞、速限、語音指令標註）
- 搜尋：Mapbox Geocoding API（`language=zh-Hant`）
- 語音：瀏覽器 Web Speech API（`zh-TW`）
- 導航引擎為自製：把 GPS 點吸附到路線折線上計算進度，依 API 提供的播報點觸發語音，偏離超過 45 公尺自動重新規劃。
