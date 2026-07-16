# Ilco reference extractor

`ilco_extract.py` reads the Ilco key reference guide PDF and writes the data in
the format Lock & Scroll's **Paste Ilco Reference** importer accepts:

```
Make | Model | Years | Application | Code Series | Key Blank | Substitutes
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
**Vehicle Lookup → 📖 Antique Reference → 📋 Paste Ilco Reference** (use
**Preview** there before **Import**). Rows with a key blank become searchable
key records — type the blank in the app to pull them up.

## Tuning (expected)

This guide packs many part numbers and transponder notes into each row, so the
**Key Blank** column especially needs a round of tuning against the real PDF's
layout. Run step 2 above, paste the `--preview` output back to Claude, and the
heuristics (which tokens count as blanks, where a row ends) get adjusted for
your specific guide. The clean fields — make, model, years, application, code
series — are already validated by `--selftest`.
