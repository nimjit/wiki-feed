#!/usr/bin/env python3
"""
probe_sections.py — Test section extraction heuristics on Wikipedia articles.

Uses 2 Action API requests per article:
  1. action=parse&prop=sections  → section headings + toclevel
  2. action=parse&prop=text      → full article HTML
Then splits HTML by h2/h3 tag boundaries in Python.
Run: python3 probe_sections.py ["Umberto Eco" "Stoicism" ...]
"""
import json, re, sys, time
from urllib.request import urlopen, Request
from urllib.parse import urlencode

USER_AGENT = "WikiFeed/0.1 (probe; github.com/nimjit/wiki-feed)"
ACTION_API = "https://en.wikipedia.org/w/api.php"

SKIP = {
    "references", "see also", "notes", "external links",
    "bibliography", "works", "further reading", "footnotes",
    "sources", "citations", "notes and references",
    "selected works", "selected bibliography", "partial bibliography",
    "publications", "discography", "filmography", "awards",
    "accolades", "honors", "honours",
}

PREFER = {
    "etymology", "history", "background", "reception", "legacy",
    "interpretation", "controversy", "criticism", "influence",
    "overview", "development", "origin", "significance",
    "philosophy", "thought", "theory", "ideas", "context",
    "analysis", "themes", "concept", "principles",
}

STRIP_CLASSES = (
    "infobox", "navbox", "navbox-inner", "navbox-subgroup",
    "wikitable", "succession-box", "sidebar", "toc",
    "hatnote", "thumb", "gallery", "reflist", "references",
)

def api_get(params):
    params.update({"format": "json", "origin": "*"})
    url = ACTION_API + "?" + urlencode(params)
    req = Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(4):
        try:
            with urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except Exception as e:
            wait = 10 * (2 ** attempt)
            print(f"  [rate limit, waiting {wait}s...]")
            time.sleep(wait)
    raise RuntimeError(f"Failed after retries: {url}")

def remove_elements(html, tag, classes):
    pattern = rf'<{tag}[^>]+class="[^"]*(?:{"|".join(classes)})[^"]*"[^>]*>.*?</{tag}>'
    return re.sub(pattern, '', html, flags=re.DOTALL | re.IGNORECASE)

def strip_html_to_text(html):
    html = remove_elements(html, "table", STRIP_CLASSES)
    html = remove_elements(html, "div", STRIP_CLASSES)
    html = remove_elements(html, "span", ("mw-editsection",))
    text = re.sub(r'<[^>]+>', ' ', html)
    text = re.sub(r'&#?\w+;', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()

def wc(text):
    return len(text.split())

def score_section(heading, word_count, toclevel):
    h = heading.lower().strip()
    if h in SKIP:
        return 0, "SKIP (heading)"
    if word_count < 80:
        return 0, f"SKIP (short: {word_count}w)"
    if word_count > 2000:
        return 0.5, f"ok (very long: {word_count}w)"
    score = 1.0
    note = ""
    if toclevel == 1:
        score += 0.15
    for pref in PREFER:
        if pref in h:
            score += 0.45
            note = f"+pref({pref})"
            break
    if 150 <= word_count <= 900:
        score += 0.1
        note += " +sweet-spot"
    return score, f"score={score:.2f} {note}".strip()

def split_html_by_sections(full_html, sections_meta):
    """
    Split full article HTML into per-section chunks.
    Uses the mw-headline id attribute which matches the section anchor.
    Returns list of (section_meta, html_chunk) pairs.
    """
    # Build anchor → meta index
    anchor_map = {}
    for s in sections_meta:
        # 'anchor' key in sections response, fallback to slugified line
        anchor = s.get("anchor") or re.sub(r'[^a-zA-Z0-9_]', '_', s["line"])
        anchor_map[anchor] = s

    # New Wikipedia HTML puts id directly on the h tag:
    # <h2 id="Career">Career</h2>
    # <h3 id="Medieval_aesthetics..."><span id="...legacy..."></span>...</h3>
    boundary_pattern = re.compile(
        r'<h([23])\s+id="([^"]+)"',
        re.IGNORECASE
    )

    boundaries = []
    for m in boundary_pattern.finditer(full_html):
        level = int(m.group(1))
        anchor = m.group(2)
        pos = m.start()
        boundaries.append((pos, level, anchor))

    if not boundaries:
        return []

    results = []
    for i, (pos, level, anchor) in enumerate(boundaries):
        end = boundaries[i+1][0] if i+1 < len(boundaries) else len(full_html)
        chunk = full_html[pos:end]
        meta = anchor_map.get(anchor)
        if meta:
            results.append((meta, chunk))

    return results

def probe(title):
    print(f"\n{'='*65}")
    print(f"  {title}")
    print(f"{'='*65}")

    # Request 1: section metadata
    meta_data = api_get({
        "action": "parse",
        "page": title,
        "prop": "sections",
    })
    if "parse" not in meta_data:
        print(f"  ERROR: {meta_data}")
        return
    sections_meta = meta_data["parse"]["sections"]
    print(f"  Sections: {len(sections_meta)}")

    time.sleep(1)

    # Request 2: full article HTML
    html_data = api_get({
        "action": "parse",
        "page": title,
        "prop": "text",
        "disableeditsection": "1",
    })
    if "parse" not in html_data:
        print(f"  ERROR: {html_data}")
        return

    full_html = html_data["parse"]["text"]["*"]
    section_chunks = split_html_by_sections(full_html, sections_meta)
    print(f"  Sections matched: {len(section_chunks)}")
    print()

    candidates = []
    for meta, chunk in section_chunks:
        heading = re.sub(r'<[^>]+>', '', meta.get("line", "")).strip()
        toclevel = int(meta.get("toclevel", 1))

        if toclevel > 2:
            print(f"       {'  '*(toclevel-1)}[L{toclevel}] {heading:<42}  (sub-sub, skipped)")
            continue

        text = strip_html_to_text(chunk)
        w = wc(text)
        score, reason = score_section(heading, w, toclevel)

        flag = "  " if score == 0 else ("**" if score >= 1.4 else "+ ")
        indent = "  " * (toclevel - 1)
        print(f"  {flag} {indent}[L{toclevel}] {heading:<42} {w:>5}w  {reason}")

        if score > 0:
            candidates.append((score, heading, text, w))

    # Top 3 previews
    candidates.sort(reverse=True)
    print(f"\n{'─'*65}")
    print(f"  Top candidates — card previews:")
    for score, heading, text, w in candidates[:3]:
        words = text.split()
        preview = " ".join(words[:80])
        print(f"\n  [{score:.2f}] {heading}  ({w}w)")
        print(f"  {preview}...")

if __name__ == "__main__":
    seeds = sys.argv[1:] or ["Umberto Eco", "Stoicism", "Quantum mechanics"]
    for seed in seeds:
        probe(seed)
        time.sleep(2)
