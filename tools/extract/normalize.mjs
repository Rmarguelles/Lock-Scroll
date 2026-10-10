// Stage 2 of the key-data extraction: turn the app-state dump from dump.mjs
// into clean, uniformly formatted data files for the new app.
//
//   node tools/extract/normalize.mjs [app-state.json] [outDir]
//
// Writes keys.json, vehicles.json, lishi-tools.json, test-keys.json,
// fids.json and REPORT.md. No value is dropped silently: fields with no
// place in the new schema land in each record's `legacy` block, and every
// cleanup decision is listed in REPORT.md for review.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inPath = path.resolve(process.argv[2] || path.join(ROOT, 'data/raw/app-state.json'));
const outDir = path.resolve(process.argv[3] || path.join(ROOT, 'data'));
const state = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const S = state.stores;

const SCHEMA_VERSION = 1;
const report = { spelling: {}, prices: [], years: [], dupPns: [], crossCheck: [], notes: [] };

// ---------- value helpers ----------

const isBlank = v => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const str = v => (isBlank(v) ? null : String(v).replace(/\s+/g, ' ').trim());

function money(v, where) {
    if (isBlank(v)) return null;
    if (typeof v === 'number') return v;
    const m = String(v).replace(/[$,\s]/g, '').match(/^\d+(\.\d+)?$/);
    if (m) return Number(m[0]);
    report.prices.push(`${where}: "${v}" is not a price, kept in legacy`);
    return undefined; // caller keeps the raw value in legacy
}

// Case/spacing variants of the same value collapse to the most common spelling.
const spellingPools = {};
function countSpelling(field, v) {
    v = str(v);
    if (!v) return;
    const k = v.toLowerCase().replace(/[\s\-_]/g, '');
    const pool = (spellingPools[field] ||= {});
    (pool[k] ||= {})[v] = ((pool[k] || {})[v] || 0) + 1;
}
function canonical(field, v) {
    v = str(v);
    if (!v) return null;
    const variants = spellingPools[field]?.[v.toLowerCase().replace(/[\s\-_]/g, '')];
    if (!variants) return v;
    return Object.entries(variants).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

function battery(v) {
    v = str(v);
    if (!v) return { battery: null, batteryCount: null };
    const m = v.match(/^(?:CR\s*)?(\d{4})(?:\s*(?:x|qty)\s*(\d+))?$/i);
    if (!m) return { battery: v, batteryCount: null };
    return { battery: 'CR' + m[1], batteryCount: m[2] ? Number(m[2]) : 1 };
}

function buttons(v) {
    v = str(v);
    if (!v) return { buttons: null, buttonCount: null };
    const m = v.match(/^(\d+)\s*Button/i);
    return { buttons: v, buttonCount: m ? Number(m[1]) : null };
}

function chip(v) {
    v = str(v);
    if (!v) return null;
    if (/^(no|none|non[- ]?chip)$/i.test(v)) return 'None';
    return canonical('chip', v);
}

function year(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 1900 && n < 2100 ? n : null;
}

function codeSeries(v) {
    const out = [];
    const add = cs => {
        if (!cs) return;
        if (typeof cs === 'string') { const s = str(cs); if (s) out.push({ series: s, years: null }); return; }
        if (Array.isArray(cs)) return cs.forEach(add);
        if (cs.series) out.push({ series: str(cs.series), years: str(cs.years) });
    };
    add(v);
    const seen = new Set();
    return out.filter(c => { const k = c.series + '|' + c.years; return !seen.has(k) && seen.add(k); });
}

function vehicleRange(v, where) {
    let start = year(v.startYear), end = year(v.endYear) ?? start;
    if (start && end && start > end) {
        report.years.push(`${where}: ${v.make} ${v.model} ${start}-${end} reversed, swapped`);
        [start, end] = [end, start];
    }
    if (!start) report.years.push(`${where}: ${v.make} ${v.model} has no usable year (${v.startYear})`);
    return { start, end };
}

// ---------- pass 1: collect spellings ----------

for (const { record: r } of state.keys) {
    countSpelling('chip', r.chip);
    countSpelling('keyway', r.keyway);
    countSpelling('frequency', r.frequency);
    (r.vehicles || []).forEach(v => countSpelling('make', v.make));
}
for (const v of state.vehicles) countSpelling('make', v.make);
for (const [field, pool] of Object.entries(spellingPools)) {
    for (const variants of Object.values(pool)) {
        if (Object.keys(variants).length > 1) {
            const winner = canonical(field, Object.keys(variants)[0]);
            (report.spelling[field] ||= []).push(`${Object.entries(variants).map(([s, n]) => `"${s}" ×${n}`).join(', ')} → "${winner}"`);
        }
    }
}

// ---------- keys ----------

// Fields consumed into the new schema; everything else goes to legacy.
const KEY_FIELDS = new Set(['pn', 'keyType', 'fccid', 'fccids', 'chip', 'frequency', 'buttons', 'battery',
    'keyway', 'lishiTools', 'emergencyPN', 'emergencyPrice', 'shellPN', 'shellPrice', 'priceA', 'priceB',
    'oem', 'ilco', 'notes', 'vehicles', 'mergedPNs', 'isCustom', 'vehiclesRaw', 'stockQty', 'inStock', 'logo']);
// Dropped outright: display-only or superseded by real stock counts.
const KEY_DROP = new Set(['vehiclesRaw', 'stockQty', 'inStock', 'logo']);

const keys = [];
const pnSeen = new Map();
for (const { record: r, computed: c } of state.keys) {
    const pn = str(r.pn);
    const where = `key ${pn}`;
    if (pnSeen.has(pn.toLowerCase())) report.dupPns.push(`${pn} appears more than once (kept both)`);
    pnSeen.set(pn.toLowerCase(), true);

    const legacy = {};
    for (const [k, v] of Object.entries(r)) {
        if (!KEY_FIELDS.has(k) && !KEY_DROP.has(k) && !isBlank(v)) legacy[k] = v;
    }
    const price = (field, v) => {
        const m = money(v, `${where} ${field}`);
        if (m === undefined) { legacy[field] = v; return null; }
        return m;
    };

    const vehicles = (r.vehicles || []).map(v => {
        const { start, end } = vehicleRange(v, where);
        const out = { make: canonical('make', v.make), model: str(v.model), startYear: start, endYear: end };
        const cs = codeSeries(v.codeSeries);
        if (cs.length) out.codeSeries = cs;
        const extra = Object.fromEntries(Object.entries(v).filter(([k, val]) =>
            !['make', 'model', 'startYear', 'endYear', 'codeSeries'].includes(k) && !isBlank(val)));
        if (Object.keys(extra).length) out.legacy = extra;
        return out;
    }).sort((a, b) => (a.make || "").localeCompare(b.make || "") || (a.model || "").localeCompare(b.model || "") || (a.startYear || 0) - (b.startYear || 0));

    const emergencyPrice = price('emergencyPrice', r.emergencyPrice);
    const shellPrice = price('shellPrice', r.shellPrice);
    const key = {
        pn,
        category: c.category,
        keyType: str(r.keyType),
        fid: c.fids[0] || null,
        fccIds: c.fccIds.map(f => f.toUpperCase()),
        chip: chip(r.chip),
        frequency: canonical('frequency', r.frequency),
        ...buttons(r.buttons),
        ...battery(r.battery),
        keyway: canonical('keyway', r.keyway),
        lishi: (c.lishiTools || []).map(t => ({ tool: str(t.tool), direction: t.direction === 'CCW' ? 'CCW' : 'CW' })).filter(t => t.tool),
        stock: Number(c.stock) || 0,
        testKeys: c.testKeys,
        emergencyKey: str(r.emergencyPN) || emergencyPrice != null ? { pn: str(r.emergencyPN), price: emergencyPrice } : null,
        shell: str(r.shellPN) || shellPrice != null ? { pn: str(r.shellPN), price: shellPrice } : null,
        prices: { a: price('priceA', r.priceA), b: price('priceB', r.priceB), oem: price('oem', r.oem) },
        ilco: str(r.ilco),
        notes: str(r.notes),
        supersededBy: c.supersededBy || null,
        replaces: Array.isArray(r.mergedPNs) ? r.mergedPNs.map(String) : [],
        discontinued: !!S.discontinuedPns?.[pn],
        source: r.isCustom ? 'custom' : 'builtin',
        vehicles
    };
    if (c.fids.length > 1) key.otherFids = c.fids.slice(1);
    if (Object.keys(legacy).length) key.legacy = legacy;
    keys.push(key);
}
keys.sort((a, b) => a.pn.localeCompare(b.pn, undefined, { numeric: true }));
const keyByPn = new Map(keys.map(k => [k.pn, k]));

// ---------- lishi tools ----------

const lishiTools = {};
const toolNames = new Set([...Object.keys(S.MASTER_LISHI_TOOLS || {}), ...Object.keys(S.lishiInventory || {})]);
for (const name of [...toolNames].sort()) {
    const m = S.MASTER_LISHI_TOOLS?.[name] || {};
    const inv = S.lishiInventory?.[name] || {};
    const t = { ...m, ...inv };
    lishiTools[name] = {
        tool: name,
        keyways: [...new Set([...(m.keyways || []), ...(inv.keyways || [])])],
        door: t.door !== false, ignition: t.ignition !== false, trunk: t.trunk !== false,
        inStock: !!t.inStock,
        qty: Number.isFinite(t.qty) ? t.qty : null,
        codeSeries: codeSeries(t.codeSeries),
        notes: str(t.notes)
    };
}
// Keyway -> tool map the app keeps separately (lishiData), folded in for reference
const keywayToLishi = Object.fromEntries(Object.entries(S.lishiData || {}).map(([kw, d]) => [kw, { tool: d.tool, direction: d.direction || 'CW' }]));

// ---------- test keys ----------

const testKeys = {};
for (const [kw, e] of Object.entries(S.testKeyInventory || {})) {
    if (!(kw in state.testKeyPools)) continue; // renamed-away / dead entries
    testKeys[kw] = {
        keyway: kw,
        blankPn: str(e.linkedPn || e.pn),
        linkedPns: [...new Set([e.linkedPn, ...(Array.isArray(e.linkedPns) ? e.linkedPns : [])].filter(Boolean).map(String))],
        qty: Number(e.qty) || 0,
        poolQty: state.testKeyPools[kw],
        notes: str(e.notes)
    };
}

// ---------- FIDs ----------

const fids = {};
for (const k of keys) {
    for (const fid of [k.fid, ...(k.otherFids || [])].filter(Boolean)) {
        const f = (fids[fid] ||= { fid, prefix: fid.split('-')[0], group: null, fccIds: [], keys: [] });
        f.keys.push(k.pn);
        k.fccIds.forEach(x => f.fccIds.includes(x) || f.fccIds.push(x));
    }
}
for (const f of Object.values(fids)) f.group = S.fidPrefixes?.[f.prefix]?.name || null;

// ---------- vehicles: make -> model -> category -> years ----------

const vehicles = [];
for (const v of state.vehicles) {
    const override = S.lishiVehicleData?.[v.groupKey] || {};
    const rowKeys = v.keys.map(pn => keyByPn.get(String(pn))).filter(Boolean);
    const byCat = {};
    rowKeys.forEach(k => (byCat[k.category] ||= []).push(k));
    if (!rowKeys.length) byCat[v.customKeyType || 'Keyed Ignition'] = [];

    for (const [category, ks] of Object.entries(byCat)) {
        const { start, end } = vehicleRange(v, `vehicle ${v.groupKey}`);
        const uniq = arr => [...new Set(arr.filter(Boolean))].sort();
        const keywaysHere = uniq(ks.map(k => k.keyway));
        const lishi = [];
        ks.forEach(k => k.lishi.forEach(t => {
            if (lishi.some(x => x.tool === t.tool)) return;
            lishi.push({ tool: t.tool, direction: override.direction || t.direction, inStock: !!lishiTools[t.tool]?.inStock });
        }));
        const tks = [];
        ks.forEach(k => k.testKeys.forEach(t => tks.some(x => x.keyway === t.keyway) || tks.push(t)));
        keywaysHere.forEach(kw => testKeys[kw] && !tks.some(x => x.keyway === kw) && tks.push({ keyway: kw, poolQty: testKeys[kw].poolQty }));

        const rec = {
            make: canonical('make', v.make),
            model: str(v.model),
            category,
            startYear: start,
            endYear: end,
            keys: ks.map(k => k.pn).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
            fids: uniq(ks.flatMap(k => [k.fid, ...(k.otherFids || [])])),
            fccIds: uniq(ks.flatMap(k => k.fccIds)),
            chips: uniq(ks.map(k => k.chip)),
            keyways: keywaysHere,
            lishi,
            testKeys: tks,
            codeSeries: codeSeries(override.codeSeries).length ? codeSeries(override.codeSeries) : codeSeries(v.codeSeries),
            notes: str(override.notes),
            source: v.isCustom ? 'custom' : 'builtin'
        };
        if (override.multipleKeys || v.multipleKeys) {
            rec.dualKey = {
                ignition: (v.ignitionKeys || []).map(x => ({ pn: str(x.keyBlank), keyway: str(x.keyway), chip: chip(x.chip), codeSeries: codeSeries(x.codeSeries) })),
                door: (v.doorKeys || []).map(x => ({ pn: str(x.keyBlank), keyway: str(x.keyway), chip: chip(x.chip), codeSeries: codeSeries(x.codeSeries) }))
            };
        }
        const extra = Object.fromEntries(Object.entries(override).filter(([k, val]) =>
            !['direction', 'codeSeries', 'notes', 'multipleKeys'].includes(k) && !isBlank(val)));
        if (Object.keys(extra).length) rec.legacy = extra;
        vehicles.push(rec);
    }
}
const CAT_ORDER = { 'Keyed Ignition': 0, 'Proximity': 1 };
vehicles.sort((a, b) => (a.make || "").localeCompare(b.make || "") || (a.model || "").localeCompare(b.model || "")
    || CAT_ORDER[a.category] - CAT_ORDER[b.category] || (a.startYear || 0) - (b.startYear || 0) || (a.endYear || 0) - (b.endYear || 0));

// ---------- cross-check against the backup's own merged records ----------

if (Array.isArray(state.backupRecords)) {
    const ours = new Set(state.keys.map(k => String(k.record.pn).toLowerCase()));
    const theirs = new Set(state.backupRecords.map(r => String(r.pn).toLowerCase()));
    const missing = [...theirs].filter(p => !ours.has(p));
    const extra = [...ours].filter(p => !theirs.has(p));
    report.crossCheck.push(`Backup listed ${theirs.size} keys; extraction has ${ours.size}.`);
    if (missing.length) report.crossCheck.push(`In backup but not extracted (${missing.length}): ${missing.join(', ')}`);
    if (extra.length) report.crossCheck.push(`Extracted but not in backup (${extra.length}): ${extra.join(', ')}`);
    const byPn = new Map(state.keys.map(k => [String(k.record.pn).toLowerCase(), k.record]));
    let diffs = 0;
    for (const r of state.backupRecords) {
        const o = byPn.get(String(r.pn).toLowerCase());
        if (!o) continue;
        for (const f of ['keyType', 'fccid', 'chip', 'keyway', 'buttons', 'frequency']) {
            if (String(o[f] ?? '') !== String(r[f] ?? '')) {
                if (diffs++ < 50) report.crossCheck.push(`${r.pn} ${f}: backup "${r[f]}" vs extracted "${o[f]}"`);
            }
        }
        if ((o.vehicles || []).length !== (r.vehicles || []).length && diffs++ < 50) {
            report.crossCheck.push(`${r.pn} vehicles: backup ${(r.vehicles || []).length} vs extracted ${(o.vehicles || []).length}`);
        }
    }
    if (diffs === 0) report.crossCheck.push('Every shared key matches the backup on type, FCC, chip, keyway, buttons, frequency and vehicle count.');
    else if (diffs > 50) report.crossCheck.push(`…and ${diffs - 50} more differences.`);
    if (state.backupFidAssignments) {
        const before = state.backupFidAssignments, after = S.fidAssignments || {};
        const changed = Object.keys({ ...before, ...after }).filter(f => before[f] !== after[f]);
        report.crossCheck.push(changed.length
            ? `FID assignments changed during extraction (${changed.length}): ${changed.map(f => `${f} ${before[f] ?? '—'} → ${after[f] ?? '—'}`).join(', ')}`
            : `All ${Object.keys(before).length} FID assignments match the backup.`);
    }
} else {
    report.crossCheck.push('No backup supplied: built-in catalog only.');
}

// ---------- write ----------

const meta = { schemaVersion: SCHEMA_VERSION, extractedAt: state.extractedAt, fromApp: state.appVersion, backup: state.source?.backup || null };
const write = (name, data) => fs.writeFileSync(path.join(outDir, name), JSON.stringify({ meta, ...data }, null, 1) + '\n');
fs.mkdirSync(outDir, { recursive: true });
write('keys.json', { keys });
write('vehicles.json', { vehicles });
write('lishi-tools.json', { tools: lishiTools, keywayToTool: keywayToLishi });
write('test-keys.json', { testKeys });
write('fids.json', { fids, prefixes: S.fidPrefixes || {} });

// Distributor pricing: pn -> distributor -> prices. Kept as the app stores it
// (after its own PN renames/merges), minus empty entries; prices are text.
const priceText = v => (v == null || v === '' ? null : String(v).trim() || null);
const vendorPrices = {};
const knownPns = new Set(keys.map(k => k.pn));
let pricedEntries = 0;
const orphanPricePns = [];
Object.entries(S.vendorPrices || {}).forEach(([pn, byVendor]) => {
    const out = {};
    Object.entries(byVendor || {}).forEach(([vendor, p]) => {
        if (!p || typeof p !== 'object') return;
        const e = {
            sku: priceText(p.sku), priceA: priceText(p.priceA), priceB: priceText(p.priceB),
            emergency: priceText(p.emergency), shell: priceText(p.shell), oem: priceText(p.oem),
            variants: (Array.isArray(p.variants) ? p.variants : []).filter(v => v && priceText(v.price)).map(v => ({
                label: priceText(v.label) || priceText(v.condition), vendorSku: priceText(v.vendorSku), price: priceText(v.price),
            })),
        };
        Object.keys(e).forEach(f => { if (e[f] == null || (Array.isArray(e[f]) && !e[f].length)) delete e[f]; });
        if (Object.keys(e).some(f => f !== 'sku')) { out[vendor] = e; pricedEntries++; }
    });
    if (Object.keys(out).length) {
        vendorPrices[pn] = out;
        if (!knownPns.has(pn)) orphanPricePns.push(pn);
    }
});
const vendors = [...(S.DEFAULT_VENDORS || []), ...(S.customVendors || [])]
    .filter(v => v && v.name).map(v => ({ name: v.name, type: v.type || null }));
write('vendor-prices.json', { vendors, prices: vendorPrices });
report.crossCheck.push(`Vendor pricing: ${pricedEntries} distributor prices on ${Object.keys(vendorPrices).length} part numbers` +
    (orphanPricePns.length ? `; ${orphanPricePns.length} priced PNs are not keys: ${orphanPricePns.slice(0, 20).join(', ')}` : '') + '.');

const count = (arr, f) => arr.reduce((m, x) => (m[f(x)] = (m[f(x)] || 0) + 1, m), {});
const table = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, n]) => `| ${k} | ${n} |`).join('\n');
const list = arr => (arr.length ? arr.map(x => `- ${x}`).join('\n') : '- none');
const md = `# Key data extraction report

Extracted ${meta.extractedAt} from app ${meta.fromApp}${meta.backup ? ` + backup \`${meta.backup}\`` : ' (built-in catalog only, no backup)'}.

## Totals

| | |
|---|---|
| Keys | ${keys.length} (${keys.filter(k => k.source === 'custom').length} custom) |
| Vehicle rows (make/model/category/years) | ${vehicles.length} |
| Makes | ${new Set(vehicles.map(v => v.make)).size} |
| Keys with an FID | ${keys.filter(k => k.fid).length} |
| FIDs | ${Object.keys(fids).length} |
| Keys with Lishi | ${keys.filter(k => k.lishi.length).length} |
| Keys in stock | ${keys.filter(k => k.stock > 0).length} |
| Test key keyways | ${Object.keys(testKeys).length} |
| Lishi tools | ${Object.keys(lishiTools).length} |

### Keys by category

| Category | Keys |
|---|---|
${table(count(keys, k => k.category))}

### Keys by original key type

| Key type | Keys |
|---|---|
${table(count(keys, k => k.keyType || '(none)'))}

## Gaps worth filling

- Keys with no vehicles: ${keys.filter(k => !k.vehicles.length).map(k => k.pn).join(', ') || 'none'}
- Keys with no FCC ID: ${keys.filter(k => !k.fccIds.length).length}
- Keys with no chip recorded: ${keys.filter(k => !k.chip).length}
- Keys with no keyway: ${keys.filter(k => !k.keyway).length}
- Keyed-ignition keys with a keyway but no Lishi: ${keys.filter(k => k.category === 'Keyed Ignition' && k.keyway && !k.lishi.length).length}
- Keys with no FID: ${keys.filter(k => !k.fid).length}

## Cleanup decisions

### Spelling variants merged (most common spelling wins)

${Object.entries(report.spelling).map(([f, l]) => `**${f}**\n\n${list(l)}`).join('\n\n') || '- none'}

### Prices that were not numbers

${list(report.prices)}

### Year problems

${list(report.years)}

### Duplicate part numbers

${list(report.dupPns)}

## Cross-check against backup

${list(report.crossCheck)}
`;
fs.writeFileSync(path.join(outDir, 'REPORT.md'), md);
console.log(`${keys.length} keys, ${vehicles.length} vehicle rows, ${Object.keys(fids).length} FIDs -> ${path.relative(process.cwd(), outDir)}/`);
