# RD 收藏搜集器 · V9 開源 extractor 對照 PoC

> 交棒頁：「2026-10-15 交棒 Claude Code｜RD 收藏搜集器 MVP 階段 0：可行性驗證」第八節 V9。
> **只做研究**：不接 LINE、不建 Sheet、不改 GAS、不做 AI。這個資料夾不會被部署（Pages 走白名單、clasp 只推 `apps-script/`）。

## 測什麼

同一批測試貼文，分別用 **Instaloader**（MIT）與 **gallery-dl**（GPL-2.0）抓，輸出與 `apps-script/lab-clip.gs`（Apify 探針）**同一份 JSON 格式**，最後放進同一張表比：

`source, post_id, source_url, author, published_at, caption, media[{order,type,source_url,saved_path}], media_count_expected, media_count_saved, extractor, status, errors`（另附 `ms`、`reported_count`、每張的 `bytes`／`error`）

`status` 規則（與 GAS 探針一致）：
- `ok`：caption 有、張數＝預期、每張圖都**真的存成檔案**
- `partial`：缺張、某張下載失敗／不是圖片、沒有 caption、或含影片（影片只記錄不下載，V7）
- `unverified`：沒給預期張數，無法判斷完整
- `failed`：什麼都沒拿到

錯誤會分兩種寫：「連線失敗（不是 IG 的回應）」和「需要登入？（停損條件）」——前者換台機器重跑，後者照交棒頁停損。

## 護欄

- **不登入、不帶 Cookie、不輸入密碼**：程式裡沒有 `login()`、沒有 `--cookies`；測試會檢查 gallery-dl 的指令沒帶 cookies
- 圖片取得當下就下載（IG 網址的 `oe=` 會過期），存在 `out/`，已列入 `.gitignore`
- caption「與 IG 頁面逐字一致」仍要人工對一次；表上的「一致」只是 extractor 之間互比

## 怎麼跑（Neil 的電腦，需能連 IG）

```bash
cd lab/clip-poc
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m unittest test_poc.py        # 離線測試，不連網
python poc.py                          # 只測 10 張輪播
python poc.py "長文單圖網址|1|長文單圖" "20 張輪播網址|20|20 張" "Reels 網址|Reels"
```

跑完看 `out/<時間>/compare.md`（比較表）與 `results.json`，把比較表貼回交棒頁執行日誌。

> 注意：gallery-dl 這裡用 `-o videos=false`，Reels 會直接被略過、不會出現影片 metadata；V7 想看 Reels 回什麼，以 Instaloader 那列為準。

## 已知狀態（2026-10-15）

- 15 個離線測試通過（欄位對應、正規化、去重、狀態判定、錯誤分類）
- **還沒有任何真實 IG 數據**：Claude Code 的雲端容器連不到 instagram.com（代理 403），實測一次確認兩個 extractor 都只記下「連線失敗」、沒有亂判成功
