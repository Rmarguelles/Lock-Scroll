# Grok extraction prompt

Paste everything between the `====` markers into Grok, then add the distributor
URL(s) you want it to read. Output goes into the app's review queue — **not**
through Settings → Import (see the warning at the bottom of this file).

Re-paste the whole prompt at the start of each new Grok session. Do one
distributor per session; mixing them in one run is where vendor-specific
pricing rules get crossed.

====================================================================

You are extracting automotive key data from a locksmith distributor's website
into a strict JSON format. Accuracy matters far more than coverage: a missing
field is fine, a guessed field is a defect.

## Output format

Return ONE JSON object, nothing else. No prose before or after, no markdown
fences. Shape:

```
{
  "source": "<distributor name exactly as I gave it to you>",
  "sourceUrl": "<the listing/collection URL you read>",
  "extractedAt": "<today's date, YYYY-MM-DD>",
  "keys": [ { ...one object per part number... } ]
}
```

Each object in `keys`:

```
{
  "pn":            "string  REQUIRED. The distributor's own part number / SKU.",
  "vendorSku":     "string  The SKU as shown, if it differs from pn.",
  "price":         "number  Listed price, digits only. No $ sign, no commas.",
  "fccid":         "string  FCC ID exactly as printed. Several -> comma+space separated.",
  "keyType":       "string  One of the enum below. Omit if unsure.",
  "keyway":        "string  Blade/keyway code, e.g. HU100, B119, TOY43.",
  "chip":          "string  Transponder text COPIED VERBATIM from the listing.",
  "buttons":       "string  One of the enum below, or omit.",
  "buttonCount":   "number  Digit count if you cannot match the buttons enum.",
  "frequency":     "string  e.g. \"315 MHz\", \"433.92 MHz\". Keep the unit.",
  "battery":       "string  Format exactly: \"2032 qty 1\".",
  "oemPartNumber": "string  The vehicle maker's OEM number, if listed.",
  "ilco":          "string  Ilco cross-reference, if listed.",
  "emergencyPN":   "string  Emergency/insert key part number, if listed.",
  "shellPN":       "string  Replacement shell part number, if listed.",
  "memorySeat":    "number  1, 2 or 3 ONLY if the listing says the fob is tied to a driver memory position.",
  "vehicles": [
    { "make": "Toyota", "model": "Camry", "startYear": 2018, "endYear": 2024 }
  ],
  "productUrl":    "string  Direct link to this product page.",
  "sourceText":    "string  The raw title + spec text you read this from.",
  "confidence":    "string  \"high\" | \"medium\" | \"low\" — see rules.",
  "uncertain":     ["field names you guessed at or could not verify"]
}
```

## Hard rules

1. **Never invent a value.** If the listing does not state it, omit the key
   entirely. Do not infer chip type from the year, do not infer frequency from
   the region, do not infer keyway from the make. Omission is correct behavior.
2. **`sourceText` is mandatory** on every record — paste the actual title and
   spec text you read. It is how I verify you without revisiting the site.
3. **`confidence`**: `high` = every populated field is printed verbatim on the
   page. `medium` = you normalized wording (e.g. "4-button remote" into the
   buttons enum). `low` = anything else. List every non-verbatim field in
   `uncertain`.
4. **Prices are bare numbers.** `164` not `$164`, `1299` not `1,299`. If a
   listing shows a range or "call for price", omit `price`.
5. **One record per part number.** If a page sells the same key under several
   part numbers, emit one record each. Do not merge them.
6. **Do not convert years.** "18-24" becomes `startYear: 2018, endYear: 2024`.
   A single year becomes `startYear` and `endYear` both set to it. If the
   listing gives no years, omit `vehicles` rather than guessing.
7. **`chip` verbatim.** Copy the transponder text as printed, even if it looks
   inconsistent. I map it on my end. Do not normalize it.
8. If you cannot read a page, add it to a top-level `"failed"` array with the
   URL and the reason. Do not silently skip it.

## Enums

`keyType` — use one of these exactly, or omit:
```
Proximity | Remote Head Key | Flip Key | PEPS Flip Key | Fobik | Chip Key
Non-Chip Key | Shell Key | Remote Only | VATS | VATS Single-Sided | VATS Double-Sided
```

`buttons` — match one of these exactly. If none fits, omit `buttons` and set
`buttonCount` to the number instead:
```
2 Button: L, U (Lock, Unlock)
3 Button: L, U, P (Lock, Unlock, Panic)
3 Button: L, U, T (Lock, Unlock, Trunk)
3 Button: L, U, H (Lock, Unlock, Hatch)
3 Button: L, U, PSD (Lock, Unlock, Power Sliding Door)
4 Button: L, U, P, T (Lock, Unlock, Panic, Trunk)
4 Button: L, U, P, H (Lock, Unlock, Panic, Hatch)
4 Button: L, U, P, RS (Lock, Unlock, Panic, Remote Start)
4 Button: L, U, P, G (Lock, Unlock, Panic, Gate)
4 Button: L, U, P, RG (Lock, Unlock, Panic, Rear Glass)
4 Button: L, U, P, PSD (Lock, Unlock, Panic, Power Sliding Door)
4 Button: L, U, P, CH (Lock, Unlock, Panic, Charge)
4 Button: L, U, P, AC (Lock, Unlock, Panic, Air Conditioning)
5 Button: L, U, P, T, RS (Lock, Unlock, Panic, Trunk, Remote Start)
5 Button: L, U, P, H, RS (Lock, Unlock, Panic, Hatch, Remote Start)
5 Button: L, U, P, RG, RS (Lock, Unlock, Panic, Rear Glass, Remote Start)
5 Button: L, U, P, PSD2 (Lock, Unlock, Panic, Dual Power Sliding Doors)
5 Button: L, U, P, TG, RS (Lock, Unlock, Panic, Tailgate, Remote Start)
6 Button: L, U, P, H, PSD2 (Lock, Unlock, Panic, Hatch, Dual Power Sliding Doors)
6 Button: L, U, P, T, PSD2 (Lock, Unlock, Panic, Trunk, Dual Power Sliding Doors)
6 Button: L, U, P, H, RS, HTL (Lock, Unlock, Panic, Hatch, Remote Start, Head & Tail Lights)
6 Button: L, U, P, T, RS, HTL (Lock, Unlock, Panic, Trunk, Remote Start, Head & Tail Lights)
7 Button: L, U, P, H, PSD2, RS (Lock, Unlock, Panic, Hatch, Dual PSD, Remote Start)
8 Button: L, U, P, H, RSPA-F, RSPA-R, HTL (Lock, Unlock, Panic, Hatch, RSPA Front/Rear, Head & Tail Lights)
None (Transponder Only)
```

`frequency` — keep the listing's own value with its unit. Common ones:
`305-320 MHz`, `315 MHz`, `314.95 MHz`, `433.92 MHz`, `434 MHz`, `868 MHz`,
`902 MHz`, `923 MHz`.

`battery` — normalize to `<type> qty <n>`, e.g. `2032 qty 1`, `2025 qty 2`.
Types seen: 2032, 2025, 2016, 1632, 1620, 1616, 2450.

## Pricing note

Record only the **listed/retail** price in `price`. Do not try to work out
dealer or net pricing. Do not use a field named `priceA` or `priceB` — those
mean something specific to one distributor (new vs. refurbished) and do not
apply here.

## Batch size

Return at most 50 keys per response. If there are more, finish the object
cleanly, then tell me the next page or collection URL to continue from. Never
truncate JSON mid-object.

====================================================================

## After Grok returns

Save each response as its own file, e.g. `uhs-batch-01.json`. Keep the raw
files — the review queue works from them and they are the audit trail.

## WARNING — do not use Settings → Import

`importData()` **replaces** stores rather than merging them:

```js
if (data.customKeys)   { customKeys = data.customKeys; }
if (data.vendorPrices) { vendorPrices = data.vendorPrices; }
```

Feeding a Grok file through that screen would wipe your 41 hand-entered custom
keys and all 652 vendor price entries. The importer for this data is a separate
review-queue flow that has not been built yet.
