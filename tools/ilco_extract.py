#!/usr/bin/env python3
"""
ilco_extract.py — pull vehicle key data out of the Ilco key reference guide PDF
and write it in the pipe-delimited format that Lock & Scroll's
"Paste Ilco Reference" importer understands:

    Make | Model | Years | Application | Code Series | Key Blank | Substitutes

Fully offline: the only dependency is pdfplumber. You run this on your own
computer against the full PDF, then paste the output into the app
(Vehicle Lookup -> Antique Reference -> "Paste Ilco Reference").

Quick start
-----------
    pip install pdfplumber
    python ilco_extract.py GUIDE.pdf --pages 13-14 --preview 40   # sample first
    python ilco_extract.py GUIDE.pdf --out ilco_output.txt        # whole guide
    python ilco_extract.py GUIDE.pdf --split-by-make              # file per make
    python ilco_extract.py --selftest                             # no PDF needed

How it works
------------
The guide is a bordered table with merged cells: a model name like "MDX" is
printed once, roughly centered beside all its rows; year ranges are centered
beside their All/Valet application rows; a key-blank cell often spans several
text lines ("OEM# 72147-TZ5-A01/A11 or" / "72147-TZ5-A11"). Reading the text
in stream order scrambles all of that.

Instead, this script uses word COORDINATES (pdfplumber gives every word an
x/y position):

1. Words are bucketed into the table's columns by x-position. The column
   x-boundaries were measured from the real guide (783pt-wide pages) and are
   scaled to the page width.
2. Words are clustered into physical text lines by y-position.
3. Every line with a Lock-Apps value (All / Valet / ...) anchors one output
   row ("band"). Midpoints between anchors decide which neighboring lines
   (blank-cell continuations, OEM# lines) belong to which band.
4. Yearless bands inherit the nearest year line (year cells are vertically
   centered across the All+Valet rows they cover). Models come from the
   nearest model-column label; a label printed on an anchor line starts its
   model there, so earlier bands can't claim it. Make headers (a known make
   name in the model column, e.g. ALFA ROMEO) switch the current make, which
   also carries across pages.

The --selftest runs this engine over a captured word dump of the guide's real
Acura pages (tools/fixtures/acura_p13_p14.txt) and checks the output rows, so
the parsing logic is verified without needing the PDF.
"""

import argparse
import os
import re
import sys

EXTRACTOR_VERSION = "2.1-geometry"

# --------------------------------------------------------------------------
# Reference geometry (measured from the real guide; pages are 783pt wide).
# Each column is (name, x_start, x_end) in that reference width.
# --------------------------------------------------------------------------
REF_WIDTH = 783.0
COLUMNS = [
    ("model", 0, 115),
    ("start", 115, 146),
    ("end", 146, 166),
    ("apps", 166, 193),
    ("series", 193, 246),
    ("blank", 246, 339),
    ("equip", 339, 485),   # cloning tools — ignored
    ("subs", 485, 562),
    ("notes", 562, 728),   # transponder text — ignored
    ("card", 728, 10000),  # card number — ignored
]

LINE_TOL = 2.5        # y-distance for words to count as the same text line
MODEL_MERGE_TOL = 12  # wrapped model labels ("ZDX W/ REGULAR" + "IGNITION")
BAND_CAP = 26         # band reach when not bounded by a neighboring anchor
YEAR_REACH = 40       # how far a band may look for its year line
ON_LINE_TOL = 2       # model label counts as "on" an anchor line within this

KNOWN_MAKES = [
    "Acura", "Alfa Romeo", "AMC", "American Motors", "Aston Martin", "Audi",
    "BMW", "Buick", "Cadillac", "Chevrolet", "Chrysler", "Daewoo", "Daihatsu",
    "Dodge", "Eagle", "Ferrari", "Fiat", "Ford", "Freightliner", "Genesis",
    "Geo", "GMC", "Honda", "Hummer", "Hyundai", "Infiniti", "International",
    "Isuzu", "Jaguar", "Jeep", "Kenworth", "Kia", "Lamborghini", "Land Rover",
    "Lexus", "Lincoln", "Lotus", "Mack Truck", "Maserati", "Mazda",
    "Mercedes", "Mercedes Benz", "Mercury", "Merkur", "MG", "Mini",
    "Mitsubishi", "Nissan", "Oldsmobile", "Peterbilt", "Peugeot", "Plymouth",
    "Pontiac", "Porsche", "Ram", "Renault", "Rolls Royce", "Rover", "Saab",
    "Saturn", "Scion", "Smart", "Sterling", "Subaru", "Suzuki", "Tesla",
    "Toyota", "Triumph", "Volkswagen", "Volvo", "White-GMC-Volvo", "Yugo",
]
KNOWN_MAKES_LOWER = {m.lower(): m for m in KNOWN_MAKES}

# Fold guide spelling variants into ONE canonical make (same table as the app).
MAKE_ALIASES = {
    "chevy": "Chevrolet", "chev": "Chevrolet",
    "vw": "Volkswagen",
    "mercedes": "Mercedes Benz", "mercedes-benz": "Mercedes Benz",
    "datsun": "Nissan", "datsun (nissan)": "Nissan",
    "international harvester": "International",
    "rolls-royce": "Rolls Royce",
}
# Section suffixes: "TOYOTA TRUCKS, VANS, SUVS" -> "Toyota".
SECTION_SUFFIX_RE = re.compile(
    r"[\s,]+(trucks?|vans?|suvs?|minivans?|cars?|passenger|imports?)\b.*$",
    re.IGNORECASE,
)

APPLICATION_CANON = {
    "ignition": "Ignition", "ign": "Ignition", "ign.": "Ignition",
    "door": "Door", "doors": "Door",
    "trunk": "Trunk",
    "glovebox": "GB", "glove box": "GB", "gb": "GB",
    "door/trunk": "Door/Trunk", "trunk/door": "Door/Trunk",
    "ignition/door": "Ignition/Door", "door/ignition": "Ignition/Door",
    "trunk/gb": "Trunk/GB", "gb/trunk": "Trunk/GB",
    "door/gb": "Door/GB",
    "all": "All", "valet": "Valet",
}

YEAR_RE = re.compile(r"^(19|20)\d{2}$")
HEADER_WORDS = {"apps", "series", "(plastic)", "substitues", "substitutes",
                "transponder", "equipment"}
# Blank-cell tokens that are markers/noise, never part numbers.
BLANK_DROP = {"oem#", "or", "-", "–"}
SUBS_DROP = {"service", "key", "-", "–", "emerg.", "emerg", "emergency"}


# --------------------------------------------------------------------------
# Normalization helpers
# --------------------------------------------------------------------------

ACRONYM_MAKES = {"BMW", "GMC", "VW", "MG", "AMC", "AM"}


def _title_words(s, keep_len=3):
    out = []
    for w in s.split():
        if w.upper() in ACRONYM_MAKES or (w.isupper() and len(w) <= keep_len):
            out.append(w.upper() if w.upper() in ACRONYM_MAKES else w)
        elif w.isupper():
            out.append(w.capitalize())
        else:
            out.append(w)
    return " ".join(out)


def normalize_make(raw):
    m = " ".join(str(raw or "").split()).strip(" ,")
    if not m:
        return ""
    low = m.lower()
    if low in MAKE_ALIASES:
        return MAKE_ALIASES[low]
    if low in KNOWN_MAKES_LOWER:
        return KNOWN_MAKES_LOWER[low]
    stripped = SECTION_SUFFIX_RE.sub("", m).strip(" ,")
    slow = stripped.lower()
    if slow in MAKE_ALIASES:
        return MAKE_ALIASES[slow]
    if slow in KNOWN_MAKES_LOWER:
        return KNOWN_MAKES_LOWER[slow]
    return _title_words(stripped or m)


def normalize_application(app):
    a = " ".join(str(app or "").split())
    if not a:
        return ""
    key = re.sub(r"\s*/\s*", "/", a.lower())
    return APPLICATION_CANON.get(key, a)


def normalize_model(raw):
    s = " ".join(str(raw or "").split()).strip(" ,.")
    # The guide's catch-all rows ("Models and Years not referenced elsewhere")
    s_low = s.lower()
    if "not referenced" in s_low or s_low == "elsewhere" or s_low == "all":
        return "All Models"
    s = _title_words(s)
    return re.sub(r"\bW/", "w/", s)


def is_make_text(text):
    t = " ".join(text.split()).strip(" ,").lower()
    if t in KNOWN_MAKES_LOWER or t in MAKE_ALIASES:
        return True
    stripped = SECTION_SUFFIX_RE.sub("", t).strip(" ,")
    return stripped in KNOWN_MAKES_LOWER or stripped in MAKE_ALIASES


# --------------------------------------------------------------------------
# Blank / substitutes cell cleanup
# --------------------------------------------------------------------------

def _expand_oem_suffixes(names):
    """['72147-TZ5-A01', 'A11'] -> ['72147-TZ5-A01', '72147-TZ5-A11'].
    Only OEM-style PNs (two or more dashes) spawn suffix variants, so a short
    code after a normal blank ('HU66-GTS', 'T48') is left alone."""
    out = []
    for p in names:
        if out and out[-1].count("-") >= 2 and "-" not in p and re.fullmatch(r"[A-Z]\d{2}", p):
            out.append(out[-1].rsplit("-", 1)[0] + "-" + p)
        else:
            out.append(p)
    return out


def clean_part_tokens(tokens, drop):
    """Blank/subs cell tokens -> list of part names (slash groups expanded)."""
    names = []
    for tok in tokens:
        t = tok.strip().strip(",")
        if not t or t.lower() in drop:
            continue
        # variant brackets like "[-P]", "[-P,", "-PC]"
        if t.startswith("[") or t.endswith("]"):
            continue
        # parenthetical notes: "(LAL)", or inline "HO03-PT(V)" -> "HO03-PT"
        t = re.sub(r"\([^)]*\)", "", t).strip().strip(",")
        if not t or t.lower() in drop:
            continue
        t = t.rstrip("*#")          # footnote markers
        t = t.strip("/")            # continuation slashes at either end
        if not t or not re.search(r"\d", t):
            continue                # real part names always carry a digit
        for piece in t.split("/"):
            piece = piece.rstrip("*#")
            # Drop shrapnel from wrapped part-number lists ("13", "9", "0")
            if len(piece) < 2 or (piece.isdigit() and len(piece) < 4):
                continue
            names.append(piece)
    out = []
    for n in _expand_oem_suffixes(names):
        if n not in out:
            out.append(n)
    return out


# --------------------------------------------------------------------------
# Geometry engine: words -> rows
# --------------------------------------------------------------------------

def _col_of(x, width):
    scale = width / REF_WIDTH if width else 1.0
    for name, lo, hi in COLUMNS:
        if lo * scale <= x < hi * scale:
            return name
    return "card"


def cluster_lines(words, width):
    """Words ({x0, top, text}) -> [{y, cols:{col:[(x,text)]}, texts:set}]."""
    lines = []
    cur = None
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        if cur is None or w["top"] - cur["y0"] > LINE_TOL:
            cur = {"y0": w["top"], "ys": [w["top"]], "words": [w]}
            lines.append(cur)
        else:
            cur["ys"].append(w["top"])
            cur["words"].append(w)
    out = []
    for ln in lines:
        cols = {}
        for w in sorted(ln["words"], key=lambda w: w["x0"]):
            cols.setdefault(_col_of(w["x0"], width), []).append((w["x0"], w["text"]))
        out.append({
            "y": sum(ln["ys"]) / len(ln["ys"]),
            "cols": cols,
            "text": " ".join(w["text"] for w in sorted(ln["words"], key=lambda w: w["x0"])),
        })
    return out


def _col_text(line, col):
    return " ".join(t for _, t in line["cols"].get(col, []))


def _line_years(line):
    """(startYear, endYear) if the line carries year cells, else None."""
    sy = [t for _, t in line["cols"].get("start", []) if YEAR_RE.match(t)]
    ey = [t for _, t in line["cols"].get("end", []) if YEAR_RE.match(t)]
    if sy and ey:
        a, b = int(sy[0]), int(ey[0])
        return (min(a, b), max(a, b))
    if sy:
        return (int(sy[0]), int(sy[0]))
    return None


def _is_header_or_footer(line):
    words = {t.lower().strip(",.") for _, ws in line["cols"].items() for _, t in ws}
    if words & HEADER_WORDS:
        return True
    if "page" in words and any(t.isdigit() for t in words):
        return True
    if "(lal):" in words or "look-alike" in words:
        return True
    return False


def _rules_crossing(edges, col, width):
    """Y positions of horizontal table borders that span the given column —
    these are the real cell boundaries, better than any midpoint guess."""
    if not edges:
        return []
    scale = width / REF_WIDTH if width else 1.0
    lo, hi = next((l, h) for n, l, h in COLUMNS if n == col)
    ys = sorted(e["top"] for e in edges
                if e.get("x0", 0) <= (lo + 6) * scale and e.get("x1", 0) >= (hi - 6) * scale)
    out = []
    for y in ys:
        if not out or y - out[-1] > 2:
            out.append(y)
    return out


def _cell_extent(y, rules):
    """(top, bottom) rule pair enclosing y; None side = unbounded."""
    above = max((r for r in rules if r <= y), default=None)
    below = min((r for r in rules if r > y), default=None)
    return above, below


def parse_page(words, width, state, edges=None):
    """One page of words -> row dicts. `state` carries make/model across pages.
    `edges` (pdfplumber horizontal_edges) supplies the table's real cell
    borders when available; heuristics fill in when they're missing."""
    lines = [ln for ln in cluster_lines(words, width)]

    # Page-label make hint: a header like "ACURA - ALFA ROMEO" or footer "ACURA"
    page_make_hint = ""
    for ln in lines:
        m = re.match(r"^(?:Page \d+ )?([A-Z][A-Z .,&-]+)$", ln["text"].strip())
        if m and ln["cols"].get("model") is None:
            first = re.split(r"\s+-\s+", m.group(1))[0].strip()
            if is_make_text(first):
                page_make_hint = normalize_make(first)
                break

    lines = [ln for ln in lines if not _is_header_or_footer(ln)]

    # ---- anchors ----
    # Application anchors: a Lock-Apps value marks one output row.
    anchors = []
    for ln in lines:
        app = _col_text(ln, "apps")
        if app and re.sub(r"\s*/\s*", "/", app.lower()) in APPLICATION_CANON:
            anchors.append(ln)
    if not anchors:
        return []  # index/front-matter page

    # Make headers: a known make name sitting in the model column.
    make_anchors = []
    # Model labels (may wrap onto two lines -> merge close ones).
    model_anchors = []
    for ln in lines:
        mtext = _col_text(ln, "model")
        if not mtext:
            continue
        if is_make_text(mtext):
            make_anchors.append((ln["y"], normalize_make(mtext)))
        else:
            # A wrapped label continues the one above: very close vertically,
            # or a bit farther when the text itself signals continuation
            # ("Caprice PPV (police &" + "Detective)").
            merged = False
            if model_anchors:
                py, ptext = model_anchors[-1]
                dy = ln["y"] - py
                cont = (ptext.rstrip().endswith(("&", ",", "(", "-", "/"))
                        or mtext[:1].islower()
                        or (mtext.endswith(")") and "(" not in mtext))
                if dy <= MODEL_MERGE_TOL or (dy <= 24 and cont):
                    model_anchors[-1] = ((py + ln["y"]) / 2, ptext + " " + mtext)
                    merged = True
            if not merged:
                model_anchors.append((ln["y"], mtext))
    # A model label printed ON an anchor line starts its model there — earlier
    # bands can't belong to it. Centered labels (between anchor lines) can be
    # claimed from either direction.
    anchor_ys = [a["y"] for a in anchors]
    model_marks = []
    for my, mtext in model_anchors:
        on_line = any(abs(my - ay) <= ON_LINE_TOL for ay in anchor_ys)
        model_marks.append({"y": my, "text": normalize_model(mtext), "on_line": on_line})

    year_lines = [(ln["y"], _line_years(ln)) for ln in lines if _line_years(ln)]

    # Series values, page-wide. A long range can wrap onto two lines
    # ("HB10001-" / "HB241009") — re-join fragments before assignment.
    raw_series = [(ln["y"], _col_text(ln, "series")) for ln in lines if _col_text(ln, "series")]
    series_items = []
    j = 0
    while j < len(raw_series):
        y, t = raw_series[j]
        if (t.rstrip().endswith("-") and j + 1 < len(raw_series)
                and raw_series[j + 1][0] - y <= 16):
            y2, t2 = raw_series[j + 1]
            series_items.append(((y + y2) / 2, t.rstrip() + t2.strip()))
            j += 2
        else:
            series_items.append((y, t))
            j += 1

    # Cell-border rules per column (empty lists when the PDF has none)
    apps_rules = _rules_crossing(edges, "apps", width)
    model_rules = _rules_crossing(edges, "model", width)
    start_rules = _rules_crossing(edges, "start", width)

    # ---- band boundaries: real cell borders when present, else midpoints ----
    bounds = []
    for i, ay in enumerate(anchor_ys):
        lo = (anchor_ys[i - 1] + ay) / 2 if i > 0 else ay - BAND_CAP
        hi = (ay + anchor_ys[i + 1]) / 2 if i + 1 < len(anchor_ys) else ay + BAND_CAP
        if apps_rules:
            above, below = _cell_extent(ay, apps_rules)
            if above is not None and ay - above <= 40:
                lo = above
            if below is not None and below - ay <= 40:
                hi = below
        bounds.append((lo, hi))

    def band_index(y):
        for i, (lo, hi) in enumerate(bounds):
            if lo <= y < hi:
                return i
        return None

    # Multi-line blank cells mark continuation explicitly: a token ending in
    # "/" (EK3P-HO03/EK3LB-HO03*/) or an "or" (OEM# 72147-TZ5-A01 or) means the
    # next blank line belongs to the SAME row even if the midpoint puts it in
    # the neighboring band. Record those forced assignments.
    forced = {}  # id(line) -> band index
    blank_lines = [ln for ln in lines if ln["cols"].get("blank")]
    for j, ln in enumerate(blank_lines):
        toks = [t for _, t in ln["cols"]["blank"]]
        continues = toks[-1].endswith("/") or toks[-1].lower() == "or"
        if continues and j + 1 < len(blank_lines):
            nxt = blank_lines[j + 1]
            if 0 < nxt["y"] - ln["y"] <= 14:
                bi = forced.get(id(ln), band_index(ln["y"]))
                if bi is not None:
                    forced[id(nxt)] = bi

    rows = []
    for i, anchor in enumerate(anchors):
        ay = anchor["y"]
        lo, hi = bounds[i]
        band = [ln for ln in lines
                if forced.get(id(ln), band_index(ln["y"])) == i]

        application = normalize_application(_col_text(anchor, "apps"))

        # Years: on the anchor line; else the year cell whose borders contain
        # this row; else the nearest year line (year cells are vertically
        # centered across the rows they span).
        years = _line_years(anchor)
        if not years and start_rules:
            for yy, yr in year_lines:
                above, below = _cell_extent(yy, start_rules)
                if (above is None or above <= ay) and (below is None or ay < below):
                    years = yr
                    break
        if not years:
            cands = [(abs(yy - ay), yr) for yy, yr in year_lines if abs(yy - ay) <= YEAR_REACH]
            if cands:
                years = min(cands)[1]
        if not years:
            years = state.get("last_years")
        if not years:
            continue
        state["last_years"] = years

        # Code series: value on the anchor line, else the (fragment-joined)
        # value centered beside this row. Kept tight so a row with a genuinely
        # empty series cell doesn't borrow its neighbor's.
        series = ""
        on_line = [t for y, t in series_items if abs(y - ay) <= ON_LINE_TOL]
        if on_line:
            series = on_line[0]
        else:
            near = [(abs(y - ay), t) for y, t in series_items
                    if abs(y - ay) <= 14 and lo - 2 <= y < hi + 2]
            if near:
                series = min(near)[1]

        # Key blanks / substitutes: every part token inside the band.
        blank_tokens, subs_tokens = [], []
        for ln in band:
            blank_tokens += [t for _, t in ln["cols"].get("blank", [])]
            subs_tokens += [t for _, t in ln["cols"].get("subs", [])]
        blanks = clean_part_tokens(blank_tokens, BLANK_DROP)
        subs = clean_part_tokens(subs_tokens, SUBS_DROP)

        # Make: last make header above this row (carries across pages).
        for my, mk in make_anchors:
            if my <= ay:
                state["make"] = mk
                state["model"] = ""
        if not state.get("make"):
            state["make"] = page_make_hint

        # Model. Preferred: the label whose model-column cell (real table
        # borders) contains this row. Fallback: nearest label, where an
        # on-line label starts its model at its own line — it can't claim
        # earlier bands and acts as a barrier for labels below it.
        assigned = None
        if model_rules:
            for mark in model_marks:
                m_top, m_bot = _cell_extent(mark["y"], model_rules)
                if (m_top is None or m_top <= ay) and (m_bot is None or ay < m_bot):
                    assigned = mark["text"]
                    break

        if assigned is None:
            def blocked(mark):
                if mark["on_line"] and ay < mark["y"] - ON_LINE_TOL:
                    return True
                if mark["y"] > ay:  # any on-line label strictly between?
                    return any(m["on_line"] and ay < m["y"] - ON_LINE_TOL and m["y"] < mark["y"]
                               for m in model_marks)
                return False

            cands = [(abs(m["y"] - ay), m["text"]) for m in model_marks if not blocked(m)]
            if cands:
                assigned = min(cands)[1]
            elif not state.get("model") and model_marks:
                # Page-top rows continuing a model from the previous page, with
                # no carryover available: fall back to the nearest label below.
                assigned = min((abs(m["y"] - ay), m["text"]) for m in model_marks)[1]

        if assigned is not None:
            state["model"] = assigned
        model = state.get("model") or "All Models"

        rows.append({
            "make": state.get("make", ""),
            "model": model,
            "years": f"{years[0]}-{years[1]}" if years[0] != years[1] else str(years[0]),
            "application": application,
            "codeSeries": series,
            "blank": "/".join(blanks),
            "substitutes": "/".join(subs),
        })

    # A make header printed BELOW the last data row (a new section starting at
    # the bottom of the page, e.g. "ALFA ROMEO") applies to the next page.
    last_ay = anchor_ys[-1]
    for my, mk in make_anchors:
        if my > last_ay:
            state["make"] = mk
            state["model"] = ""
    return rows


def format_row(r):
    return " | ".join([
        r["make"], r["model"], r["years"], r["application"],
        r["codeSeries"], r["blank"], r["substitutes"],
    ]).rstrip(" |")


# --------------------------------------------------------------------------
# PDF input
# --------------------------------------------------------------------------

def parse_pdf(pdf_path, pages=None):
    import pdfplumber
    rows = []
    state = {}
    with pdfplumber.open(pdf_path) as pdf:
        page_list = pdf.pages
        if pages:
            lo, hi = pages
            page_list = pdf.pages[lo - 1:hi]
        for page in page_list:
            words = page.extract_words(use_text_flow=False, keep_blank_chars=False)
            try:
                h_edges = page.horizontal_edges
            except Exception:
                h_edges = None
            rows += parse_page(words, page.width, state, edges=h_edges)
    return rows


# --------------------------------------------------------------------------
# Self-test: run the engine over the captured Acura pages fixture
# --------------------------------------------------------------------------

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "fixtures", "acura_p13_p14.txt")


def load_fixture(path):
    """Fixture format: 'PAGE <n> <width>' then '<x> <y> <text>' lines."""
    pages = []
    with open(path) as fh:
        for raw in fh:
            raw = raw.rstrip("\n")
            if not raw.strip():
                continue
            if raw.startswith("PAGE "):
                _, _, width = raw.split()
                pages.append({"width": float(width), "words": []})
            else:
                x, y, text = raw.split(None, 2)
                pages[-1]["words"].append({"x0": float(x), "top": float(y), "text": text})
    return pages


def selftest():
    pages = load_fixture(FIXTURE)
    state = {}
    rows = []
    for p in pages:
        rows += parse_page(p["words"], p["width"], state)
    got = [format_row(r) for r in rows]
    for line in got:
        print("  ", line)

    def has(prefix):
        return any(g.startswith(prefix) for g in got)

    checks = [
        # Merged model cell + years centered across All/Valet rows
        "Acura | MDX | 2007-2013 | All | K001-N718 | HO03-PT/EK3P-HO03/EK3LB-HO03/HO03-GTK | HO01-SVC",
        "Acura | MDX | 2001-2006 | All | 5001-8442 | HD106-PT/HD106-PT5 | HD103-NP",
        "Acura | MDX | 2001-2006 | Valet | 5001-8442 | HD107-PT/HD107-PT5 | HD103-NP",
        # OEM# multi-line cell with A01/A11 suffix expansion
        "Acura | MDX | 2014-2017 | All | K001-N718 | 72147-TZ5-A01/72147-TZ5-A11 | HO01-SVC",
        # Model label centered over its whole span (NSX), old X-style blanks
        "Acura | NSX | 1991-1996 | All | 5001-8442 | X204/HD99 | X214/HD103",
        "Acura | NSX | 1991-1996 | Valet | 5001-8442 | X205/HD100",
        # Band with no code series at all (2022+ prox)
        "Acura | RDX | 2022-2025 | All |  | 72147-TJB-A21/72147-TJB-A31",
        # On-line model label must not claim earlier bands (TL vs TLX)
        "Acura | TL | 1995-1998 | All | 5001-8442 | X214/HD103",
        "Acura | TLX Base | 2021-2025 | All | K001-N718 | 72147-TGV-A01/72147-TGV-A11",
        # Model between two candidates resolves by distance (TSX not TLX)
        "Acura | TSX | 2009-2014 | All | K001-N718 | HO03-PT/EK3P-HO03/EK3LB-HO03/HO03-GTK",
        # Substitutes column with X-style names
        "Acura | Vigor | 1992-1994 | All | 3001-4481 | X208/HD101 | X183/HD92",
        "Acura | Vigor | 1992-1994 | Valet | 3001-4481 | X209/HD102 | X189/HD93",
        # Wrapped model label ("ZDX W/ REGULAR" + "IGNITION")
        "Acura | ZDX w/ Regular Ignition | 2010-2012 | All | K001-N718",
        # Model label on its own anchor line (prox variant vs base model)
        "Acura | TL w/ Prox | 2009-2014 | All | K001-N718 | 72147-TK4-A71/72147-TK4-A81",
        # Trailing-"/" continuation must not leak into the next band (Vigor
        # keeps only its own X-blanks; TSX keeps its GTK line)
        "Acura | TSX | 2004-2008 | All | 5001-8442 | HD111-PT/EK3P-HD111/EK3LB-HD111/HD111-GTK",
    ]
    ok = True
    for c in checks:
        if not has(c):
            print("FAIL missing:", c)
            ok = False
    # The Alfa Romeo blank-board and legend lines must produce no rows
    if any(g.startswith("Alfa Romeo") for g in got):
        print("FAIL: Alfa Romeo section header leaked rows")
        ok = False
    print(f"\n{len(got)} rows.  SELFTEST", "PASS" if ok else "FAIL")
    return 0 if ok else 1


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def parse_pages_arg(s):
    if not s:
        return None
    if "-" in s:
        a, b = s.split("-", 1)
        return int(a), int(b)
    n = int(s)
    return n, n


def main(argv=None):
    ap = argparse.ArgumentParser(description="Extract Ilco reference data to the paste format.")
    ap.add_argument("pdf", nargs="?", help="path to the Ilco reference PDF")
    ap.add_argument("--pages", help="page range, e.g. 13-14 or 13")
    ap.add_argument("--out", default="ilco_output.txt", help="output file")
    ap.add_argument("--preview", type=int, metavar="N",
                    help="print first N rows and stats, don't write a file")
    ap.add_argument("--split-by-make", action="store_true", help="write one file per make")
    ap.add_argument("--selftest", action="store_true",
                    help="validate the engine on the captured Acura pages")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()
    if not args.pdf:
        ap.error("a PDF path is required (or use --selftest)")

    try:
        rows = parse_pdf(args.pdf, parse_pages_arg(args.pages))
    except ImportError:
        print("pdfplumber is not installed. Run: pip install pdfplumber", file=sys.stderr)
        return 2

    makes = sorted({r["make"] for r in rows if r["make"]})
    with_blank = sum(1 for r in rows if r["blank"])

    if args.preview:
        for r in rows[:args.preview]:
            print(format_row(r))
        print(f"\n--- extractor v{EXTRACTOR_VERSION}: {len(rows)} rows, "
              f"{len(makes)} makes, {with_blank} with a key blank ---")
        return 0

    if args.split_by_make:
        os.makedirs("ilco_by_make", exist_ok=True)
        for mk in makes:
            safe = re.sub(r"[^A-Za-z0-9]+", "_", mk)
            with open(f"ilco_by_make/{safe}.txt", "w") as fh:
                fh.write("\n".join(format_row(r) for r in rows if r["make"] == mk) + "\n")
        print(f"Wrote {len(makes)} files under ilco_by_make/ ({len(rows)} rows)")
        return 0

    with open(args.out, "w") as fh:
        fh.write("\n".join(format_row(r) for r in rows) + "\n")
    print(f"Wrote {len(rows)} rows ({len(makes)} makes, {with_blank} with a key blank) to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
