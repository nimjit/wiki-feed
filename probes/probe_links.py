#!/usr/bin/env python3
"""
probe_links.py — Test body-link extraction (navbox/infobox filtered).

Fetches full article HTML, removes infobox/navbox/table blocks via regex,
then extracts wikilinks from remaining body text.
Run: python3 probe_links.py ["Umberto Eco"]
"""
import json, re, sys
from urllib.request import urlopen, Request
from urllib.parse import urlencode, unquote

USER_AGENT = "WikiFeed/0.1 (probe; github.com/nimjit/wiki-feed)"
ACTION_API = "https://en.wikipedia.org/w/api.php"

def api_get(params):
    params.update({"format": "json", "origin": "*"})
    url = ACTION_API + "?" + urlencode(params)
    req = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(req, timeout=20) as r:
        return json.loads(r.read())

# Classes that typically appear only in navboxes/infoboxes
STRIP_CLASSES = (
    "infobox", "navbox", "navbox-inner", "navbox-subgroup",
    "wikitable", "succession-box", "geography", "sidebar",
    "toc", "hatnote", "thumb", "gallery",
)

def remove_elements(html, tag, classes):
    """Rough removal of <tag class="...CLASSES...">...</tag> blocks."""
    pattern = rf'<{tag}[^>]+class="[^"]*(?:{"|".join(classes)})[^"]*"[^>]*>.*?</{tag}>'
    return re.sub(pattern, '', html, flags=re.DOTALL | re.IGNORECASE)

def extract_body_links(html):
    # Strip navbox/infobox tables and divs
    html = remove_elements(html, "table", STRIP_CLASSES)
    html = remove_elements(html, "div", STRIP_CLASSES)
    # Extract /wiki/Title hrefs
    raw = re.findall(r'href="/wiki/([^"#]+)"', html)
    skip_ns = (
        'File:', 'Image:', 'Category:', 'Help:', 'Wikipedia:',
        'Portal:', 'Template:', 'Talk:', 'Special:', 'User:',
        'WP:', 'MOS:',
    )
    links = []
    seen = set()
    for l in raw:
        title = unquote(l).replace('_', ' ')
        if any(title.startswith(ns) for ns in skip_ns):
            continue
        if title in seen:
            continue
        seen.add(title)
        links.append(title)
    return links

def probe(title):
    print(f"\n{'='*65}")
    print(f"  {title} — body links")
    print(f"{'='*65}")

    # Full article parse (HTML)
    data = api_get({
        "action": "parse",
        "page": title,
        "prop": "text",
        "disabletoc": "1",
        "disableeditsection": "1",
    })
    if "parse" not in data:
        print(f"  ERROR: {data}")
        return

    html = data["parse"]["text"]["*"]
    links = extract_body_links(html)

    print(f"  Body links extracted: {len(links)}")
    print(f"  First 50:")
    for i, l in enumerate(links[:50]):
        print(f"    {i+1:>3}. {l}")

    # Compare with raw prop=links count
    data2 = api_get({
        "action": "query",
        "titles": title,
        "prop": "links",
        "pllimit": "max",
        "plnamespace": "0",
    })
    pages = data2.get("query", {}).get("pages", {})
    for page in pages.values():
        raw_count = len(page.get("links", []))
        print(f"\n  prop=links (all namespaces=0): {raw_count}")
        print(f"  Body-only filtered: {len(links)}")
        print(f"  Ratio: {len(links)/max(1,raw_count):.2f}")

    # Also show reciprocal candidates (would need a second pass in the real algo)
    print(f"\n  Note: reciprocal link weighting requires fetching each candidate's links.")
    print(f"  This is done lazily in the client when candidates are scored.")

if __name__ == "__main__":
    seeds = sys.argv[1:] or ["Umberto Eco"]
    for seed in seeds:
        probe(seed)
