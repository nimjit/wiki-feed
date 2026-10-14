#!/usr/bin/env python3
"""
probe_wikidata.py — Test Wikidata P800 (notable works) + P921 (main subject) expansion.
Uses batched wbgetentities calls (up to 50 IDs) to stay within rate limits.
Run: python3 probe_wikidata.py ["Umberto Eco"]
"""
import json, sys, time
from urllib.request import urlopen, Request
from urllib.parse import urlencode

USER_AGENT = "WikiFeed/0.1 (probe; github.com/nimjit/wiki-feed)"
WD_API = "https://www.wikidata.org/w/api.php"
WP_API = "https://en.wikipedia.org/w/api.php"

def get_json(api, params):
    params["format"] = "json"
    url = api + "?" + urlencode(params)
    req = Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(4):
        try:
            with urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except Exception as e:
            wait = 10 * (2 ** attempt)
            print(f"  [429/error, waiting {wait}s: {e}]")
            time.sleep(wait)
    raise RuntimeError(f"Failed: {url}")

def get_qid(wp_title):
    data = get_json(WP_API, {
        "action": "query",
        "titles": wp_title,
        "prop": "pageprops",
        "ppprop": "wikibase_item",
    })
    for page in data.get("query", {}).get("pages", {}).values():
        return page.get("pageprops", {}).get("wikibase_item")

def get_entities_batch(qids):
    """Fetch labels, sitelinks (enwiki), and claims for up to 50 QIDs in one call."""
    results = {}
    for i in range(0, len(qids), 40):
        batch = qids[i:i+40]
        data = get_json(WD_API, {
            "action": "wbgetentities",
            "ids": "|".join(batch),
            "props": "labels|sitelinks|claims",
            "sitefilter": "enwiki",
            "languages": "en",
            "languagefallback": "1",
        })
        results.update(data.get("entities", {}))
        if i + 40 < len(qids):
            time.sleep(0.5)
    return results

def extract_qid_claims(entity, prop):
    qids = []
    for claim in entity.get("claims", {}).get(prop, []):
        snak = claim.get("mainsnak", {})
        if snak.get("snaktype") == "value":
            val = snak.get("datavalue", {}).get("value", {})
            if isinstance(val, dict) and "id" in val:
                qids.append(val["id"])
    return qids

def label_of(entity):
    return entity.get("labels", {}).get("en", {}).get("value", "?")

def wp_title_of(entity):
    return entity.get("sitelinks", {}).get("enwiki", {}).get("title")

def probe(title):
    print(f"\n{'='*65}")
    print(f"  {title} — Wikidata graph expansion")
    print(f"{'='*65}")

    qid = get_qid(title)
    if not qid:
        print(f"  ERROR: no Wikidata item")
        return
    print(f"  QID: {qid}  https://www.wikidata.org/wiki/{qid}")

    # Fetch seed entity (P800 claims)
    seed_entities = get_entities_batch([qid])
    seed = seed_entities.get(qid, {})
    p800_qids = extract_qid_claims(seed, "P800")
    print(f"\n  P800 (notable works): {len(p800_qids)}")

    if not p800_qids:
        print("  (none found)")
        return

    # Batch-fetch all work entities
    time.sleep(0.5)
    work_entities = get_entities_batch(p800_qids)

    works = []
    print(f"\n  Works + P921 main subjects:")
    for wqid in p800_qids:
        w = work_entities.get(wqid, {})
        wlabel = label_of(w)
        wwp = wp_title_of(w)
        p921_qids = extract_qid_claims(w, "P921")
        print(f"\n  {wlabel}  ({wqid})  wp:{wwp or '—'}")
        works.append((wqid, wlabel, wwp, p921_qids))
        if p921_qids:
            print(f"    P921 QIDs: {p921_qids}")
        else:
            print(f"    P921: (none)")

    # Batch-fetch all P921 subject entities
    all_p921 = list({q for _, _, _, qs in works for q in qs})
    if all_p921:
        time.sleep(0.5)
        subj_entities = get_entities_batch(all_p921)

        print(f"\n\n  Full graph (work → P921 subjects with enwiki articles):")
        graph_nodes = set()
        for wqid, wlabel, wwp, p921_qids in works:
            subjects = []
            for sqid in p921_qids:
                s = subj_entities.get(sqid, {})
                slabel = label_of(s)
                swp = wp_title_of(s)
                if swp:
                    subjects.append((slabel, swp))
                    graph_nodes.add(swp)
            if subjects:
                print(f"\n  {wlabel}:")
                for slabel, swp in subjects:
                    print(f"    → {slabel} ({swp})")

        print(f"\n  Unique article titles the feed would surface via this path: {len(graph_nodes)}")
        for t in sorted(graph_nodes):
            print(f"    {t}")
    else:
        print("\n  No P921 subjects found. Feed will rely on body-link expansion.")
        print("  (This is common — many works lack P921 in Wikidata)")
        print("  Body links from probe_links.py showed 212 good neighbors already.")

if __name__ == "__main__":
    seeds = sys.argv[1:] or ["Umberto Eco"]
    for seed in seeds:
        probe(seed)
