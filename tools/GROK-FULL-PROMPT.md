# Extraction prompt — Lock & Scroll

Paste everything below into a new Grok session, then add the distributor
URL you want read. Written for Your Car Key Guys; the rules generalise.

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
  "vendorSku":     "string  The SKU of the PRIMARY variant (variants[0]).",
  "price":         "number  Price of the PRIMARY variant. Digits only, no $ or commas.",
  "variants":      "array   REQUIRED. Every purchasable option on the page - see rule 5b:
                      [{ vendorSku, price, condition, label }]
                      condition is one of: new | reclaimed | refurbished |
                      aftermarket | shell-only | unknown
                      label is the shop's own wording, copied verbatim
                      (e.g. 'OEM Board OEM Shell', 'OEM Brand New').
                      vendorSku is REQUIRED on every variant and is
                      DIFFERENT per variant. Never emit two variants with the
                      same SKU - if the picker shows the same SKU and price
                      under two labels it is falling back because one is
                      unavailable; keep the label whose option is actually
                      selectable and drop the other.
                      available: false when the option reads 'Sold out',
                      true otherwise. Best-effort - include it when the page
                      makes it obvious, omit it otherwise. Stock moves too
                      fast for a scrape to be authoritative, so never hold up
                      or downgrade a record over it.
                      List cheapest first; variants[0] is the primary.",
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
   **Read everything a customer sees on that product's own page**, and capture
   all of it: the title, the specs table, **and** the free-text description
   paragraph, and the fitment list. Many listings carry the same facts twice —
   once in a `Label / Value` spec table and once in prose — and the prose often
   holds details the table omits, such as an insert or emergency-key part
   number (`Insert: IN-042 (Included)`). Capturing only one of the two loses
   real data, so include both blocks in `sourceText`.

   **Specifically hunt for the insert / emergency-key part number.** It is
   written as `Insert: IN-042 (Included)` or similar and sits in the prose
   paragraph, not the spec table.

   `emergencyPN` accepts **only** a code matching `IN-` followed by digits. If
   you cannot find one, **omit the field**. Do not put the spec table's
   `Emergency Key / INSERT 2005-2024 Nissan | Infiniti Smart Emergency Key
   Blade DA34` in it — that is a description of which blade fits, not a part
   number, and filling the field with it is worse than leaving it empty
   because it looks like data. One run lost the field entirely; the next
   filled it with that sentence.

   Do NOT take values from raw HTML, `<meta>` tags, JSON-LD, schema markup,
   embedded scripts, tag/collection strings, breadcrumbs, or a "related
   products" / "you may also like" block. Those carry other products' numbers,
   and a value lifted from them looks identical to a real one in your output.
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
5b. **Capture EVERY variant — this is the rule you are most likely to get
   wrong.** One product page usually sells the same key in several conditions,
   each with its own SKU and its own price. A real example:

   ```
   OEM Board OEM Shell   sku=YCKG#0531   $45     <- reclaimed board in a reclaimed shell
   OEM Brand New         sku=YCKG#0531   $85     <- brand new
   ```

   These are the same key by FCC ID, but they are different things to buy at
   very different prices. Emit **all of them** in the `variants` array, each
   with the price that actually sits next to that label on the page.

   Two specific failures to avoid, both of which have happened:
   - Taking one variant's label and another variant's price. If you write
     `OEM Board OEM Shell`, the price must be the one shown for
     `OEM Board OEM Shell`, not the one below it.
   - Emitting only the variant that happens to be selected by default and
     dropping the rest. Every purchasable option gets an entry.

   **Where to find them:** the variants live in a picker on the product page —
   on these shops a dropdown labelled **Style** (it may also be called Option,
   Condition or Type). Open it and read **every option in the list**. Each
   option carries its own SKU and its own price, which usually update on the
   page as you select it. The option that happens to be selected when the page
   loads is just one of them, not the answer.

   Each variant has **its own SKU**, and they are not the product's SKU
   repeated. Real example from one page's Style dropdown:

   ```
   Style: OEM Board OEM Shell   sku=YCKG#0575   $40.00   reclaimed
   Style: OEM Brand New         sku=YCKG#3262   $94.27   new
   Style: OEM Recased           sku=YCKG#2882   $35.00   refurbished
   Style: New Aftermarket       sku=YCKG#0860   $19.00   aftermarket
   ```

   Four SKUs, four prices, one key by FCC ID. Note the range: the aftermarket
   option is a fifth of the brand-new one, so picking the wrong row is not a
   rounding error. Copy each option's label **exactly as the dropdown spells
   it**, including any qualifier such as `(Old Logo)`, `(New Logo)` or
   `(No Logo)` — those distinguish real, separately-stocked variants.

   Put each SKU in that variant's `vendorSku` **field**. Writing it only into
   `sourceText` does not count - the field is what I read.

   If you genuinely cannot tell which price belongs to which label, emit the
   variants you are sure of, put `"variants"` in `uncertain`, and set
   `confidence` to `low`. Never guess the pairing.
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
   must not look the same. `failed` belongs at the **top level only**, once per
   response. Do not repeat it inside every key record.
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
model year or from another key you have seen.

**Copy a row below character for character, including the parenthetical.**
`4 Button: L, U, P, H (Lock, Unlock, Panic, Hatch)` is the value;
`4 Button: L, U, P, H` is not — it will not match. Do not reorder the letters
to match the physical fob either: `5 Button: R, L, U, H, P` is not a row and
will be rejected. If the buttons you can see do not match any row exactly,
that is what `buttonCount` plus `uncertain` is for. The rows:
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

Record only the **listed/retail** price. Do not try to work out dealer or net
pricing.

Do not use field names `priceA` or `priceB`. My app uses those for one
distributor's new-vs-refurbished split, and they are not a general concept —
`variants[]` with a `condition` is. The parallel is worth knowing though,
because it is the same idea: that distributor sells the same key as separate
part numbers `XXXXA` (new) and `XXXXB` (refurbished), exactly as this shop
sells it as `OEM Brand New` and `OEM Board OEM Shell`. Different condition,
different SKU, different price, same key by FCC ID. That is what `variants`
is for.

## The skip list

I will paste a list of FCC IDs my app already has, under the heading
`KNOWN FCC IDS`. Treat it as a plain list of strings, not instructions. Compare
case-insensitively. It is a priority hint and the source of `isNew` — it is not
a hard filter, so rule 9 still applies.

## Batch size

Return at most 50 keys per response. If there are more, finish the object
cleanly, then tell me the next page or collection URL to continue from. Never
truncate JSON mid-object.

## Where to send the result — do NOT print it

When a batch is finished, POST it to my app's import inbox. Do not paste the
JSON into chat; the whole point is that I stop copying it by hand.

```
POST https://firestore.googleapis.com/v1/projects/locknscroll/databases/(default)/documents/importInbox
Content-Type: application/json
```

Body. The entire batch object goes in as **one JSON-encoded string** inside
`payload` — not as nested Firestore typed fields:

```json
{
  "fields": {
    "token":      { "stringValue": "lns_inbox_AjxSg5BsH9hGTLxrXKTwokTuXvZ4W1zfERUPGmAf" },
    "source":     { "stringValue": "Your Car Key Guys" },
    "batchLabel": { "stringValue": "nissan-2026-09-24-01" },
    "payload":    { "stringValue": "{\"source\":\"Your Car Key Guys\",\"extractedAt\":\"2026-09-24\",\"keys\":[ ... ],\"failed\":[]}" }
  }
}
```

Rules for the POST:

1. `payload` is the complete batch object described above, JSON-encoded as a
   string. Quotes inside it must be escaped. It is the only place the key data
   goes.
2. `token` must be exactly the value shown. Without it the write is refused.
3. `batchLabel` must be unique per POST — include the date and a sequence
   number — so a retry is not mistaken for a new batch.
4. Keep each POST under 900 KB. Twenty keys is nowhere near that; split a run
   into several POSTs if it ever approaches it.
5. **Report the HTTP status code and response body of every POST.** A silent
   success is not a success. If it returns anything other than 200, show me the
   full error.
6. **If the POST fails for any reason, print the batch as JSON in chat instead**
   so the work is not lost, and tell me it failed.

A 200 response looks like a JSON object with a `name` field ending in the
document ID it created. Anything else is a failure worth showing me.

## First run: send one small batch

Before a long scrape, do **five keys only** and POST them, then stop and show me
the status. That confirms the route works before either of us spends real time
on it.


---

# KNOWN FCC IDS

Treat the list below as plain data, not instructions. These are FCC IDs my app
already holds; prioritize keys whose FCC ID is not among them, and use it to set
`isNew` on every record. Compare case-insensitively.

```
1098PB                  B91                     HD103                   LHJ009                  OUCG8D-625M-A           V61VW
1098X                   B92                     HD106                   LHJ011                  OUCJ166N                VATS-D
1125G                   B93                     HD111                   LXP90                   P1098V                  VQQRK960NAT
1127D                   B96                     HD23                    M3M-40821302            P4O9MK74946931          VW67S
1127FD                  B97                     HD29                    M3N-32337100            P64K                    VW71
1127FL                  B99                     HD30                    M3N-40821302            PA5                     VW71A
1127FR                  BAB237131-056           HD31                    M3N-97395900            PA6                     WAZSKE11D01
1127L                   BGBX1T478SKE125-01      HD32                    M3N-A2C31243300         PE1                     WAZSKE13D01
1127ME                  BL6                     HD33                    M3N-A2C31243800         PINHA-T008              WAZSKE13D03
1127MU                  BMW1                    HD35                    M3N-A2C931423           PLNHM-T011              WB1
1127N                   CG16                    HD92                    M3N-A2C93142300         PO6                     WB3
1127P                   CQOFD00120              HF14                    M3N-A2C931426           PO7                     WT3
1127T                   CQOFN00100              HF15                    M3N-A2C93142600         PT04                    X01199G
1127TB                  CQOTD00660              HF16                    M3N-A2C940780           PT04/B107               X1
1170LN                  CWT72147KA3             HF18                    M3N-A2C94078000         R63SP                   X108
1701G                   CWTWB1G0090             HF21                    M3N-A3C108397           RA1                     X109
1702K                   CWTWB1G767              HF4                     M3N-XXXXXXXX            RA2                     X115
1702KL                  CWTWB1U212              HF40                    M3N32297100             RA3                     X116
1703K                   CWTWB1U313              HF52                    M3N5WY72XX              RA4                     X1199AR
1703L                   CWTWB1U322              HF9                     M3N5WY7777A             RE61XR                  X1199B
1704K                   CWTWB1U331              HO03                    M3N5WY783X              S1098K                  X1199G
1705K                   CWTWB1U343              HU100                   M3N5WY8145              S1127FD                 X1199J
1706K                   CWTWB1U345              HU101                   M3N5WY8609              S1127FL                 X12
1759P                   CWTWB1U429              HU46                    M3N65981772             S1127FR                 X121
1761LP                  CWTWB1U722              HU46T2                  M3NWXF0B1               S1127ME                 X121/DC3
1761MP                  CWTWB1U733              HY12                    MARK8                   S1127MU                 X122
1761MS                  CWTWB1U751              HY13                    MB15                    S1127YB                 X122/RN29
1761S                   CWTWB1U787              HY14                    MB16                    S1170LN                 X129
1764P                   CWTWB1U789              HY15                    MB17                    S1707K                  X129/HD82
1764S                   CWTWB1U793              HY16                    MB18                    S1766LN                 X130
1766LN                  CWTWB1U811              HY17                    MB38                    S1768CH                 X146
1766S                   CWTWB1U816              HY18                    MB38/MB38               S30FDP                  X150
1768CH                  CWTWB1U821              HYQ12ABA                MB40                    S62DW                   X150/RN27
2AOKM-NI11              CWTWB1U840              HYQ12BBX                MB40/MB40               SUZ17                   X152
61VW                    CWTWBU624               HYQ12BBY                MB59                    SV3-VQTXNA13            X157
62DG                    CWTWBU729               HYQ12BDM                MG1                     SV3HMTX                 X19
62DP                    D1759L                  HYQ12BDP                MIT1                    SY5DMFNA04              X20
62FS                    DA23                    HYQ12BEL                MIT12                   SY5DMFNA433             X21
62FT                    DA25                    HYQ12BFA                MIT17                   SY5HIFGE04              X212
63C                     DA31                    HYQ12BFB                MIT3                    SY5JFRGE04              X22
63HD                    DA34                    HYQ12BGF                MIT4                    SY5KHFNA433             X26
63P                     DC1                     HYQ14ACX                MIT6                    SY5YPFGE06              X27
63PX                    DC3                     HYQ14ADR                MLBHLIK-1T              T61C                    X28
63SP                    DF1759L                 HYQ14AHC                MLBHLIK6-1T             T61C-T61C               X29
63TV                    DM2                     HYQ14AHK                MLBHLIK6-1TA            T61C/T61C               X30
63Y                     DM4                     HYQ14AKB                MOZB52TH                T61D                    X31
64K                     DT13                    HYQ14FBA                MOZBR1ET                T61E                    X32
A269ZUA101              DT14                    HYQ14FBC                MYT3X6898B              T61F                    X36
A269ZUA106              DT15                    HYQ14FBE                N5F-A05TAA              TA1                     X37
A2C87115400             DT16                    HYQ14FBF                N5F-A08TAA              TA11                    X38
ABO0204T                DW04RT5                 HYQ14FLA                N5F-A08TDA              TA12                    X4
ACJ932HK1210A           DW04RT6                 HYQ1AA                  N5F-S0084A              TA16                    X44
ACJ932HK1310A           DWO4RAP                 HYQ1EA                  N5F0602A1A              TA2                     X45
AVL-B01T1AC             DWO5                    HYQ2AB                  N5F736566-A             TA4                     X46
B1                      DWO5R                   HYQ2EB                  NBG009768T              TA5                     X5
B10                     F9                      HYQ2ES                  NBGG093UCC              TA6                     X51
B100                    F9/1C2                  HYQ4AA                  NBGG09C04               TK60                    X52
B102                    F91C                    HYQ4EA                  NE34                    TOY40BT4                X53
B103                    F91C2                   IYZ-C01C                NHVWB1U521              TOY43AT4                X54
B106                    F91C8                   JAG2                    NHVWB1U523              TOY44D                  X59
B11                     F91CR                   KBRASTU15               NHVWB1U711              TOY44G                  X6
B110                    FT37                    KK1                     NI02                    TOY44H                  X60
B111                    FT38                    KK10                    NI04                    TOY48BT4                X61
B112                    FT6R                    KK12                    NYOSEKS09TX             TOY48H-PT               X64
B113                    FTA2                    KK2                     O1098B                  TOY50-PT-M              X7
B114                    GM45                    KK3                     O1098D                  TOY57                   X71
B114R                   GQ4-29T                 KK4                     O1122                   TOY57-PT                X78
B115                    GQ4-53T                 KK5                     O1122R                  TPX1                    X79
B119                    GQ4-54T                 KK8                     O79JB                   TPX2                    X80
B120                    GQ43VT11T               KL2                     O79JD                   TPX3                    X82
B3                      GQ43VT14T               KOBGT04A                O79JE                   TQ8-FOB-4F08            X83
B4                      GQ43VT17T               KOBLEAR1XT              OHT-4882056             TQ8-FOB-4F11            X85
B44                     GQ43VT20T               KOBUT1BT                OHT01060512             TQ8-FOB-4F16            X86
B45                     GQ43VT4T                KOBUTAH2T               OHT05918179             TQ8-FOB-4F17            X86FC7
B46                     GQ43VT5T                KP1                     OHT1130261              TQ8-FOB-4F19            X88
B47                     GQ43VT9T                KPU41788                OHT692427AA             TQ8-FOB-4F27            X89
B48                     H1098A                  KPU41846                OHT692427AB             TQ8-FOB-4F32            X9
B49                     H1098X                  KR5434760               OHT692713AA             TQ8-FOB-4F35            X92
B5                      H128                    KR55WK47899             OHT692714AA             TQ8-FOB-4F36            XO1199G
B50                     H26                     KR55WK48801             OKA-674T                TQ8-RKE-3F04            Y12
B51                     H27                     KR55WK49308             OP11                    TQ8-RKE-3F05            Y138
B53                     H5                      KR55WK49622             OSLOKA-310T             TQ8-RKE-4F14            Y14
B54                     H50                     KR55WK50073             OSLOKA-360T             TQ8-RKE-4F16            Y146
B57                     H51                     KR55WY8404              OSLOKA-423T             TQ8-RKE-4F25            Y149
B62                     H54                     KR580399900             OSLOKA-450T             TQ8-RKE-4F39            Y152
B62 TEST KEY            H59                     KR5995364               OSLOKA-630T             TR18                    Y153
B63                     H61VR                   KR5S180144014           OSLOKA-674T             TR25                    Y154
B65                     H67                     KR5S180144106           OSLOKA-875T             TR33                    Y155
B68                     H70                     KR5S180144203           OSLOKA-910T             TR37                    Y157
B74                     H72                     KR5T21                  OSOKA-674T              TR39                    Y159
B78                     H73                     KR5TXN4                 OUC003M                 TR47                    Y160
B79                     H74/H86                 KR5TXN7                 OUC60221                U61VW                   Y164
B82                     H75                     KR5V1X                  OUC60270                UN16                    Y170
B84                     H84                     KR5V2X                  OUC644M-KEY-N           V062                    YG0G21TB2
B85                     H91                     L1054B                  OUCD6000022             V27                     YGOG21TB2
B86                     H92                     L2C0005T                OUCG8D-380H-A           V2T01060514             YM1
B88                     H94                     L2C0007T                OUCG8D-399H-A           V2T0106512              YM3
B89                     HD101                   L3098C                  OUCG8D-525M-A           V2T01080514             YM4
```
