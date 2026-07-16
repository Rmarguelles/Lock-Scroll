#!/usr/bin/env python3
"""
ilco_extract.py — pull vehicle key data out of the Ilco key reference guide PDF
and write it in the pipe-delimited format that Lock & Scroll's
"Paste Ilco Reference" importer understands:

    Make | Model | Years | Application | Code Series | Key Blank | Substitutes

You run this on YOUR computer against the full PDF (no size/network limits),
then paste the output into the app (Vehicle Lookup -> Antique Reference ->
"Paste Ilco Reference").

Quick start
-----------
    pip install pdfplumber
    python ilco_extract.py GUIDE.pdf --out ilco_output.txt          # whole guide
    python ilco_extract.py GUIDE.pdf --pages 10-14 --preview 40     # sample first
    python ilco_extract.py GUIDE.pdf --split-by-make                # one file per make
    python ilco_extract.py --selftest                              # no PDF needed

How it works (two layers)
-------------------------
1. EXTRACT (needs the PDF): pdfplumber gives every word with x/y coordinates.
   We cluster words into physical rows by their vertical position, so each
   printed table row becomes one clean line string. (A naive text copy loses
   these row boundaries — that's why columns run together when you paste.)
2. PARSE (testable without the PDF): each physical line is classified as a
   make/section header, a data row, a Valet/application sub-row, or ignorable
   continuation text, then the fields are pulled out with the same rules the
   app's JS parser uses. `--selftest` exercises this layer on real sample rows.

The MODEL of a year-only row is inherited from the row above it; a Valet row
inherits the year range of the row above it; make/section headers (ALL CAPS,
no year on the line) set the current make and are consolidated
(TOYOTA TRUCKS, VANS, SUVS -> Toyota).

The KEY BLANK column of this transponder guide is the messy part (each row
lists cutting blanks, service keys, OEM PNs and transponder verbiage). The
heuristic below is a first cut meant to be tuned against real --preview output.
"""

import argparse
import re
import sys

# --------------------------------------------------------------------------
# Normalization (kept in sync with the JS side in index.html)
# --------------------------------------------------------------------------

MAKE_ALIASES = {
    "ford truck": "Ford", "ford trucks": "Ford",
    "chevy": "Chevrolet", "chev": "Chevrolet",
    "chevrolet truck": "Chevrolet", "chevrolet trucks": "Chevrolet",
    "gmc truck": "GMC", "gmc trucks": "GMC",
    "dodge truck": "Dodge", "dodge trucks": "Dodge",
    "chrysler truck": "Chrysler",
    "toyota truck": "Toyota", "toyota trucks": "Toyota",
    "nissan truck": "Nissan",
    "vw": "Volkswagen",
    "mercedes": "Mercedes Benz", "mercedes-benz": "Mercedes Benz",
    "datsun": "Nissan", "datsun (nissan)": "Nissan",
    "international harvester": "International",
    "rolls-royce": "Rolls Royce",
}

# Section suffixes stripped so "TOYOTA TRUCKS, VANS, SUVS" -> "Toyota".
SECTION_SUFFIX_RE = re.compile(
    r"[\s,]+(trucks?|vans?|suvs?|minivans?|cars?|passenger|imports?)\b.*$",
    re.IGNORECASE,
)

APPLICATION_CANON = {
    "ignition": "Ignition",
    "door": "Door", "doors": "Door",
    "trunk": "Trunk",
    "glovebox": "GB", "glove box": "GB", "gb": "GB",
    "door/trunk": "Door/Trunk", "trunk/door": "Door/Trunk",
    "ignition/door": "Ignition/Door", "door/ignition": "Ignition/Door",
    "trunk/gb": "Trunk/GB", "gb/trunk": "Trunk/GB",
    "door/gb": "Door/GB",
    "all": "All", "valet": "Valet",
}
APPLICATION_TOKENS = {"all", "valet", "ignition", "door", "doors", "trunk", "gb"}

# A single 4-digit year in the plausible automotive range.
YEAR_RE = re.compile(r"\b(19|20)\d{2}\b")
# "MID2010" style start.
MID_YEAR_RE = re.compile(r"\bMID\s*((?:19|20)\d{2})\b", re.IGNORECASE)

# Code-series shapes seen in the guide: 10001-15000, 50000-69999, X1-X2248,
# R5001-R6924, K1-K4570, S1-S2878, W1-W2409.
CODE_SERIES_RE = re.compile(r"\b([A-Z]?\d{1,6}-[A-Z]?\d{1,6})\b")

# A blank/part token: has letters AND digits, Ilco/Silca style, may join names
# with "/" or "-" (X217/TR47, TOY43-GTK, TOY44D-PT, EK3-TOY43). OEM PNs like
# 89904-0T050 also match (digit-led with a letter later).
BLANK_TOKEN_RE = re.compile(r"^(?=[A-Z0-9/\-]*[A-Z])(?=[A-Z0-9/\-]*\d)[A-Z0-9]+(?:[/\-][A-Z0-9]+)*[*#]?$")

# Words/markers that end the key-blank region (transponder / tooling verbiage).
BLANK_STOPWORDS = {
    "service", "smart", "pro", "tcp", "mvpp", "tko", "sdd", "obp", "program",
    "emerg", "emerg.", "emergency", "oem", "oem#", "optional", "texas",
    "instruments", "encrypted", "system", "bit", "transponder", "w/",
    "rw5", "rw4", "sa+", "ez", "clone", "plus", "box",
}
# Cloning-tool / non-blank tokens that still contain a digit (must not be
# captured as blanks).
BLANK_BLACKLIST = {"rw5", "rw4", "rw3"}


# Makes that stay upper-cased instead of being Title-cased.
ACRONYM_MAKES = {"BMW", "GMC", "VW", "MG", "AMC", "AM"}


def _title_make(s):
    out = []
    for w in s.split():
        if w.upper() in ACRONYM_MAKES:
            out.append(w.upper())
        elif w.isupper():
            out.append(w.capitalize())
        else:
            out.append(w)
    return " ".join(out)


def normalize_make(raw):
    m = " ".join(str(raw or "").split())
    if not m:
        return ""
    low = m.lower()
    if low in MAKE_ALIASES:
        return MAKE_ALIASES[low]
    stripped = SECTION_SUFFIX_RE.sub("", m).strip(" ,")
    if stripped and stripped.lower() in MAKE_ALIASES:
        return MAKE_ALIASES[stripped.lower()]
    return _title_make(stripped or m)


def normalize_application(app):
    a = str(app or "").strip()
    if not a:
        return ""
    key = re.sub(r"\s+", " ", re.sub(r"\s*/\s*", "/", a.lower()))
    return APPLICATION_CANON.get(key, a)


def looks_like_year(s):
    return bool(YEAR_RE.search(s) or MID_YEAR_RE.search(s))


def parse_years(text):
    """Return (start, end, label) or None from a chunk of text."""
    mid = MID_YEAR_RE.search(text)
    years = [int(y) for y in re.findall(r"(?:19|20)\d{2}", text)]
    if mid and years:
        start = int(mid.group(1))
        end = max(years)
        return start, end, f"{start}-{end}"
    if len(years) >= 2:
        start, end = years[0], years[1]
        if end < start:
            start, end = end, start
        return start, end, f"{start}-{end}"
    if len(years) == 1:
        return years[0], years[0], f"{years[0]}"
    return None


def extract_code_series(text):
    m = CODE_SERIES_RE.search(text)
    return m.group(1) if m else ""


def extract_blanks(tokens):
    """
    Given the tokens AFTER the code series, return (blank, substitutes).
    Heuristic (tunable): collect Ilco/Silca-style part tokens up to the first
    stopword; drop bracketed variant groups ([-P, -PC]), parenthetical notes
    ((LAL), (4C)) and lone trailing numbers. First token = blank, rest = subs.
    """
    found = []
    depth = 0
    for tok in tokens:
        low = tok.lower().strip(",")
        # Track and skip bracket/paren groups like "[-P," ... "-PC]" or "(LAL)"
        depth += tok.count("(") + tok.count("[")
        closed = tok.count(")") + tok.count("]")
        if depth > 0 or "(" in tok or "[" in tok:
            depth = max(0, depth - closed)
            continue
        depth = max(0, depth - closed)
        if low in BLANK_STOPWORDS:
            break
        if low in BLANK_BLACKLIST:
            continue
        clean = tok.strip(",")
        if BLANK_TOKEN_RE.match(clean):
            found.append(clean)
    if not found:
        return "", ""
    return found[0], ", ".join(found[1:])


# --------------------------------------------------------------------------
# PARSE layer — physical line strings -> rows (unit-testable)
# --------------------------------------------------------------------------

def _split_tokens(line):
    return line.split()


def _is_header(line):
    """A make/section header: mostly caps letters, no year on the line."""
    if looks_like_year(line):
        return False
    letters = [c for c in line if c.isalpha()]
    if not letters:
        return False
    upper_ratio = sum(1 for c in letters if c.isupper()) / len(letters)
    # Headers are all/mostly caps and short-ish (a make name, maybe with a
    # ", VANS, SUVS" tail); avoid catching a stray note line.
    return upper_ratio > 0.85


def parse_lines(lines, known_makes=None):
    """
    Turn an ordered list of physical line strings into row dicts:
      {make, model, years, startYear, endYear, application, codeSeries,
       blank, substitutes}
    Emits one row per (year range x application) line. `known_makes` (optional)
    lets a header be recognized as a make even without a section suffix.
    """
    known = {m.lower() for m in (known_makes or [])}
    rows = []
    cur_make = ""
    cur_model = ""
    last_years = None  # (start, end, label) for Valet inheritance

    for raw in lines:
        line = " ".join(str(raw).replace('"', "").split())
        if not line:
            continue

        # Header?  ALL-CAPS, no year.  But a bare model header (no year, e.g. a
        # model whose data wrapped) is rare; treat caps-no-year as make/section.
        if _is_header(line):
            base = SECTION_SUFFIX_RE.sub("", line).strip(" ,")
            # Only treat as MAKE header when it looks like a manufacturer, not a
            # model: known make, or contains a section suffix word.
            if base.lower() in known or SECTION_SUFFIX_RE.search(line) or " " not in base:
                cur_make = normalize_make(line)
                cur_model = ""
                last_years = None
                continue
            # Otherwise assume it's a model header line
            cur_model = _title_model(line)
            continue

        tokens = _split_tokens(line)

        # Find the first token index that starts the year field.
        yi = None
        for i, t in enumerate(tokens):
            if looks_like_year(t):
                yi = i
                break

        app_only = tokens and tokens[0].lower().strip(",") in APPLICATION_TOKENS

        if yi is None and not app_only:
            # Continuation line (extra key blank / transponder text) — skip.
            continue

        if app_only and yi is None:
            # Valet/application sub-row: inherit model + previous year range.
            if not last_years:
                continue
            application = normalize_application(tokens[0])
            rest = tokens[1:]
            code = extract_code_series(" ".join(rest))
            after = _tokens_after_code(rest, code)
            blank, subs = extract_blanks(after)
            start, end, label = last_years
            rows.append(_row(cur_make, cur_model, label, start, end,
                             application, code, blank, subs))
            continue

        # Data row.  Name tokens are everything before the year field.
        name_tokens = tokens[:yi]
        # Years: consume the year tokens (handle "MID2010 2015" and "YYYY YYYY").
        year_text, consumed = _consume_years(tokens, yi)
        yr = parse_years(year_text)
        if not yr:
            continue
        start, end, label = yr
        rest = tokens[yi + consumed:]

        # Application is the first app token in the rest (default blank).
        application = ""
        ri = 0
        while ri < len(rest):
            if rest[ri].lower().strip(",") in APPLICATION_TOKENS:
                application = normalize_application(rest[ri])
                ri += 1
                break
            ri += 1
        after_app = rest[ri:] if application else rest

        code = extract_code_series(" ".join(after_app))
        after_code = _tokens_after_code(after_app, code)
        blank, subs = extract_blanks(after_code)

        if name_tokens:
            cur_model = _title_model(" ".join(name_tokens))
        model = cur_model or "All Models"
        last_years = (start, end, label)
        rows.append(_row(cur_make, model, label, start, end,
                         application, code, blank, subs))

    return rows


def _consume_years(tokens, yi):
    """From index yi, gather the year tokens; return (text, count consumed)."""
    text = tokens[yi]
    count = 1
    # A second consecutive year token (the end year) if present.
    if yi + 1 < len(tokens) and re.fullmatch(r"(?:19|20)\d{2}", tokens[yi + 1].strip(",")):
        text += " " + tokens[yi + 1]
        count = 2
    return text, count


def _tokens_after_code(tokens, code):
    if not code:
        return tokens
    joined = " ".join(tokens)
    idx = joined.find(code)
    if idx < 0:
        return tokens
    tail = joined[idx + len(code):].split()
    return tail


def _title_model(s):
    s = " ".join(str(s).split()).strip(" ,.")
    # Keep as-is if it has lowercase already; otherwise Title-Case the caps.
    if any(c.islower() for c in s):
        return s
    return " ".join(w.capitalize() if w.isalpha() else w for w in s.split())


def _row(make, model, label, start, end, application, code, blank, subs):
    return {
        "make": normalize_make(make) if make else "",
        "model": model,
        "years": label,
        "startYear": start,
        "endYear": end,
        "application": application,
        "codeSeries": code,
        "blank": blank,
        "substitutes": subs,
    }


def format_row(r):
    return " | ".join([
        r["make"], r["model"], r["years"], r["application"],
        r["codeSeries"], r["blank"], r["substitutes"],
    ]).rstrip(" |")


# --------------------------------------------------------------------------
# EXTRACT layer — PDF -> physical line strings (needs pdfplumber + the PDF)
# --------------------------------------------------------------------------

def pdf_to_lines(pdf_path, pages=None, y_tol=3.0):
    import pdfplumber
    with pdfplumber.open(pdf_path) as pdf:
        page_iter = pdf.pages
        if pages:
            lo, hi = pages
            page_iter = pdf.pages[lo - 1:hi]
        for page in page_iter:
            words = page.extract_words(use_text_flow=False, keep_blank_chars=False)
            words.sort(key=lambda w: (round(w["top"] / y_tol), w["x0"]))
            line, cur_top = [], None
            for w in words:
                if cur_top is None or abs(w["top"] - cur_top) <= y_tol:
                    line.append(w)
                    cur_top = w["top"] if cur_top is None else cur_top
                else:
                    yield " ".join(x["text"] for x in sorted(line, key=lambda x: x["x0"]))
                    line, cur_top = [w], w["top"]
            if line:
                yield " ".join(x["text"] for x in sorted(line, key=lambda x: x["x0"]))


# --------------------------------------------------------------------------
# Self-test — validates the PARSE layer on real sample rows (no PDF needed)
# --------------------------------------------------------------------------

SAMPLE_LINES = [
    "TOYOTA TRUCKS, VANS, SUVS",
    "4 RUNNER 1999 2002 All 10001-15000 TOY43AT4 (LAL) OBP Program E, Smart Pro/TCP/MVPP/TKO/ SDD Service Key TR47 Texas Instruments (4C) Encrypted System 514",
    "1996 1998 All 10001-15000 X217/TR47 [-P, -PC] X225/B80 514",
    "Valet 10001-15000 X220/TR50-514",
    "1990 1995 All W1-W2409 X211/TR44 [-P] X174/TR40 264",
    "1984 1989 All K1-K4570 X137/TR33 [-P, -PC]-89",
    "4 RUNNER LTD. 1999 2002 All 10001-15000 EK3-TOY43/EK3LB-TOY43*/ TOY43-GTK# RW5, SA+ Service Key TR47",
]


def selftest():
    rows = parse_lines(SAMPLE_LINES, known_makes=["Toyota"])
    got = [format_row(r) for r in rows]
    for line in got:
        print("  ", line)

    # Exact checks for the clean fields (make/model/years/application/code +
    # primary blank). Substitute over-capture is fine — "capture all part-like
    # numbers" is the goal — so these assert a startswith prefix.
    prefix_checks = [
        ("row0 make/case + blank", got[0], "Toyota | 4 Runner | 1999-2002 | All | 10001-15000 | TOY43AT4"),
        ("row1 primary+substitute", got[1], "Toyota | 4 Runner | 1996-1998 | All | 10001-15000 | X217/TR47 | X225/B80"),
        ("row2 valet inherits 1996-1998", got[2], "Toyota | 4 Runner | 1996-1998 | Valet | 10001-15000"),
        ("row3 blank captured", got[3], "Toyota | 4 Runner | 1990-1995 | All | W1-W2409 | X211/TR44"),
        ("row4 blank captured", got[4], "Toyota | 4 Runner | 1984-1989 | All | K1-K4570 | X137/TR33"),
        ("row5 ltd model", got[5], "Toyota | 4 Runner Ltd | 1999-2002 | All | 10001-15000"),
    ]
    ok = True
    for label, actual, expect in prefix_checks:
        if not actual.startswith(expect):
            print(f"FAIL {label}:\n  expected prefix:", expect, "\n  got:           ", actual)
            ok = False
    print("\nSELFTEST", "PASS" if ok else "FAIL")
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
    ap.add_argument("--pages", help="page range, e.g. 10-14 or 12")
    ap.add_argument("--out", default="ilco_output.txt", help="output file")
    ap.add_argument("--preview", type=int, metavar="N", help="print first N rows and stats, don't write")
    ap.add_argument("--split-by-make", action="store_true", help="write one file per make")
    ap.add_argument("--selftest", action="store_true", help="validate the parser on built-in samples")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()
    if not args.pdf:
        ap.error("a PDF path is required (or use --selftest)")

    try:
        lines = list(pdf_to_lines(args.pdf, parse_pages_arg(args.pages)))
    except ImportError:
        print("pdfplumber is not installed. Run: pip install pdfplumber", file=sys.stderr)
        return 2

    rows = parse_lines(lines)
    makes = sorted({r["make"] for r in rows if r["make"]})

    if args.preview:
        for r in rows[:args.preview]:
            print(format_row(r))
        print(f"\n--- {len(rows)} rows, {len(makes)} makes, "
              f"{sum(1 for r in rows if r['blank'])} with a key blank ---")
        return 0

    if args.split_by_make:
        import os
        os.makedirs("ilco_by_make", exist_ok=True)
        for mk in makes:
            safe = re.sub(r"[^A-Za-z0-9]+", "_", mk)
            with open(f"ilco_by_make/{safe}.txt", "w") as fh:
                fh.write("\n".join(format_row(r) for r in rows if r["make"] == mk) + "\n")
        print(f"Wrote {len(makes)} files under ilco_by_make/ ({len(rows)} rows)")
        return 0

    with open(args.out, "w") as fh:
        fh.write("\n".join(format_row(r) for r in rows) + "\n")
    print(f"Wrote {len(rows)} rows ({len(makes)} makes, "
          f"{sum(1 for r in rows if r['blank'])} with a key blank) to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
