# Key data extraction

Pulls every known key out of the current app, including built-in keys and your
own additions and edits, and writes them in one consistent format for the new
app.

## Why it runs the old app

The current app applies a long chain of overrides, PN renames, supersessions,
merges and one-time migrations every time it starts. Rather than re-implement
all of that (and risk losing edits), `dump.mjs` runs the real app headless,
loads your backup the way a freshly restored device would, and reads the
merged result straight out of it.

## Steps

1. In the app (v268 or newer): **Settings → Export** on the device with the
   most complete data. Sign in and sync first so it has the cloud's latest.
   v268 is the first version whose export includes PN renames, supersessions
   and custom keyways, so an older backup can miss renamed keys.
2. Run:

   ```sh
   node tools/extract/dump.mjs path/to/LockAndScroll_Backup_YYYY-MM-DD.json
   node tools/extract/normalize.mjs
   ```

   With no backup argument, `dump.mjs` extracts the built-in catalog only.
   Requires Node 18+ and Playwright (`npm i -g playwright`).
3. Read `data/REPORT.md`: totals, gaps, every cleanup decision, and a
   cross-check of the result against the backup's own key list.

Never commit the backup file itself. It holds job history and other personal
data. `data/raw/` and `*Backup*.json` are gitignored.

## Output (`data/`)

Each file starts with a `meta` block (`schemaVersion`, `extractedAt`,
`fromApp`, `backup`).

| File | Contents |
|---|---|
| `keys.json` | One record per part number |
| `vehicles.json` | One row per make / model / category / year range: what to look up when a call comes in |
| `lishi-tools.json` | Lishi tools (keyways, door/ignition/trunk, in stock) plus the keyway → tool map |
| `test-keys.json` | Test key pools by keyway, with pooled quantity |
| `fids.json` | FID groups: their FCC IDs and keys, plus the prefix table |
| `vendor-prices.json` | Distributor pricing per part number (SKU, Price A/B, named versions, emergency key, shell, OEM) and the distributor list |
| `REPORT.md` | Totals, gaps, cleanup decisions, backup cross-check |

### Key record

```jsonc
{
  "pn": "8701",
  "category": "Proximity",          // "Keyed Ignition" | "Proximity" (the app's normalizeKeyType)
  "keyType": "Proximity",           // original label: Chip Key, Remote Head Key, Remote Only, Fobik...
  "fid": "C-501", "otherFids": [],  // otherFids only when FCC IDs map to more than one FID
  "fccIds": ["M3NWXF0B1"],          // uppercase; mechanical keys use their blank as a stand-in
  "chip": "Hitag AES Type 4A",      // "None" = confirmed no chip, null = unknown
  "frequency": "434 MHz",
  "buttons": "3 Button: L, U, P (Lock, Unlock, Panic)", "buttonCount": 3,
  "battery": "CR2450", "batteryCount": 1,
  "keyway": "Y159",
  "lishi": [{ "tool": "CY24", "direction": "CW" }],
  "stock": 0,
  "testKeys": [{ "keyway": "Y159", "poolQty": 12 }],
  "emergencyKey": { "pn": "40259", "price": 7.95 },
  "shell": null,
  "prices": { "a": 84, "b": null, "oem": null },  // always numbers
  "ilco": null, "notes": null,
  "supersededBy": null, "replaces": [], "discontinued": false,
  "source": "builtin",              // or "custom"
  "vehicles": [{ "make": "Jeep", "model": "Grand Cherokee", "startYear": 2022, "endYear": 2023,
                 "codeSeries": [{ "series": "...", "years": "..." }] }],
  "legacy": { "originalMake": "Chrys/Dodge/Jeep/Ram" }  // fields with no home in the schema yet
}
```

### Vehicle record

Sorted make → model → category (Keyed Ignition first) → years.

```jsonc
{
  "make": "Jeep", "model": "Grand Cherokee", "category": "Proximity",
  "startYear": 2022, "endYear": 2023,
  "keys": ["8701"], "fids": [], "fccIds": ["M3NWXF0B1"], "chips": ["Hitag AES Type 4A"],
  "keyways": ["Y159"],
  "lishi": [{ "tool": "CY24", "direction": "CW", "inStock": false }],  // per-vehicle direction override wins
  "testKeys": [{ "keyway": "Y159", "poolQty": 12 }],
  "codeSeries": [], "notes": null,
  "dualKey": { "ignition": [...], "door": [...] },  // only for split ignition/door vehicles
  "source": "builtin"
}
```

## Normalization rules

- Whitespace collapsed. Case and spacing variants of a chip, keyway, frequency
  or make merge into the most common spelling (listed in the report).
- Prices parsed to numbers (`"$119"` → `119`). Non-prices such as
  `"Discontinued"` are kept under `legacy` and listed in the report.
- Batteries become `CR####` plus a count (`"2025 x2"` → `CR2025`, 2).
- `chip: "No"` → `"None"`.
- Years are integers. A missing end year equals the start year, and reversed
  ranges are swapped. Unusable years are listed in the report.
- Dropped as display-only or superseded by real stock counts: `logo`,
  `vehiclesRaw`, `stockQty`, `inStock`.
