# Ilco reference extractor

`ilco_extract.py` reads the Ilco key reference guide PDF and writes the data in
the format Lock & Scroll's **Paste Ilco Reference** importer accepts:

```
Make | Model | Years | Application | Code Series | Key Blank
```

You run it on **your own computer** against the full PDF, then paste the output
into the app. The PDF never has to be uploaded anywhere.

## One-time setup

1. **Install Python 3** (if you don't have it): https://www.python.org/downloads/
   — on Windows, tick "Add Python to PATH" during install.
2. Open a terminal (macOS: Terminal app; Windows: "Command Prompt") and install
   the one dependency:
   ```
   pip install pdfplumber
   ```

## Use it

Put the PDF and `ilco_extract.py` in the same folder, then:

```
# 1. Sanity-check the parser (no PDF needed):
python ilco_extract.py --selftest

# 2. Preview a few pages first so we can check accuracy before a full run:
python ilco_extract.py "Ilco Guide.pdf" --pages 10-14 --preview 40

# 3. Extract the whole guide to one file:
python ilco_extract.py "Ilco Guide.pdf" --out ilco_output.txt

# 4. …or split into one file per make (easier to paste in chunks):
python ilco_extract.py "Ilco Guide.pdf" --split-by-make
```

Then open `ilco_output.txt`, copy it, and paste into the app under
**📗 Ilco Guide → 📋 Paste Reference** (use **Preview** there before
**Import**). Rows with a key blank become searchable key records — type the
blank in the app to pull them up.

## Tuning (expected)

This guide packs many part numbers and transponder notes into each row, so the
**Key Blank** column especially needs a round of tuning against the real PDF's
layout. Run step 2 above, paste the `--preview` output back to Claude, and the
heuristics (which tokens count as blanks, where a row ends) get adjusted for
your specific guide. The clean fields — make, model, years, application, code
series — are already validated by `--selftest`.

---

# Ilco Lookup — desktop app (`ilco_desktop.py`)

A standalone **offline GUI** for your PC that wraps the extractor with a
search-and-verify workflow, and can be packaged as a single **Windows `.exe`**.
Use it to eyeball each extracted row against the source PDF before it ever
reaches the app — it is the verification gate for what you import.

> **Computer only.** A `.exe` runs on Windows (and the script runs on Mac/Linux
> too). Phones cannot run a `.exe` — on your phone use the Lock & Scroll PWA.

### What it does
- **Link both PDFs** — the modern guide and the antique book — from anywhere on
  the computer. Paths are remembered; extracted rows are cached, so re-opening
  is instant (it re-extracts only when a PDF changes).
- **Search** by vehicle, make, model, key blank (e.g. `TR33`), or code series —
  the same unified, multi-word search the app uses.
- **Verify** — **Open PDF** to check a row against the source, **Edit…** to fix
  any field, then **Approve** the rows you trust (double-click a row).
- **Export** approved rows to a `.txt` file (or **Copy approved**), then paste
  into **📗 Ilco Guide → 📋 Paste Reference** in the app.

### Run it from Python (no build needed)
```
pip install pdfplumber
python ilco_desktop.py            # opens the GUI
python ilco_desktop.py --selftest # validates search logic, no PDF/display
python ilco_desktop.py --search "TR33" --guide "Ilco Guide.pdf"   # headless
```
`ilco_desktop.py` and `ilco_extract.py` must sit in the same folder.

### Build the Windows `.exe`
On the **Windows** machine (so the `.exe` is a Windows binary), in a terminal in
this `tools` folder:
```
pip install pdfplumber pyinstaller
pyinstaller --onefile --windowed --name IlcoLookup ^
    --collect-all pdfplumber --collect-all pdfminer ^
    --add-data "ilco_extract.py;." ilco_desktop.py
```
The finished program is `dist\IlcoLookup.exe` — double-click to run; no Python
install needed on the machine you copy it to. (On macOS/Linux use `:` instead
of `;` in `--add-data`, and drop the `^` line-continuations / put it on one
line.) The first launch after linking a PDF spends a minute extracting, then
caches; later launches are instant.
