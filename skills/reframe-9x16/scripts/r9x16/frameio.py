"""Frame.io share acquisition. Order: API (v2 legacy token or v4 Adobe IMS token) -> share page download
button in a headless browser -> stop and tell the user exactly what is needed. Never scrapes the
streaming proxy."""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path
from typing import List, Optional
from urllib.parse import urlparse

import requests

from .media import VIDEO_EXT

API = "https://api.frame.io"


class NeedsUser(Exception):
    """Raised when we cannot get originals without something from the user."""


def resolve(url: str) -> str:
    r = requests.get(url, allow_redirects=True, timeout=60, headers={"User-Agent": "Mozilla/5.0 reframe-9x16"})
    return r.url


def parse_share(url: str) -> dict:
    u = urlparse(url)
    parts = [p for p in u.path.split("/") if p]
    info = dict(url=url, host=u.netloc, kind=None, id=None, asset=None)
    if parts:
        if parts[0] in ("reviews", "presentations", "share", "s"):
            info["kind"] = parts[0]
            info["id"] = parts[1] if len(parts) > 1 else None
            if len(parts) > 3 and parts[2] == "view":
                info["asset"] = parts[3]
            elif len(parts) > 2 and parts[0] == "reviews":
                info["asset"] = parts[2]
    return info


def _get(url, token=None, params=None):
    h = {"Accept": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    r = requests.get(url, headers=h, params=params, timeout=60)
    if r.status_code >= 400:
        raise requests.HTTPError(f"{r.status_code} {url}: {r.text[:200]}")
    return r.json()


def _download(url: str, dst: Path):
    tmp = dst.with_suffix(dst.suffix + ".part")
    with requests.get(url, stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(4 << 20):
                f.write(chunk)
    tmp.rename(dst)


def _is_video_name(name: str, filetype: str = "") -> bool:
    if filetype and filetype.startswith("video/"):
        return True
    return Path(name).suffix.lower() in VIDEO_EXT


# ----------------------------------------------------------------------------- legacy v2 API
def _v2_collect(asset: dict, token, out: list):
    t = asset.get("type") or asset.get("_type")
    if t == "folder":
        for ch in _get(f"{API}/v2/assets/{asset['id']}/children", token):
            _v2_collect(ch, token, out)
    elif t == "version_stack":
        kids = _get(f"{API}/v2/assets/{asset['id']}/children", token)
        if kids:
            latest = max(kids, key=lambda k: (k.get("inserted_at") or "", k.get("index") or 0))
            _v2_collect(latest, token, out)
    elif t == "file":
        if _is_video_name(asset.get("name", ""), asset.get("filetype", "")):
            out.append(dict(name=asset["name"], url=asset.get("original"), id=asset["id"], size=asset.get("filesize")))


def acquire_v2(info: dict, token: str, dest: Path) -> tuple:
    rid = info["id"]
    if info["kind"] == "reviews":
        link = _get(f"{API}/v2/review_links/{rid}", token)
        items = _get(f"{API}/v2/review_links/{rid}/items", token)
        assets = []
        for it in items:
            aid = it.get("asset_id") or (it.get("asset") or {}).get("id")
            assets.append(_get(f"{API}/v2/assets/{aid}", token))
        name = link.get("name") or rid
    elif info["kind"] == "presentations":
        pres = _get(f"{API}/v2/presentations/{rid}", token)
        assets = [_get(f"{API}/v2/assets/{pres['asset_id']}", token)]
        name = pres.get("title") or rid
    else:
        raise NeedsUser("not a legacy share URL")
    files = []
    for a in assets:
        _v2_collect(a, token, files)
    return name, _fetch_all(files, dest)


# ----------------------------------------------------------------------------- v4 API (Adobe IMS)
def _v4_collect(acct: str, item: dict, token, out: list):
    t = item.get("type")
    iid = item["id"]
    if t == "folder":
        for ch in _get(f"{API}/v4/accounts/{acct}/folders/{iid}/children", token).get("data", []):
            _v4_collect(acct, ch, token, out)
    elif t == "version_stack":
        kids = _get(f"{API}/v4/accounts/{acct}/version_stacks/{iid}/children", token).get("data", [])
        if kids:
            latest = max(kids, key=lambda k: k.get("created_at") or "")
            _v4_collect(acct, latest, token, out)
    elif t == "file":
        f = _get(f"{API}/v4/accounts/{acct}/files/{iid}", token, params={"include": "media_links.original"}).get("data", {})
        if _is_video_name(f.get("name", ""), f.get("media_type", "")):
            url = ((f.get("media_links") or {}).get("original") or {}).get("download_url")
            out.append(dict(name=f["name"], url=url, id=iid, size=f.get("file_size")))


def acquire_v4(info: dict, token: str, dest: Path) -> tuple:
    sid = info["id"]
    accounts = _get(f"{API}/v4/accounts", token).get("data", [])
    last_err = None
    for acct in accounts:
        aid = acct["id"]
        try:
            share = _get(f"{API}/v4/accounts/{aid}/shares/{sid}", token).get("data", {})
            assets = _get(f"{API}/v4/accounts/{aid}/shares/{sid}/assets", token).get("data", [])
        except requests.HTTPError as e:
            last_err = e
            continue
        files = []
        for a in assets:
            _v4_collect(aid, a, token, files)
        return share.get("name") or sid, _fetch_all(files, dest)
    raise NeedsUser(f"share {sid} not found in any account reachable with this token ({last_err})")


def _fetch_all(files: list, dest: Path) -> List[Path]:
    dest.mkdir(parents=True, exist_ok=True)
    got = []
    missing = [f["name"] for f in files if not f.get("url")]
    if missing:
        raise NeedsUser("original download URLs are not exposed for: " + ", ".join(missing) +
                        " (downloads are probably disabled on the share)")
    for f in files:
        dst = dest / f["name"]
        if dst.exists() and f.get("size") and dst.stat().st_size == f["size"]:
            got.append(dst)
            continue
        print(f"[frameio] downloading {f['name']} ...", file=sys.stderr)
        _download(f["url"], dst)
        got.append(dst)
    return got


# ----------------------------------------------------------------------------- browser fallback
def acquire_browser(url: str, dest: Path, timeout_s: int = 900) -> tuple:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise NeedsUser("no API token and playwright is not installed for the browser fallback (pip install playwright)")
    dest.mkdir(parents=True, exist_ok=True)
    got = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(accept_downloads=True)
        page = ctx.new_page()
        page.goto(url, wait_until="networkidle", timeout=120000)
        title = page.title() or "share"
        # Frame.io share pages expose a Download button / menu per asset; try the common selectors.
        candidates = ["button:has-text('Download')", "[aria-label*='Download' i]", "text=/^Download/i",
                      "[data-testid*='download' i]"]
        clicked = False
        for sel in candidates:
            try:
                loc = page.locator(sel).first
                if loc.count() and loc.is_visible():
                    with page.expect_download(timeout=timeout_s * 1000) as dl:
                        loc.click()
                    d = dl.value
                    for opt in ("Original", "original", "Highest"):
                        pass
                    path = dest / d.suggested_filename
                    d.save_as(str(path))
                    got.append(path)
                    clicked = True
                    break
            except Exception:
                continue
        browser.close()
    if not clicked:
        raise NeedsUser("share page has no usable Download button (downloads disabled on the share, or login required)")
    return title, got


# ----------------------------------------------------------------------------- entry point
def acquire(url: str, dest: Path, token: str = "") -> tuple:
    """Returns (share_name, [downloaded video paths]). Raises NeedsUser with an exact ask."""
    try:
        final = resolve(url)
    except requests.RequestException as e:
        raise NeedsUser(f"cannot reach Frame.io from this machine ({e.__class__.__name__}: {str(e)[:160]}). "
                        "Either allow f.io / app.frame.io / next.frame.io / api.frame.io on this network, "
                        "or drop the originals into the job's source/ folder and re-run with the folder path.")
    info = parse_share(final)
    print(f"[frameio] {url} -> {final}", file=sys.stderr)
    errors = []
    if token:
        for fn in (acquire_v4, acquire_v2):
            try:
                return fn(info, token, dest)
            except NeedsUser as e:
                errors.append(str(e))
            except Exception as e:
                errors.append(f"{fn.__name__}: {e}")
    else:
        errors.append("no FRAMEIO_TOKEN in environment")
    try:
        return acquire_browser(final, dest)
    except NeedsUser as e:
        errors.append(str(e))
    raise NeedsUser("could not download originals from the share.\n  - " + "\n  - ".join(errors) +
                    "\nNeed one of: (a) enable downloads on the share, (b) a Frame.io API token in FRAMEIO_TOKEN, "
                    "or (c) the original files dropped into the job's source/ folder.")
