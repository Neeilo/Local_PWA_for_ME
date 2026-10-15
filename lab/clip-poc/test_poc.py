"""poc.py 的離線測試：不連網，盯「PoC 會不會說錯話」。

跑法：python -m unittest test_poc.py（在 lab/clip-poc/ 裡）
"""

import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import poc

TEST = "https://www.instagram.com/p/DdsyziaiROW/"


def fake_download(url, stem):
    if "blocked" in url:
        return "", 0, "HTTPError: HTTP Error 403: Forbidden"
    path = str(stem) + ".jpg"
    Path(path).write_bytes(b"x" * 10)
    return path, 10, ""


class Normalize(unittest.TestCase):
    def test_same_post_one_key(self):
        a = poc.normalize_url(TEST + "?igsh=MWx0")
        b = poc.normalize_url("https://m.instagram.com/someone/p/DdsyziaiROW#x")
        self.assertEqual(a["url"], TEST)
        self.assertEqual(a["key"], b["key"])

    def test_reels_and_garbage(self):
        self.assertEqual(poc.normalize_url("https://www.instagram.com/reels/Cr1/")["url"], "https://www.instagram.com/reel/Cr1/")
        self.assertIsNone(poc.normalize_url("https://www.instagram.com/someone/"))
        self.assertIsNone(poc.normalize_url("not a url"))

    def test_parse_posts_dedupes_and_reads_fields(self):
        posts = poc.parse_posts([TEST + "|10|輪播", TEST + "?img_index=2", "https://instagram.com/reel/Cr1/|Reels"])
        self.assertEqual([p["id"] for p in posts], ["DdsyziaiROW", "Cr1"])
        self.assertEqual(posts[0]["expected"], 10)
        self.assertIsNone(posts[1]["expected"])
        self.assertEqual(posts[1]["note"], "Reels")


def post(expected=10):
    return poc.parse_posts([f"{TEST}|{expected}"])[0]


def sidecar(n=10, blocked=()):
    nodes = [SimpleNamespace(is_video=False, display_url=f"https://cdn/{'blocked' if i in blocked else 'ok'}{i}.jpg", video_url=None)
             for i in range(1, n + 1)]
    return SimpleNamespace(typename="GraphSidecar", get_sidecar_nodes=lambda: iter(nodes))


class Instaloader(unittest.TestCase):
    def test_sidecar_reads_every_node_in_order(self):
        entries = poc.instaloader_entries(sidecar(3))
        self.assertEqual([e[1] for e in entries], ["https://cdn/ok1.jpg", "https://cdn/ok2.jpg", "https://cdn/ok3.jpg"])

    def test_single_video_is_recorded_not_downloaded(self):
        p = SimpleNamespace(typename="GraphVideo", is_video=True, video_url="https://cdn/v.mp4", url="https://cdn/cover.jpg")
        with tempfile.TemporaryDirectory() as d:
            rec = poc.new_record(post(1), "instaloader")
            poc.save_media(rec, poc.instaloader_entries(p), Path(d), fake_download)
            rec["caption"] = "x"
            poc.finish(rec)
        self.assertEqual(rec["media"][0]["type"], "video")
        self.assertIn("影片未下載", rec["media"][0]["error"])
        self.assertEqual(rec["status"], "partial")

    def test_run_with_fake_loader(self):
        """把 instaloader.Post.from_shortcode 換成假的，驗整條 run_instaloader 的欄位對應"""
        import instaloader
        fake_post = sidecar(10)
        fake_post.caption, fake_post.owner_username, fake_post.mediacount = "全文", "someone", 10
        fake_post.date_utc = datetime(2026, 10, 1, 3, 4, 5)
        original = instaloader.Post.from_shortcode
        instaloader.Post.from_shortcode = staticmethod(lambda ctx, sc: fake_post)
        try:
            with tempfile.TemporaryDirectory() as d:
                rec = poc.run_instaloader(post(10), Path(d), loader=SimpleNamespace(context=None), download=fake_download)
        finally:
            instaloader.Post.from_shortcode = original
        self.assertEqual(rec["status"], "ok")
        self.assertEqual(rec["media_count_saved"], 10)
        self.assertEqual(rec["published_at"], "2026-10-01T03:04:05+00:00")
        self.assertTrue(rec["extractor"].startswith("instaloader "))

    def test_login_wall_is_named(self):
        import instaloader
        original = instaloader.Post.from_shortcode

        def boom(ctx, sc):
            raise instaloader.exceptions.LoginRequiredException("Login required")
        instaloader.Post.from_shortcode = staticmethod(boom)
        try:
            with tempfile.TemporaryDirectory() as d:
                rec = poc.run_instaloader(post(10), Path(d), loader=SimpleNamespace(context=None))
        finally:
            instaloader.Post.from_shortcode = original
        self.assertEqual(rec["status"], "failed")
        self.assertIn("停損", rec["errors"][0])


class Status(unittest.TestCase):
    def run_save(self, n, expected=10, blocked=(), caption="全文"):
        with tempfile.TemporaryDirectory() as d:
            rec = poc.new_record(post(expected), "x")
            rec["caption"] = caption
            poc.save_media(rec, poc.instaloader_entries(sidecar(n, blocked)), Path(d), fake_download)
            return poc.finish(rec)

    def test_url_is_not_saved(self):
        rec = self.run_save(10, blocked=(7,))
        self.assertEqual(len(rec["media"]), 10)
        self.assertEqual(rec["media_count_saved"], 9)
        self.assertEqual(rec["status"], "partial")
        self.assertIn("403", rec["media"][6]["error"])

    def test_missing_images_and_caption(self):
        self.assertIn("取得 1/10 張", self.run_save(1)["errors"])
        self.assertIn("沒有 caption", self.run_save(10, caption="")["errors"])

    def test_unknown_expected_is_unverified_not_ok(self):
        p = poc.parse_posts([TEST])[0]
        with tempfile.TemporaryDirectory() as d:
            rec = poc.new_record(p, "x")
            rec["caption"] = "全文"
            poc.save_media(rec, poc.instaloader_entries(sidecar(3)), Path(d), fake_download)
            self.assertEqual(poc.finish(rec)["status"], "unverified")


class GalleryDl(unittest.TestCase):
    def test_reads_metadata_files_in_num_order(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)

            def runner(cmd, **kw):
                self.assertNotIn("--cookies", cmd)
                self.assertNotIn("--cookies-from-browser", cmd)
                for num in (2, 1, 3):  # 故意亂序寫出
                    (out / f"{num:02d}.jpg").write_bytes(b"y" * 5)
                    (out / f"{num:02d}.jpg.json").write_text(json.dumps({
                        "num": num, "count": 3, "description": "全文", "username": "someone",
                        "post_date": "2026-10-01 03:04:05", "extension": "jpg", "display_url": f"https://cdn/{num}.jpg"}))
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            rec = poc.run_gallerydl(post(3), out, runner=runner)
        self.assertEqual(rec["status"], "ok")
        self.assertEqual([m["source_url"] for m in rec["media"]], ["https://cdn/1.jpg", "https://cdn/2.jpg", "https://cdn/3.jpg"])
        self.assertEqual(rec["author"], "someone")

    def test_failure_exit_code_recorded(self):
        with tempfile.TemporaryDirectory() as d:
            rec = poc.run_gallerydl(post(10), Path(d), runner=lambda cmd, **kw: SimpleNamespace(
                returncode=4, stdout="", stderr="[instaloader][error] HttpError: '401 Unauthorized' redirect to login page"))
        self.assertEqual(rec["status"], "failed")
        self.assertIn("停損", rec["errors"][0])


class ErrorWording(unittest.TestCase):
    def test_proxy_block_is_not_called_a_login_wall(self):
        msg = poc.classify_error("exit 4: [instagram][error] HttpError:  ProxyError: 403 Forbidden")
        self.assertIn("連線失敗", msg)
        self.assertNotIn("登入", msg)

    def test_login_redirect_is_named(self):
        self.assertIn("停損", poc.classify_error("HttpError: redirect to login page"))


class Compare(unittest.TestCase):
    def test_caption_cross_check(self):
        p = post(1)
        a = dict(poc.new_record(p, "instaloader"), caption="同一段", status="ok")
        b = dict(poc.new_record(p, "gallery-dl"), caption="不同")
        table = poc.compare_markdown([p], [a, b])
        self.assertIn("| instaloader | ok |", table)
        self.assertIn("| 否 |", table)


if __name__ == "__main__":
    unittest.main()
