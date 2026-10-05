"""Tạo queue.json cho YT Studio Uploader từ một thư mục video.

    python make_queue.py "E:/0project/vonia/omnivoice/video-output" --match "Vonia*" --visibility public

- Quét file .mp4 (bỏ qua bản -fb/-nhe nếu có bản gốc, trừ khi --prefer-light).
- Ghép thumbnail cùng tên: <video>-thumbnail.jpg (hoặc .png).
- Tiêu đề tạm lấy từ tên thư mục chứa video; mô tả để trống — điền rồi mới chạy.
- Nếu queue.json đã có, giữ nguyên video cũ (kể cả trạng thái đã đăng) và chỉ thêm video mới.
"""
import argparse
import fnmatch
import json
from pathlib import Path

DEFAULTS = {
    "visibility": "private",
    "madeForKids": False,
    "alteredContent": True,
    "videoLanguage": ["Vietnamese", "Tiếng Việt"],
    "titleLanguage": ["Vietnamese", "Tiếng Việt"],
    "tags": [],
}
LIGHT = ("-fb", "-nhe")


def thumbnail_for(video: Path):
    stem = video.stem
    for suffix in LIGHT:
        stem = stem.removesuffix(suffix)
    for ext in (".jpg", ".jpeg", ".png"):
        t = video.with_name(stem + "-thumbnail" + ext)
        if t.exists():
            return t
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root", help="Thư mục gốc (queue.json được ghi vào đây)")
    ap.add_argument("--match", default="*", help="Lọc thư mục con theo mẫu, vd 'Vonia*'")
    ap.add_argument("--visibility", choices=["public", "unlisted", "private"], help="Mặc định private (giữ giá trị cũ nếu queue.json đã có)")
    ap.add_argument("--prefer-light", action="store_true", help="Dùng bản -fb/-nhe thay cho bản gốc")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    out = root / "queue.json"
    queue = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {"defaults": {}, "videos": []}
    queue["defaults"] = {**DEFAULTS, **queue.get("defaults", {})}
    if args.visibility:
        queue["defaults"]["visibility"] = args.visibility
    known = {v["file"] for v in queue["videos"]}

    added = 0
    for video in sorted(root.rglob("*.mp4")):
        rel_dir = video.parent.relative_to(root).as_posix()
        if not fnmatch.fnmatch(rel_dir, args.match) or video.name.startswith("._"):
            continue
        is_light = any(video.stem.endswith(s) for s in LIGHT)
        has_original = is_light and any(video.with_name(video.stem.removesuffix(s) + ".mp4").exists() for s in LIGHT if video.stem.endswith(s))
        has_light = any(video.with_name(video.stem + s + ".mp4").exists() for s in LIGHT)
        if (is_light and has_original and not args.prefer_light) or (not is_light and has_light and args.prefer_light):
            continue
        rel = video.relative_to(root).as_posix()
        if rel in known:
            continue
        thumb = thumbnail_for(video)
        queue["videos"].append({
            "file": rel,
            "thumbnail": thumb.relative_to(root).as_posix() if thumb else None,
            "title": video.parent.name if rel_dir != "." else video.stem,
            "description": "",
            "tags": [],
        })
        added += 1

    out.write_text(json.dumps(queue, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{out}: thêm {added} video, tổng {len(queue['videos'])}. Nhớ điền tiêu đề/mô tả trước khi chạy.")


if __name__ == "__main__":
    main()
