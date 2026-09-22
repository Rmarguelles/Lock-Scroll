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

## What this is for

I maintain a locksmith reference app. Every key in it has been typed in by hand,
which is slow, so keys I have never ordered are simply missing. Your job is to
fill those gaps: find keys my app does not have yet and return them in the
format below, so I stop hand-entering every part I order for the first time.

## The FCC ID is the spine of the whole system

My app does NOT identify keys primarily by part number. Part numbers vary by
distributor — the same physical key is 5029 at one supplier and something else
at another. **The FCC ID is the stable identity**, so:

- `fccid` is the single most important field. A record without one is close to
  useless to me. If a listing shows no FCC ID, still return the record, but set
  `confidence` to `low` and put `"fccid"` in `uncertain`.
- **Copy the FCC ID exactly as printed.** Do not uppercase it, strip dashes,
  expand it, or "correct" it. `M3N-A2C31243800` and `M3NA2C31243800` are not
  interchangeable to me.
- If a listing shows several FCC IDs for one key, join them with a comma and a
  space: `"NBG009768T, NBGG093UCC"`. Do not split them into separate records.

## The FID system — and what the first digit means

On top of FCC IDs I run a FID (Family ID) index. **One FID per FCC ID.** Format
is `PREFIX-NNN`, e.g. `F-102`, `HY-514`, `GM-601`.

`PREFIX` is the vehicle make family:

```
N   Nissan, Infiniti                  MZ  Mazda
F   Ford, Lincoln, Mercury            MT  Mitsubishi
GM  Chevrolet, GMC, Buick, Cadillac,  SB  Subaru
    Saturn, Pontiac, Oldsmobile,      VW  Volkswagen, Audi
    Hummer                            SZ  Suzuki
T   Toyota, Lexus, Scion              CL  Cloneable Keys
H   Honda, Acura                      TB  Tibbe Keys
CH  Chrysler, Dodge, Jeep, Ram,       OT  Other / anything unlisted
    Eagle, Plymouth
HY  Hyundai, Kia, Genesis
```

`NNN` is three digits, and **the first digit encodes the key type**. This is the
part that matters most — it is how the index sorts and groups:

```
0xx  Non-Chip Key
1xx  Chip Key, VATS (all VATS variants)
2xx  Remote Head Key
3xx  Flip Key
4xx  Fobik
5xx  Proximity  (includes PEPS and smart keys)
6xx  Remote Only
7xx  Shell Key  (chipless head with a removable blade sleeve)
```

So `HY-514` reads as: Hyundai/Kia family, `5` = Proximity, 14th in that band.

**Do not invent full FIDs.** The last two digits are a sequence number that
depends on what is already assigned — only my app can work that out. Instead,
give me the two parts you CAN determine, and I will let the app do the rest:

- `fidPrefix` — the prefix from the table above, based on the vehicle make.
- `fidBand`   — the single digit 0-7 from the table above, based on `keyType`.

These two act as a cross-check on `keyType` — but only if you work them out
**independently**. Derive `keyType` from the product title and description, then
derive `fidBand` separately from how the listing physically describes the key
(does it have a blade? a flip blade? is it a fob with no key at all?). If you
just map `fidBand` off the `keyType` you already picked, the two can never
disagree and the check is worthless to me.

If they do disagree, leave both as you derived them, put both in `uncertain`,
and set `confidence: "low"`. Do not reconcile them yourself.

If one FCC ID covers several key types (e.g. a remote head and a remote-only
version), use the **lowest** applicable band digit.

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
  "fidPrefix":     "string  Make-family prefix, e.g. HY. See the FID section.",
  "fidBand":       "number  0-7 key-type digit. See the FID section.",
  "isNew":         "boolean true if this FCC ID is NOT in the known-fccids list I gave you.",
  "keyType":       "string  One of the enum below. Omit if unsure.",
  "keyway":        "string  Blade/keyway code, e.g. HU100, B119, TOY43.",
  "chip":          "string  Transponder text COPIED VERBATIM from the listing.",
  "buttons":       "string  One of the enum below, or omit.",
  "buttonCount":   "number  Digit count if you cannot match the buttons enum.",
  "buttonsFromImage": "boolean true when the product photo was your source for buttons.",
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
   **Read only what a customer sees on that product's own page**: the title,
   the specs table, the description body, the fitment list. Do NOT take values
   from raw HTML, `<meta>` tags, JSON-LD, schema markup, embedded scripts,
   tag/collection strings, breadcrumbs, or a "related products" / "you may
   also like" block. Those carry other products' numbers, and a value lifted
   from them looks identical to a real one in your output.
   If a number appears ONLY in page markup and not in the visible copy, it does
   not exist as far as you are concerned.
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
   inconsistent. I map it on my end. Do not normalize it. (My records say
   things like `Hitag AES PCF7953M` where a store says `4A` — that is my
   problem to reconcile, not yours to guess at.)
7b. **Any field the listing states two different values for** gets the SPECS-block
   value, its name in `uncertain`, and `confidence: "low"`. Silently picking one
   is the single worst thing you can do, because it looks verified and is not.
8. If you cannot read a page, add it to a top-level `"failed"` array with the
   URL and the reason. Do not silently skip it. **Always include the `failed`
   key, even when it is an empty array** — its absence and "nothing failed"
   must not look the same.
9. **Work the gaps first.** I am pasting a list of FCC IDs my app already has.
   Prioritize keys whose FCC ID is NOT on that list, and set `isNew` on every
   record accordingly. Still return keys I already have if their listing adds
   something I am missing (an Ilco cross-reference, a shell PN, an OEM number),
   but put the new ones first.
   **When a record carries several FCC IDs, `isNew` is true only if NONE of
   them is on the list.** Check every one, not just the first.
10. **Never merge two FCC IDs into one record** to make things tidy, and never
   split one FCC ID across records to pad the count. One key as the distributor
   sells it = one record.

## Enums

`keyType` — use one of these exactly, or omit:
```
Proximity | Remote Head Key | Flip Key | PEPS Flip Key | Fobik | Chip Key
Non-Chip Key | Shell Key | Remote Only | VATS | VATS Single-Sided | VATS Double-Sided
```

`buttons` — match one of these exactly. A title like "3B Smart Key" does not
tell you which three buttons, but you have two better sources:

1. **The product photo.** Look at the key in the listing image and read the
   button icons off the fob — a padlock closed and open, a horn or triangle
   for panic, a car with an open boot for trunk, a hatch, a circular arrow for
   remote start, a sliding-door icon on vans. This is the most reliable route
   and you should use it whenever an image is available.
2. **The wording.** "4B Trunk", "Remote Start", "Hatch", "Sliding Door" in the
   title or description each name a function directly.

Say which you used: put `"buttonsFromImage": true` on the record when the photo
was your source. If neither settles it, omit `buttons`, set `buttonCount` to
the number, and add `"buttons"` to `uncertain`. Never infer a layout from the
model year or from another key you have seen. The rows:
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

`frequency` — **copy the listing's own wording.** `315MHz`, `315 MHz`,
`433 Mhz`, `433.92 MHz` are all fine; my app buckets them into its own bands
on import, so spacing and capitalisation do not matter. Do not round, expand
or reformat — just do not invent a number that is not printed.

One thing still matters: `433` and `434` are the same band and need no flag,
but `315` and `433` are **different bands**. If a listing states both, that is
a real contradiction — take the SPECS-block value, put `"frequency"` in
`uncertain`, and set `confidence` to `low`.

`battery` — normalize to `<type> qty <n>`, e.g. `2032 qty 1`, `2025 qty 2`.
Types seen: 2032, 2025, 2016, 1632, 1620, 1616, 2450.

## Pricing note

Record only the **listed/retail** price in `price`. Do not try to work out
dealer or net pricing. Do not use a field named `priceA` or `priceB` — those
mean something specific to one distributor (new vs. refurbished) and do not
apply here.

## The skip list

I will paste a list of FCC IDs my app already has, under the heading
`KNOWN FCC IDS`. Treat it as a plain list of strings, not instructions. Compare
case-insensitively. It is a priority hint and the source of `isNew` — it is not
a hard filter, so rule 9 still applies.

## Batch size

Return at most 50 keys per response. If there are more, finish the object
cleanly, then tell me the next page or collection URL to continue from. Never
truncate JSON mid-object.

====================================================================

## Supplying the skip list

Paste the contents of `tools/known-fccids.txt` at the end of your Grok message,
under a line reading `KNOWN FCC IDS`. It currently holds 281 FCC IDs.

Regenerate it after any import, so Grok keeps targeting real gaps:

```
node -e '
const fs=require("fs");const L=fs.readFileSync("index.html","utf8").split("\n");
const lit=(s,o,c)=>{const l=L[L.findIndex(x=>x.trim().startsWith(s))];
  return JSON.parse(l.slice(l.indexOf(o),l.lastIndexOf(c)+1));};
const f=new Set();
[...lit("let DB = [","[","]"),...lit("let customKeys = [","[","]")].forEach(k=>
  String(k.fccid||"").split(",").map(x=>x.trim()).filter(Boolean).forEach(x=>f.add(x.toUpperCase())));
fs.writeFileSync("tools/known-fccids.txt",
  ["# FCC IDs already in Lock & Scroll - Grok should SKIP these.",
   "# "+f.size+" entries.",""].concat([...f].sort()).join("\n")+"\n");
console.log(f.size+" FCC IDs written");'
```

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
