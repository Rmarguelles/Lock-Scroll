# Key data extraction report

Extracted 2026-10-08T14:37:04.372Z from app v268 (built-in catalog only, no backup).

## Totals

| | |
|---|---|
| Keys | 475 (0 custom) |
| Vehicle rows (make/model/category/years) | 1199 |
| Makes | 31 |
| Keys with an FID | 32 |
| FIDs | 2 |
| Keys with Lishi | 325 |
| Keys in stock | 0 |
| Test key keyways | 0 |
| Lishi tools | 74 |

### Keys by category

| Category | Keys |
|---|---|
| Keyed Ignition | 286 |
| Proximity | 189 |

### Keys by original key type

| Key type | Keys |
|---|---|
| Proximity | 189 |
| Remote Only | 78 |
| Chip Key | 75 |
| Remote Head Key | 58 |
| Flip Key | 21 |
| VATS Single-Sided | 16 |
| VATS Double-Sided | 14 |
| Fobik | 13 |
| Non-Chip Key | 9 |
| VATS | 2 |

## Gaps worth filling

- Keys with no vehicles: 9409, 40011, 40012, 40013, 40014, 40015, 40016, 40017, 40018, 40019, 40020, 40021, 40022, 40023, 40024, 40025, 40082, 40083, 40084, 40085, 40086, 40087, 40088, 40089, 40090, 40091, 40092, 40093, 40094, 40095, 42105, 42771, 45506, 45513, 45514, 45516, 45556, 45557, 45558, 45559, 45561, 45562, 45582, 45583, 48180, 48212, 48258, 48287, 48288, 48516, 48522, DWO5, DWO5R, JAG2, S30FDP, TOY57, Y159
- Keys with no FCC ID: 15
- Keys with no chip recorded: 48
- Keys with no keyway: 78
- Keyed-ignition keys with a keyway but no Lishi: 53
- Keys with no FID: 443

## Cleanup decisions

### Spelling variants merged (most common spelling wins)

**chip**

- "HITAG 3" ×22, "Hitag 3" ×1 → "HITAG 3"
- "Hitag Pro" ×1, "HITAG Pro" ×24 → "HITAG Pro"
- "HITAG 3 PCF7920 MANCHESTER" ×4, "HITAG 3 PCF7920 Manchester" ×4 → "HITAG 3 PCF7920 Manchester"

### Prices that were not numbers

- key 5012 emergencyPrice: "Discontinued" is not a price, kept in legacy
- key 8533 emergencyPrice: "Discontinued" is not a price, kept in legacy
- key 5106 emergencyPrice: "Discontinued" is not a price, kept in legacy

### Year problems

- key 8231: Nissan Quest has no usable year (201)
- key 8142: Nissan Quest has no usable year (201)
- vehicle Nissan|Quest|201|2017: Nissan Quest has no usable year (201)

### Duplicate part numbers

- none

## Cross-check against backup

- No backup supplied: built-in catalog only.
