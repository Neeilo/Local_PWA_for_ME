#!/usr/bin/env python3
"""RD 收藏搜集器 MVP 階段 0｜V9 開源 Instagram extractor 對照 PoC（隔離 lab）。

只做研究：公開貼文、無登入、無密碼、無 Session Cookie。輸出照交棒頁「PoC JSON 欄位約定」，
與 apps-script/lab-clip.gs（Apify 探針）同一份格式，才能放同一張表比。

用法（在自己電腦上，見 README）：
    python poc.py                                   # 只測交棒頁指定的 10 張輪播
    python poc.py "網址|預期張數|備註" ...            # 追加測試貼文
    python poc.py --extractor instaloader ...        # 只跑一個（instaloader / gallery-dl / all）

結果寫在 out/<時間>/：每個 extractor 一個資料夾（圖片＋record.json）、results.json、compare.md。
"""

import argparse
import json
import mimetypes
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

TEST_POST = "https://www.instagram.com/p/DdsyziaiROW/"
DEFAULT_POSTS = [f"{TEST_POST}|10|10 張輪播（交棒頁指定）"]
EXTRACTORS = ("instaloader", "gallery-dl")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
LOGIN_HINT = re.compile(r"login|log in|401|checkpoint|cookies|redirect", re.I)
NETWORK_HINT = re.compile(r"ProxyError|Tunnel connection failed|NameResolution|getaddrinfo|ConnectTimeout", re.I)

_IG = re.compile(r"^https?://(?:www\.|m\.)?instagram\.com/(?:[A-Za-z0-9._]+/)?(p|reel|reels|tv)/([A-Za-z0-9_-]+)", re.I)


# --------------------------------------------------------------------------- 共用

def normalize_url(raw):
    """V6：去掉 ?igsh= 等參數與帳號前綴；認不得回 None（與 lab-clip.gs 的 clipNormalizeUrl_ 同規則）。"""
    m = _IG.match(str(raw or "").strip())
    if not m:
        return None
    kind = "reel" if m.group(1).lower() == "reels" else m.group(1).lower()
    return {"key": "ig:" + m.group(2), "id": m.group(2), "kind": kind,
            "url": f"https://www.instagram.com/{kind}/{m.group(2)}/"}


def parse_posts(specs):
    """「網址|預期張數|備註」→ 去重後的清單；同一篇不同參數只留第一筆。"""
    seen, out = set(), []
    for spec in specs:
        parts = [s.strip() for s in spec.split("|")]
        n = normalize_url(parts[0])
        if not n:
            print(f"⚠️ 不是 IG 貼文網址，略過：{parts[0]}")
            continue
        if n["key"] in seen:
            continue
        seen.add(n["key"])
        expected, note = None, ""
        for s in parts[1:]:
            if s.isdigit():
                expected = int(s)
            elif s:
                note = s
        out.append({**n, "raw": parts[0], "expected": expected, "note": note})
    return out


def classify_error(msg):
    """先排除「連不到 IG」（代理、DNS），再看是不是被要求登入——兩者結論完全不同，不能混在一起。"""
    if NETWORK_HINT.search(msg):
        return "連線失敗（不是 IG 的回應，換台能上網的機器再跑）" + msg
    if LOGIN_HINT.search(msg):
        return "需要登入？（停損條件）" + msg
    return msg


def new_record(post, extractor):
    return {
        "source": "instagram", "post_id": post["id"], "source_url": post["url"],
        "author": "", "published_at": "", "caption": "",
        "media": [], "media_count_expected": post["expected"], "media_count_saved": 0,
        "extractor": extractor, "status": "failed", "errors": [], "ms": 0,
        "reported_count": None,  # extractor 自己說這篇有幾張（輔助判斷，不取代預期張數）
    }


def finish(rec):
    """狀態規則與 lab-clip.gs 的 clipFinish_ 一致：拿到網址不算存下來；少一張、缺 caption 都不算 ok。"""
    rec["media_count_saved"] = sum(1 for m in rec["media"] if m.get("saved_path"))
    if not rec["media"]:
        if not rec["errors"]:
            rec["errors"].append("沒有任何圖片／影片")
    else:
        exp = rec["media_count_expected"]
        if exp is not None and len(rec["media"]) != exp:
            rec["errors"].append(f"取得 {len(rec['media'])}/{exp} 張")
        for m in rec["media"]:
            if m.get("error"):
                rec["errors"].append(f"第 {m['order']} 張：{m['error']}")
        if not rec["caption"]:
            rec["errors"].append("沒有 caption")
    if not rec["media"] and not rec["caption"]:
        rec["status"] = "failed"
    elif rec["errors"]:
        rec["status"] = "partial"
    else:
        rec["status"] = "unverified" if rec["media_count_expected"] is None else "ok"
    return rec


def http_download(url, dest_stem):
    """下載一張圖。回 (saved_path, bytes, error)。CDN 回 200 但不是圖片也算失敗。"""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            ctype = (res.headers.get("Content-Type") or "").split(";")[0]
            data = res.read()
    except Exception as err:  # noqa: BLE001 — 每張的失敗原因都要記下來，不中斷
        return "", 0, f"{type(err).__name__}: {err}"
    if not ctype.startswith("image/"):
        return "", 0, f"回的不是圖片（{ctype or '未知'}）"
    ext = (mimetypes.guess_extension(ctype) or ".img").replace(".jpe", ".jpg")
    path = Path(str(dest_stem) + ext)
    path.write_bytes(data)
    return str(path), len(data), ""


def save_media(rec, entries, outdir, download=http_download):
    """entries: [(type, source_url, cover_url)]。影片只記錄、不下載（V7 由 grill-me 決定收不收）。"""
    outdir.mkdir(parents=True, exist_ok=True)
    for i, (mtype, src, cover) in enumerate(entries, 1):
        m = {"order": i, "type": mtype, "source_url": src or "", "cover_url": cover or "",
             "saved_path": "", "bytes": 0, "error": ""}
        if mtype == "video":
            m["error"] = "影片未下載（V7 只記錄）"
        elif not src:
            m["error"] = "沒有網址"
        else:
            m["saved_path"], m["bytes"], m["error"] = download(src, outdir / f"{i:02d}")
        rec["media"].append(m)


# --------------------------------------------------------------------------- Instaloader

def instaloader_entries(post):
    """Instaloader 的 Post → [(type, url, cover)]；輪播讀每個子節點。"""
    if post.typename == "GraphSidecar":
        return [("video", n.video_url, n.display_url) if n.is_video else ("image", n.display_url, "")
                for n in post.get_sidecar_nodes()]
    return [("video", post.video_url, post.url)] if post.is_video else [("image", post.url, "")]


def run_instaloader(post, outdir, loader=None, download=http_download):
    rec = new_record(post, "instaloader")
    started = time.monotonic()
    try:
        import instaloader
        rec["extractor"] = f"instaloader {instaloader.__version__}"
        # 刻意不呼叫 login()、不載入 session：本 PoC 只測無登入（停損條件）
        L = loader or instaloader.Instaloader(quiet=True, download_videos=False, download_video_thumbnails=False,
                                              save_metadata=False, compress_json=False, max_connection_attempts=1)
        p = instaloader.Post.from_shortcode(L.context, post["id"])
        rec["caption"] = p.caption or ""
        rec["author"] = p.owner_username or ""
        rec["published_at"] = p.date_utc.replace(tzinfo=timezone.utc).isoformat() if p.date_utc else ""
        rec["reported_count"] = p.mediacount
        save_media(rec, instaloader_entries(p), outdir, download)
    except Exception as err:  # noqa: BLE001
        msg = f"{type(err).__name__}: {err}"
        rec["errors"].append(classify_error(msg))
    rec["ms"] = round((time.monotonic() - started) * 1000)
    return finish(rec)


# --------------------------------------------------------------------------- gallery-dl

def gallerydl_record_from_dir(rec, outdir):
    """讀 gallery-dl --write-metadata 寫出的 *.json（每個檔案一份）→ 填進 rec。"""
    metas = []
    for meta_path in sorted(outdir.glob("*.json")):
        if meta_path.name == "record.json":
            continue
        try:
            metas.append((meta_path, json.loads(meta_path.read_text(encoding="utf-8"))))
        except ValueError:
            rec["errors"].append(f"metadata 讀不到：{meta_path.name}")
    metas.sort(key=lambda t: int(t[1].get("num") or 0))
    for i, (meta_path, meta) in enumerate(metas, 1):
        if i == 1:
            rec["caption"] = meta.get("description") or ""
            rec["author"] = meta.get("username") or ""
            rec["published_at"] = str(meta.get("post_date") or meta.get("date") or "")
            rec["reported_count"] = meta.get("count")
        media_file = meta_path.with_suffix("")  # 01.jpg.json → 01.jpg
        is_video = (meta.get("extension") or "").lower() in ("mp4", "mov", "webm") or bool(meta.get("video_url"))
        m = {"order": i, "type": "video" if is_video else "image",
             "source_url": meta.get("video_url") if is_video else (meta.get("display_url") or ""),
             "cover_url": meta.get("display_url") if is_video else "",
             "saved_path": "", "bytes": 0, "error": ""}
        if is_video:
            m["error"] = "影片未下載（V7 只記錄）"
        elif media_file.exists() and media_file.stat().st_size > 0:
            m["saved_path"], m["bytes"] = str(media_file), media_file.stat().st_size
        else:
            m["error"] = "有 metadata 但沒有檔案"
        rec["media"].append(m)


def run_gallerydl(post, outdir, runner=subprocess.run):
    rec = new_record(post, "gallery-dl")
    started = time.monotonic()
    outdir.mkdir(parents=True, exist_ok=True)
    try:
        import gallery_dl
        rec["extractor"] = f"gallery-dl {gallery_dl.version.__version__}"
    except Exception:  # noqa: BLE001
        pass
    # 不帶 --cookies／--cookies-from-browser／帳密：只測無登入。videos=false：影片只看 metadata
    cmd = [sys.executable, "-m", "gallery_dl", "--write-metadata", "--no-mtime",
           "-o", "videos=false", "-D", str(outdir), "-f", "{num:>02}.{extension}", post["url"]]
    try:
        res = runner(cmd, capture_output=True, text=True, timeout=300)
        if res.returncode != 0:
            tail = (res.stderr or res.stdout or "").strip().splitlines()[-3:]
            msg = f"exit {res.returncode}: " + " / ".join(tail)
            rec["errors"].append(classify_error(msg))
    except Exception as err:  # noqa: BLE001
        rec["errors"].append(f"{type(err).__name__}: {err}")
    gallerydl_record_from_dir(rec, outdir)
    rec["ms"] = round((time.monotonic() - started) * 1000)
    return finish(rec)


# --------------------------------------------------------------------------- 比較表

def compare_markdown(posts, results):
    """每篇 × 每個 extractor 一列；caption 跨 extractor 比對（逐字以 IG 頁面為準，仍需人工）。"""
    lines = ["| 貼文 | extractor | 狀態 | 取得/預期 | 已存 | caption 字數 | 與其他 extractor caption 一致 | 耗時 ms | 錯誤 |",
             "|---|---|---|---|---|---|---|---|---|"]
    for post in posts:
        recs = [r for r in results if r["post_id"] == post["id"]]
        captions = {r["extractor"]: r["caption"] for r in recs if r["caption"]}
        for r in recs:
            others = [c for k, c in captions.items() if k != r["extractor"]]
            same = "未驗證" if not r["caption"] or not others else ("是" if all(c == r["caption"] for c in others) else "否")
            exp = "?" if r["media_count_expected"] is None else r["media_count_expected"]
            lines.append(f"| {post['id']} | {r['extractor']} | {r['status']} | {len(r['media'])}/{exp} | "
                         f"{r['media_count_saved']} | {len(r['caption'])} | {same} | {r['ms']} | "
                         f"{'；'.join(r['errors'])[:200].replace('|', '/')} |")
    oks = [r["ms"] for r in results if r["status"] == "ok"]
    lines += ["", f"ok 筆數 {len(oks)}/{len(results)}；"
              + (f"ok 的平均耗時 {round(sum(oks) / len(oks))} ms" if oks else "沒有 ok 的結果，無法算耗時"),
              "月 300 篇成本：兩者皆開源免授權費，成本是「誰的機器在跑」與維護；P95 需多跑幾輪才有意義（未驗證）。"]
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("posts", nargs="*", help="網址|預期張數|備註")
    ap.add_argument("--extractor", choices=EXTRACTORS + ("all",), default="all")
    ap.add_argument("--out", default=str(Path(__file__).with_name("out")))
    args = ap.parse_args(argv)

    posts = parse_posts(DEFAULT_POSTS + args.posts)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    root = Path(args.out) / stamp
    chosen = EXTRACTORS if args.extractor == "all" else (args.extractor,)
    results = []
    for post in posts:
        for name in chosen:
            outdir = root / name.replace("-", "_") / post["id"]
            print(f"▶ {name} ｜ {post['url']}")
            rec = run_instaloader(post, outdir) if name == "instaloader" else run_gallerydl(post, outdir)
            outdir.mkdir(parents=True, exist_ok=True)
            (outdir / "record.json").write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"  {rec['status']}｜取得 {len(rec['media'])} 張、存 {rec['media_count_saved']} 張｜caption "
                  f"{len(rec['caption'])} 字｜{rec['ms']} ms" + (f"｜{'；'.join(rec['errors'])}" if rec["errors"] else ""))
            results.append(rec)
    (root / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    table = compare_markdown(posts, results)
    (root / "compare.md").write_text(table + "\n", encoding="utf-8")
    print("\n" + table + f"\n\n結果：{root}")
    return 0 if all(r["status"] == "ok" for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
