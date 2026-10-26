// The lookups agents can run, as plain functions over the snapshot the app
// publishes (users/<uid>/agent/view). Nothing here touches Firestore, so it is
// tested without one. Results are kept small: an agent pays for every token.

// Part numbers compared without case, spaces or dashes ("285E3-6FL2B" is
// "285E36FL2B"), the same way the app compares them.
export function pnKey(pn) {
  return String(pn == null ? '' : pn).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Words compared the same way, so "F-150" finds "F150" and "M3N-A2C931423"
// finds "M3NA2C931423".
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

const MAKE_ALIASES = {
  chevy: 'chevrolet', vw: 'volkswagen', mercedes: 'mercedesbenz', benz: 'mercedesbenz',
  landrover: 'landrover', range: 'landrover', alfa: 'alfaromeo', mini: 'mini'
};
const makeKey = m => { const n = norm(m); return MAKE_ALIASES[n] || n; };

const endYear = v => v.endYear || v.startYear;

// A short line per vehicle range, e.g. "Ford F-150 2018-2023".
export function vehicleLine(v) {
  const y = v.startYear === endYear(v) ? String(v.startYear) : v.startYear + '-' + endYear(v);
  return v.make + ' ' + v.model + ' ' + y;
}

// What a key costs and from whom: its own option when it is one version of a
// distributor listing, else the first price on file.
export function pricePoint(key) {
  for (const p of key.prices || []) {
    const own = (p.options || []).find(o => o.key === key.pn && o.price != null);
    if (own) return { vendor: p.vendor, price: own.price, sku: own.sku || null };
    const first = p.priceA != null ? p.priceA : (p.priceB != null ? p.priceB : ((p.options || [])[0] || {}).price);
    if (first != null) return { vendor: p.vendor, price: first };
  }
  return null;
}

// The key a part number, distributor SKU or old (renamed) part number refers to.
export function findKey(snap, pn) {
  const want = pnKey(pn);
  if (!want) return null;
  const direct = snap.keys.find(k => pnKey(k.pn) === want) ||
    snap.keys.find(k => (k.otherPns || []).some(p => pnKey(p) === want));
  if (direct) return { key: direct };
  const renamed = Object.keys(snap.renamedPns || {}).find(o => pnKey(o) === want);
  if (renamed) {
    let to = snap.renamedPns[renamed];
    const seen = new Set([pnKey(renamed)]);
    while (to && snap.renamedPns[to] && !seen.has(pnKey(to))) { seen.add(pnKey(to)); to = snap.renamedPns[to]; }
    const key = snap.keys.find(k => pnKey(k.pn) === pnKey(to));
    if (key) return { key, renamedFrom: renamed };
  }
  return null;
}

// One line of a list: enough to pick a key and ask for more with get_key.
export function keyRow(key) {
  const pp = pricePoint(key);
  const vehicles = key.vehicles || [];
  return compact({
    pn: key.pn,
    brand: key.brand,
    logo: key.logo,
    keyType: key.keyType,
    buttons: key.buttons ? key.buttons.replace(/\s*\(.*$/, '') : null,
    fccIds: key.fccIds,
    fids: key.fids,
    keyway: key.keyway,
    stock: key.stock || 0,
    price: pp ? pp.price : null,
    priceFrom: pp ? pp.vendor : null,
    discontinued: key.discontinued ? (key.discontinued.replacedBy ? 'order ' + key.discontinued.replacedBy + ' instead' : 'yes') : null,
    fits: vehicles.slice(0, 3).map(vehicleLine).concat(vehicles.length > 3 ? ['+' + (vehicles.length - 3) + ' more'] : [])
  });
}

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
}

// ---- snapshot_info --------------------------------------------------------
export function snapshotInfo(snap, meta, access) {
  const inStock = snap.keys.filter(k => (k.stock || 0) > 0);
  return {
    dataAsOf: meta.builtAt,
    note: 'This is the data as of the last time the Lock & Scroll app synced. Changes made since then on a device that has not synced are not here.',
    app: snap.app,
    owner: snap.owner,
    access: access.canWrite ? 'read + write' : 'read only',
    counts: {
      keys: snap.keys.length,
      customKeys: snap.keys.filter(k => k.source === 'custom').length,
      keysInStock: inStock.length,
      unitsInStock: inStock.reduce((n, k) => n + (k.stock || 0), 0),
      jobs: (snap.jobs || []).length,
      activeJobs: (snap.activeJobs || []).length,
      purchases: (snap.purchases || []).length,
      tools: (snap.tools || []).length,
      testKeyways: (snap.testKeys || []).length
    },
    vendors: snap.vendors || []
  };
}

// ---- search_keys ----------------------------------------------------------
// Every word must match something on the key: part number, other part
// numbers and SKUs, FCC ID, FID, OEM or cross-reference number, keyway, chip,
// key type, buttons, frequency, brand, or a vehicle make/model. A four-digit
// word is a year and must fall inside one of the key's vehicle ranges.
export function searchKeys(snap, { query, limit = 20 }) {
  const words = String(query || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { error: 'Give a part number, FCC ID, vehicle or other words to search for.' };
  const years = words.filter(w => /^(19|20)\d\d$/.test(w)).map(Number);
  const terms = words.filter(w => !/^(19|20)\d\d$/.test(w)).map(norm).filter(Boolean);
  const renamed = findKey(snap, query);

  const scored = [];
  for (const k of snap.keys) {
    const ids = [k.pn, ...(k.otherPns || []), ...(k.fccIds || []), ...(k.fids || []), ...(k.oem || []),
      ...(k.crossRefs || []).map(c => c.pn), k.ilco].filter(Boolean).map(norm);
    const text = [k.keyway, k.chip, k.keyType, k.buttons, k.frequency, k.brand, k.logo, k.battery, k.emergencyPN,
      ...(k.vehicles || []).map(v => v.make + ' ' + v.model)].filter(Boolean).map(norm);
    const vehicles = k.vehicles || [];
    // The whole query naming this key (its part number, a SKU, or an old
    // part number it was renamed from) is the best match there is.
    if (renamed && renamed.key === k) { scored.push([1000, k]); continue; }
    if (years.length && !years.every(y => vehicles.some(v => v.startYear <= y && endYear(v) >= y))) continue;
    let score = 0;
    let all = true;
    for (const t of terms) {
      if (ids.some(i => i === t)) score += 100;
      else if (ids.some(i => i.includes(t))) score += 30;
      else if (text.some(x => x === t)) score += 20;
      else if (text.some(x => x.includes(t))) score += 10;
      else if (vehicles.some(v => (norm(v.make) + norm(v.model)).includes(t))) score += 10;
      else { all = false; break; }
    }
    if (!all) continue;
    if ((k.stock || 0) > 0) score += 1;
    scored.push([score, k]);
  }
  scored.sort((a, b) => b[0] - a[0] || String(a[1].pn).localeCompare(String(b[1].pn)));
  const max = Math.max(1, Math.min(Number(limit) || 20, 100));
  const out = {
    total: scored.length,
    shown: Math.min(scored.length, max),
    keys: scored.slice(0, max).map(([, k]) => keyRow(k))
  };
  if (renamed && renamed.renamedFrom) out.renamed = renamed.renamedFrom + ' was renamed to ' + renamed.key.pn;
  return out;
}

// ---- get_key --------------------------------------------------------------
export function getKey(snap, { pn }) {
  const hit = findKey(snap, pn);
  if (!hit) return { error: 'No key with part number, SKU or old part number "' + pn + '". Try search_keys.' };
  const k = hit.key;
  // Each distributor version names the key it is filed under; add that key's stock.
  const prices = (k.prices || []).map(p => compact({
    ...p,
    options: (p.options || []).map(o => {
      const other = o.key && o.key !== k.pn ? snap.keys.find(x => x.pn === o.key) : null;
      return compact({ ...o, thisKey: o.key === k.pn ? true : null, stock: other ? (other.stock || 0) : null });
    })
  }));
  const testKeys = k.keyway ? (snap.testKeys || []).filter(t => norm(t.keyway) === norm(k.keyway)) : [];
  return compact({
    renamedFrom: hit.renamedFrom || null,
    ...k,
    prices,
    vehicles: (k.vehicles || []).map(vehicleLine),
    testKeys
  });
}

// ---- find_keys_for_vehicle ------------------------------------------------
export function findKeysForVehicle(snap, { make, model, year }) {
  const mk = makeKey(make);
  const md = norm(model);
  const y = year ? Number(year) : null;
  if (!mk || !md) return { error: 'Give a make and a model.' };
  // The catalog names some rows "F-Series/F150/F250 Light Duty Pickup": each
  // name between slashes is a model of its own, and "Silverado" is the start
  // of "Silverado 1500".
  const sameModel = m => norm(m) === md ||
    String(m || '').split('/').map(norm).some(p => p === md || (md.length >= 3 && p.startsWith(md)));
  const fits = (v, loose) => makeKey(v.make) === mk &&
    (loose ? (norm(v.model).includes(md) || md.includes(norm(v.model))) : sameModel(v.model)) &&
    (!y || (v.startYear <= y && endYear(v) >= y));
  let loose = false;
  let hits = snap.keys.filter(k => (k.vehicles || []).some(v => fits(v, false)));
  if (!hits.length) { loose = true; hits = snap.keys.filter(k => (k.vehicles || []).some(v => fits(v, true))); }
  hits.sort((a, b) => ((b.stock || 0) > 0) - ((a.stock || 0) > 0) || String(a.keyType || '').localeCompare(String(b.keyType || '')));
  return compact({
    vehicle: [make, model, y].filter(Boolean).join(' '),
    note: loose ? 'No exact model match; these are close model names. Check the ranges.' : null,
    total: hits.length,
    keys: hits.map(k => compact({
      ...keyRow(k),
      chip: k.chip,
      frequency: k.frequency,
      emergencyPN: k.emergencyPN,
      lishi: (k.lishi || []).map(t => t.tool + (t.direction ? ' ' + t.direction : '')),
      testKeys: k.keyway ? (snap.testKeys || []).filter(t => norm(t.keyway) === norm(k.keyway)).map(t => t.keyway + ': ' + t.qty) : null,
      fits: (k.vehicles || []).filter(v => fits(v, loose)).map(vehicleLine)
    }))
  });
}

// ---- get_inventory --------------------------------------------------------
export function getInventory(snap, { query, includeZero = false, atOrBelow, limit = 200 }) {
  let keys = snap.keys;
  if (query) {
    const found = searchKeys(snap, { query, limit: 1000 });
    const pns = new Set((found.keys || []).map(r => r.pn));
    keys = keys.filter(k => pns.has(k.pn));
  }
  if (atOrBelow != null) keys = keys.filter(k => (k.stock || 0) <= Number(atOrBelow));
  else if (!includeZero) keys = keys.filter(k => (k.stock || 0) > 0);
  keys = keys.slice().sort((a, b) => (b.stock || 0) - (a.stock || 0) || String(a.pn).localeCompare(String(b.pn)));
  const max = Math.max(1, Math.min(Number(limit) || 200, 1000));
  return {
    total: keys.length,
    units: keys.reduce((n, k) => n + (k.stock || 0), 0),
    keys: keys.slice(0, max).map(k => compact({
      pn: k.pn, brand: k.brand, stock: k.stock || 0, keyType: k.keyType,
      fccIds: k.fccIds, fits: (k.vehicles || []).slice(0, 2).map(vehicleLine)
    })),
    testKeys: query ? undefined : snap.testKeys
  };
}

// ---- list_jobs ------------------------------------------------------------
export function listJobs(snap, { since, until, make, model, query, limit = 25 }) {
  let jobs = snap.jobs || [];
  const from = since ? Date.parse(since) : null;
  const to = until ? Date.parse(until) : null;
  if (from) jobs = jobs.filter(j => Date.parse(j.completedAt) >= from);
  if (to) jobs = jobs.filter(j => Date.parse(j.completedAt) <= to);
  if (make) jobs = jobs.filter(j => makeKey(j.make) === makeKey(make));
  if (model) jobs = jobs.filter(j => norm(j.model).includes(norm(model)));
  if (query) {
    const t = norm(query);
    jobs = jobs.filter(j => [j.label, j.notes, j.equipment, j.jobType, ...(j.keysUsed || []).map(u => u.pn)].some(x => norm(x).includes(t)));
  }
  const max = Math.max(1, Math.min(Number(limit) || 25, 500));
  return {
    total: jobs.length,
    charged: Math.round(jobs.reduce((n, j) => n + (j.charge || 0), 0) * 100) / 100,
    jobs: jobs.slice(0, max),
    activeJobs: snap.activeJobs || []
  };
}

// ---- list_purchases -------------------------------------------------------
export function listPurchases(snap, { since, until, vendor, invoice, pn, limit = 50 }) {
  let rows = snap.purchases || [];
  const from = since ? Date.parse(since) : null;
  const to = until ? Date.parse(until) : null;
  if (from) rows = rows.filter(p => Date.parse(p.date) >= from);
  if (to) rows = rows.filter(p => Date.parse(p.date) <= to);
  if (vendor) rows = rows.filter(p => norm(p.vendor).includes(norm(vendor)));
  if (invoice) rows = rows.filter(p => norm(p.invoice) === norm(invoice));
  if (pn) {
    const hit = findKey(snap, pn);
    const want = new Set([pnKey(pn)].concat(hit ? [pnKey(hit.key.pn), ...(hit.key.otherPns || []).map(pnKey)] : []));
    rows = rows.filter(p => want.has(pnKey(p.pn)));
  }
  const max = Math.max(1, Math.min(Number(limit) || 50, 1000));
  return {
    total: rows.length,
    spent: Math.round(rows.reduce((n, p) => n + (p.total || 0), 0) * 100) / 100,
    purchases: rows.slice(0, max)
  };
}

// ---- list_tools -----------------------------------------------------------
export function listTools(snap, { query }) {
  let tools = snap.tools || [];
  if (query) {
    const t = norm(query);
    tools = tools.filter(x => [x.name, x.partNumber, x.category, ...(x.platforms || [])].some(v => norm(v).includes(t)));
  }
  return { total: tools.length, tools };
}
