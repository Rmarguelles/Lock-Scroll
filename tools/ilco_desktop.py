#!/usr/bin/env python3
"""
Ilco Lookup — offline desktop app to search & verify Ilco key data.

A standalone GUI for a locksmith's PC. It extracts vehicle/key data from the
Ilco source PDFs (modern transponder guide + antique book) fully offline,
lets you search by vehicle, make, model, key blank, or code series, and lets
you eyeball each row against the source PDF before approving it. Approved
rows export as the pipe-delimited format the Lock & Scroll app ingests via
"Paste Reference" — so the desktop tool is the verification gate for what
goes into the app.

Runs on the computer only (a .exe on Windows; `python ilco_desktop.py`
anywhere). Phones can't run a .exe — use the Lock & Scroll PWA there.

  GUI:        python ilco_desktop.py
  Headless:   python ilco_desktop.py --search "TR33" --guide GUIDE.pdf
  Self-test:  python ilco_desktop.py --selftest      (no PDF, no display)

Build a Windows .exe (run on the Windows machine, see README-ilco.md):
  pip install pdfplumber pyinstaller
  pyinstaller --onefile --windowed --name IlcoLookup ^
      --collect-all pdfplumber --collect-all pdfminer ilco_desktop.py
"""

import argparse
import json
import os
import re
import sys
import hashlib

# Make the sibling extractor importable both as a script and when frozen by
# PyInstaller (which unpacks bundled modules next to this file / in _MEIPASS).
_HERE = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import ilco_extract  # noqa: E402

APP_NAME = "Ilco Lookup"
CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".ilco_lookup")
FIELDS = ("make", "model", "years", "application", "codeSeries", "blank", "keyType")


# --------------------------------------------------------------------------
# Pure logic — no tkinter, no display required (unit-tested by --selftest)
# --------------------------------------------------------------------------

def blank_parts(row):
    """Individual key-blank part numbers of a row, lowercased."""
    return [p.strip().lower() for p in str(row.get("blank", "")).split("/") if p.strip()]


def haystack(row):
    return " ".join(str(row.get(f, "")) for f in FIELDS).lower()


def search_rows(rows, query):
    """Unified search mirroring the app: every whitespace token must appear
    across the row's fields (vehicle = make+model+years, code series, blank,
    application, prox). A token exactly matching a key-blank part ranks its
    rows first, so 'TR33' surfaces X137/TR33 above incidental text matches."""
    q = " ".join(str(query or "").split()).lower()
    if not q:
        return list(rows)
    tokens = q.split()

    def name_hit(r):
        bp = blank_parts(r)
        return q in bp or any(t in bp for t in tokens)

    def text_hit(r):
        h = haystack(r)
        return all(t in h for t in tokens)

    exact = [r for r in rows if name_hit(r)]
    rest = [r for r in rows if not name_hit(r) and text_hit(r)]
    return exact + rest


def rows_to_pipe(rows):
    """Serialize rows to the pipe-delimited text the app's importer reads."""
    return "\n".join(ilco_extract.format_row(r) for r in rows)


def _cache_path(pdf_path):
    h = hashlib.sha1(os.path.abspath(pdf_path).encode("utf-8")).hexdigest()[:16]
    return os.path.join(CONFIG_DIR, f"rows_{h}.json")


def load_or_extract(pdf_path, source_label, progress=None, force=False):
    """Return extracted rows for a PDF, tagged with their source book. Caches
    to JSON keyed by path+mtime so re-opening the app is instant; re-extracts
    when the PDF changes or force=True. `progress` is an optional callable."""
    os.makedirs(CONFIG_DIR, exist_ok=True)
    cache = _cache_path(pdf_path)
    mtime = os.path.getmtime(pdf_path)
    if not force and os.path.exists(cache):
        try:
            with open(cache, encoding="utf-8") as fh:
                blob = json.load(fh)
            if blob.get("mtime") == mtime and blob.get("path") == os.path.abspath(pdf_path):
                return blob["rows"]
        except Exception:
            pass
    if progress:
        progress(f"Extracting {source_label} — this can take a minute…")
    rows = ilco_extract.parse_pdf(pdf_path)
    for r in rows:
        r.setdefault("keyType", "")
        r["source"] = source_label
    try:
        with open(cache, "w", encoding="utf-8") as fh:
            json.dump({"path": os.path.abspath(pdf_path), "mtime": mtime, "rows": rows}, fh)
    except Exception:
        pass
    return rows


def _load_config():
    try:
        with open(os.path.join(CONFIG_DIR, "config.json"), encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def _save_config(cfg):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    try:
        with open(os.path.join(CONFIG_DIR, "config.json"), "w", encoding="utf-8") as fh:
            json.dump(cfg, fh)
    except Exception:
        pass


# --------------------------------------------------------------------------
# Self-test — validates the search/serialize logic with no PDF and no display
# --------------------------------------------------------------------------

def selftest():
    rows = [
        {"make": "Toyota", "model": "Camry", "years": "2007-2011", "application": "All",
         "codeSeries": "10001-15000", "blank": "EK3-TOY43/TOY43", "keyType": ""},
        {"make": "Ford", "model": "Crown Victoria", "years": "1993-1996",
         "application": "Ignition/Door", "codeSeries": "A-B-C-D-E", "blank": "1193FD/H67", "keyType": ""},
        {"make": "Toyota", "model": "Corolla Station Wagon 2WD", "years": "1981-1987",
         "application": "All", "codeSeries": "G1-G2377", "blank": "X174/TR40", "keyType": ""},
        {"make": "Honda", "model": "Accord", "years": "2018-2022", "application": "All",
         "codeSeries": "K001-N718", "blank": "72147-TVA-A01", "keyType": "Prox"},
    ]
    ok = True

    def check(name, cond):
        nonlocal ok
        print(("  ok  " if cond else "  FAIL") + "  " + name)
        ok = ok and cond

    check("by key blank exact -> Crown Vic first",
          search_rows(rows, "h67") and search_rows(rows, "h67")[0]["model"] == "Crown Victoria")
    check("by make -> only Honda", [r["model"] for r in search_rows(rows, "honda")] == ["Accord"])
    check("by model phrase", any(r["model"] == "Corolla Station Wagon 2WD"
                                  for r in search_rows(rows, "corolla station wagon")))
    check("by vehicle (make+model AND)",
          [r["model"] for r in search_rows(rows, "toyota camry")] == ["Camry"])
    check("by code series", [r["model"] for r in search_rows(rows, "k001-n718")] == ["Accord"])
    check("negative (toyota accord)", search_rows(rows, "toyota accord") == [])
    check("prox token", [r["model"] for r in search_rows(rows, "prox")] == ["Accord"])
    check("pipe export round-trips through the app's parser format",
          rows_to_pipe(rows[:1]) == "Toyota | Camry | 2007-2011 | All | 10001-15000 | EK3-TOY43/TOY43")
    print("\nSELFTEST", "PASS" if ok else "FAIL")
    return 0 if ok else 1


# --------------------------------------------------------------------------
# GUI (tkinter is stdlib; imported lazily so headless modes need no display)
# --------------------------------------------------------------------------

def run_gui():
    import tkinter as tk
    from tkinter import ttk, filedialog, messagebox
    import threading
    import subprocess

    class App:
        def __init__(self, root):
            self.root = root
            root.title(APP_NAME)
            root.geometry("1040x640")
            self.cfg = _load_config()
            self.rows = []            # all extracted rows (both books)
            self.view = []            # currently displayed (filtered) rows
            self.approved = set()     # ids(row dict) that are approved
            self.pdf = {"guide": self.cfg.get("guide", ""), "antique": self.cfg.get("antique", "")}

            # --- PDF link bar ---
            top = ttk.Frame(root, padding=8)
            top.pack(fill="x")
            self.lbl = {}
            for i, (key, title) in enumerate((("guide", "Modern Guide"), ("antique", "Antique Book"))):
                ttk.Label(top, text=title + ":", width=14).grid(row=i, column=0, sticky="w", pady=2)
                self.lbl[key] = ttk.Label(top, text=self._short(self.pdf[key]) or "not linked",
                                          foreground="#888", width=52)
                self.lbl[key].grid(row=i, column=1, sticky="w")
                ttk.Button(top, text="Link…", command=lambda k=key: self.link(k)).grid(row=i, column=2, padx=2)
                ttk.Button(top, text="Extract", command=lambda k=key: self.extract(k)).grid(row=i, column=3, padx=2)
                ttk.Button(top, text="Open PDF", command=lambda k=key: self.open_pdf(k)).grid(row=i, column=4, padx=2)

            # --- search bar ---
            sb = ttk.Frame(root, padding=(8, 0))
            sb.pack(fill="x")
            ttk.Label(sb, text="Search:").pack(side="left")
            self.q = tk.StringVar()
            self.q.trace_add("write", lambda *a: self.refresh())
            ent = ttk.Entry(sb, textvariable=self.q)
            ent.pack(side="left", fill="x", expand=True, padx=6)
            ent.focus()
            self.count = ttk.Label(sb, text="", foreground="#2a7")
            self.count.pack(side="left", padx=6)

            # --- results table ---
            cols = ("ok", "make", "model", "years", "application", "codeSeries", "blank", "keyType", "source")
            heads = ("✓", "Make", "Model", "Years", "Application", "Code Series", "Key Blank", "Prox", "Source")
            widths = (26, 90, 190, 90, 110, 110, 150, 46, 70)
            wrap = ttk.Frame(root, padding=8)
            wrap.pack(fill="both", expand=True)
            self.tree = ttk.Treeview(wrap, columns=cols, show="headings", selectmode="extended")
            self.headmap = dict(zip(cols, heads))
            self.sort_col = None
            self.sort_desc = False
            for c, h, w in zip(cols, heads, widths):
                self.tree.heading(c, text=h, command=lambda col=c: self.sort_by(col))
                self.tree.column(c, width=w, anchor="center" if c in ("ok", "keyType") else "w")
            vs = ttk.Scrollbar(wrap, orient="vertical", command=self.tree.yview)
            self.tree.configure(yscrollcommand=vs.set)
            self.tree.pack(side="left", fill="both", expand=True)
            vs.pack(side="right", fill="y")
            self.tree.bind("<Double-1>", lambda e: self.toggle_approve())

            # --- action bar ---
            bar = ttk.Frame(root, padding=8)
            bar.pack(fill="x")
            ttk.Button(bar, text="Approve / Unapprove  (dbl-click)", command=self.toggle_approve).pack(side="left")
            ttk.Button(bar, text="Edit…", command=self.edit_row).pack(side="left", padx=4)
            ttk.Button(bar, text="Approve all shown", command=self.approve_shown).pack(side="left", padx=4)
            ttk.Button(bar, text="Copy approved", command=self.copy_approved).pack(side="left", padx=4)
            ttk.Button(bar, text="Export approved → .txt", command=self.export_approved).pack(side="left", padx=4)
            self.status = ttk.Label(bar, text="", foreground="#888")
            self.status.pack(side="right")

            self.autoload()

        # ---- helpers ----
        def _short(self, path):
            return ("…" + path[-48:]) if path and len(path) > 49 else path

        def set_status(self, msg):
            self.status.config(text=msg)
            self.root.update_idletasks()

        def autoload(self):
            for key in ("guide", "antique"):
                if self.pdf[key] and os.path.exists(self.pdf[key]):
                    self.extract(key, silent=True)

        def link(self, key):
            path = filedialog.askopenfilename(title=f"Select the {key} PDF",
                                              filetypes=[("PDF", "*.pdf"), ("All", "*.*")])
            if not path:
                return
            self.pdf[key] = path
            self.cfg[key] = path
            _save_config(self.cfg)
            self.lbl[key].config(text=self._short(path))
            self.extract(key)

        def extract(self, key, silent=False, force=False):
            path = self.pdf.get(key)
            if not path or not os.path.exists(path):
                if not silent:
                    messagebox.showwarning(APP_NAME, f"Link the {key} PDF first.")
                return
            self.set_status(f"Extracting {key}…")

            def work():
                try:
                    new = load_or_extract(path, key, progress=self.set_status, force=force)
                except Exception as e:
                    self.root.after(0, lambda: messagebox.showerror(APP_NAME, f"Extraction failed:\n{e}"))
                    self.root.after(0, lambda: self.set_status(""))
                    return
                self.root.after(0, lambda: self._merge(key, new))

            threading.Thread(target=work, daemon=True).start()

        def _merge(self, key, new):
            self.rows = [r for r in self.rows if r.get("source") != key] + new
            self.set_status(f"{len(self.rows)} rows loaded ({key}: {len(new)})")
            self.refresh()

        def _sort_key(self, col):
            if col == "ok":  # approved rows group together
                return lambda r: 0 if id(r) in self.approved else 1
            if col == "years":  # sort by the first 4-digit year, numerically
                def yk(r):
                    m = re.search(r"\d{4}", str(r.get("years", "")))
                    return int(m.group()) if m else 0
                return yk
            return lambda r: str(r.get(col, "")).lower()

        def sort_by(self, col):
            # Click a header to sort by it; click the same header again to
            # reverse. Sorting is stable, so ties keep their search order.
            if self.sort_col == col:
                self.sort_desc = not self.sort_desc
            else:
                self.sort_col = col
                self.sort_desc = False
            self.refresh()

        def refresh(self):
            self.view = search_rows(self.rows, self.q.get())
            if self.sort_col:
                self.view = sorted(self.view, key=self._sort_key(self.sort_col),
                                   reverse=self.sort_desc)
            for c, base in self.headmap.items():
                arrow = ("  ▼" if self.sort_desc else "  ▲") if c == self.sort_col else ""
                self.tree.heading(c, text=base + arrow)
            self.tree.delete(*self.tree.get_children())
            for i, r in enumerate(self.view):
                mark = "✓" if id(r) in self.approved else ""
                self.tree.insert("", "end", iid=str(i),
                                 values=(mark, r.get("make", ""), r.get("model", ""), r.get("years", ""),
                                         r.get("application", ""), r.get("codeSeries", ""), r.get("blank", ""),
                                         r.get("keyType", ""), r.get("source", "")))
            n = len(self.view)
            self.count.config(text=f"{n} result{'' if n == 1 else 's'} · {len(self.approved)} approved")

        def _selected_rows(self):
            return [self.view[int(i)] for i in self.tree.selection()]

        def toggle_approve(self):
            for r in self._selected_rows():
                if id(r) in self.approved:
                    self.approved.discard(id(r))
                else:
                    self.approved.add(id(r))
            self.refresh()

        def approve_shown(self):
            for r in self.view:
                self.approved.add(id(r))
            self.refresh()

        def edit_row(self):
            sel = self._selected_rows()
            if not sel:
                messagebox.showinfo(APP_NAME, "Select a row to edit.")
                return
            r = sel[0]
            win = tk.Toplevel(self.root)
            win.title("Edit row")
            win.transient(self.root)
            entries = {}
            for i, f in enumerate(FIELDS):
                ttk.Label(win, text=f).grid(row=i, column=0, sticky="e", padx=6, pady=3)
                var = tk.StringVar(value=str(r.get(f, "")))
                ttk.Entry(win, textvariable=var, width=44).grid(row=i, column=1, padx=6, pady=3)
                entries[f] = var

            def save():
                for f, var in entries.items():
                    r[f] = var.get().strip()
                win.destroy()
                self.refresh()
            ttk.Button(win, text="Save", command=save).grid(row=len(FIELDS), column=1, sticky="e", padx=6, pady=8)

        def _approved_rows(self):
            # preserve current view order, approved only
            return [r for r in self.view if id(r) in self.approved] or \
                   [r for r in self.rows if id(r) in self.approved]

        def copy_approved(self):
            rows = self._approved_rows()
            if not rows:
                messagebox.showinfo(APP_NAME, "No approved rows yet (double-click rows to approve).")
                return
            self.root.clipboard_clear()
            self.root.clipboard_append(rows_to_pipe(rows))
            self.set_status(f"Copied {len(rows)} approved row(s) — paste into the app's Paste Reference.")

        def export_approved(self):
            rows = self._approved_rows()
            if not rows:
                messagebox.showinfo(APP_NAME, "No approved rows yet (double-click rows to approve).")
                return
            path = filedialog.asksaveasfilename(title="Export approved rows", defaultextension=".txt",
                                                initialfile="ilco_verified.txt",
                                                filetypes=[("Text", "*.txt")])
            if not path:
                return
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(rows_to_pipe(rows) + "\n")
            self.set_status(f"Exported {len(rows)} row(s) to {path}")
            messagebox.showinfo(APP_NAME, f"Exported {len(rows)} approved row(s).\n\nPaste the file's contents into "
                                          "Lock & Scroll → 📗 Ilco Guide → 📋 Paste Reference.")

        def open_pdf(self, key):
            path = self.pdf.get(key)
            if not path or not os.path.exists(path):
                messagebox.showwarning(APP_NAME, f"Link the {key} PDF first.")
                return
            try:
                if sys.platform.startswith("win"):
                    os.startfile(path)  # noqa
                elif sys.platform == "darwin":
                    subprocess.Popen(["open", path])
                else:
                    subprocess.Popen(["xdg-open", path])
            except Exception as e:
                messagebox.showerror(APP_NAME, f"Could not open PDF:\n{e}")

    root = tk.Tk()
    root._ilco_app = App(root)  # stash for headless testing hooks
    root.mainloop()
    return 0


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description="Ilco Lookup — offline desktop search & verify tool.")
    ap.add_argument("--search", help="headless: print rows matching this query and exit")
    ap.add_argument("--guide", help="modern guide PDF (for --search)")
    ap.add_argument("--antique", help="antique book PDF (for --search)")
    ap.add_argument("--selftest", action="store_true", help="validate search logic, no PDF/display")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()

    if args.search is not None:
        rows = []
        for path, label in ((args.guide, "guide"), (args.antique, "antique")):
            if path:
                rows += load_or_extract(path, label)
        if not rows:
            ap.error("--search needs at least one of --guide/--antique")
        hits = search_rows(rows, args.search)
        for r in hits:
            print(ilco_extract.format_row(r))
        print(f"\n{len(hits)} row(s) match {args.search!r}")
        return 0

    return run_gui()


if __name__ == "__main__":
    raise SystemExit(main())
