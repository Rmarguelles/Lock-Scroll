// End to end: a real MCP client talks to the bridge over HTTP, with Firestore
// replaced by an in-memory fake. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeHandler } from '../lib/http.js';
import { hashToken } from '../lib/store.js';
import { fakeFirestore } from './fake-firestore.js';

const TOKEN = 'lsa_' + 'a'.repeat(43);
const OTHER = 'lsa_' + 'b'.repeat(43);      // a user who never synced
const FORD = [['Bronco', 2021, 2024], ['F-150', 2018, 2023], ['Edge', 2017, 2022]]
  .map(([model, startYear, endYear]) => ({ make: 'Ford', model, startYear, endYear }));
const yckgOptions = [
  { label: 'New Aftermarket (No Logo)', sku: 'YCKG#NLAM', price: 19, key: 'YCKG#NLAM' },
  { label: 'OEM Recased (No Logo)', sku: 'YCKG#F-RC', price: 35, key: 'YCKG#B-RC' },
  { label: 'OEM Board OEM Shell', sku: 'YCKG#0011', price: 50, key: 'YCKG#0011' }
];
const SNAP = {
  schema: 1, app: 'v281', owner: 'me@example.com',
  keys: [
    { pn: '8701', fccIds: ['M3NWXF0B1'], keyType: 'Proximity', keyway: 'Y159', buttons: '3 Button: L, U, P (Lock, Unlock, Panic)', stock: 3,
      prices: [{ vendor: 'Keyless Ride', priceA: 84 }], vehicles: [{ make: 'Jeep', model: 'Wagoneer', startYear: 2022, endYear: 2023 }], source: 'builtin' },
    { pn: 'YCKG#0011', brand: 'OEM Board OEM Shell', fccIds: ['M3N-A2C931423'], keyType: 'Proximity', keyway: 'HU101', stock: 2,
      prices: [{ vendor: 'Your Car Key Guys', sku: 'YCKG#0011', options: yckgOptions }], vehicles: FORD, source: 'custom', importedFrom: 'Your Car Key Guys' },
    { pn: 'YCKG#B-RC', brand: 'OEM Recased (No Logo)', fccIds: ['M3N-A2C931423'], keyType: 'Proximity', keyway: 'HU101', stock: 1, otherPns: ['YCKG#F-RC'],
      prices: [{ vendor: 'Your Car Key Guys', sku: 'YCKG#B-RC', options: yckgOptions }], vehicles: FORD, source: 'custom' },
    { pn: 'YCKG#1105', brand: 'OEM Board OEM Shell', fccIds: ['M3N-A2C931423'], keyType: 'Proximity', stock: 0,
      vehicles: [FORD[0]], source: 'custom' },
    { pn: '5925', keyType: 'Transponder', keyway: 'H75', stock: 0, vehicles: [{ make: 'Chevrolet', model: 'Silverado 1500', startYear: 2007, endYear: 2013 }], source: 'builtin' },
    { pn: 'H128', keyType: 'Chip Key', keyway: 'HU101', stock: 0, vehicles: [{ make: 'Ford', model: 'F-Series/F150/F250 Light Duty Pickup', startYear: 2015, endYear: 2020 }], source: 'builtin' }
  ],
  renamedPns: { 'OLD-5925': '5925' },
  testKeys: [{ keyway: 'HU101', qty: 12 }],
  tools: [{ id: 't1', name: 'Autel IM608', category: 'Programmers', status: 'owned', platforms: ['Autel'] }],
  activeJobs: [],
  jobs: [
    { id: 'j2', completedAt: '2026-10-20T15:00:00Z', make: 'Ford', model: 'F-150', startYear: 2018, endYear: 2023, jobType: 'AKL', keysUsed: [{ pn: 'YCKG#0011', qty: 1 }], equipment: 'FDRS', charge: 300 },
    { id: 'j1', completedAt: '2026-09-02T15:00:00Z', make: 'Jeep', model: 'Wagoneer', startYear: 2022, endYear: 2023, jobType: 'Add key', keysUsed: [{ pn: '8701', qty: 1 }], charge: 180 }
  ],
  purchases: [{ id: 'p1', date: '2026-10-18', vendor: 'Your Car Key Guys', pn: 'YCKG#0011', qty: 2, priceEach: 50, total: 100, invoice: 'INV-1001' }],
  vendors: ['Keyless Ride', 'Your Car Key Guys']
};

function snapshotDocs(uid, snap, { parts = 2, dropPart = null } = {}) {
  const text = JSON.stringify(snap);
  const size = Math.ceil(text.length / parts);
  const out = {};
  for (let i = 0; i < parts; i++) {
    if (i === dropPart) continue;
    out['users/' + uid + '/agent/' + (i === 0 ? 'view' : 'view__' + (i + 1))] =
      { parts, builtAt: '2026-10-22T01:00:00.000Z', schema: 1, json: text.slice(i * size, (i + 1) * size) };
  }
  return out;
}

let server, base, db;
before(async () => {
  db = fakeFirestore({
    ['agentTokens/' + hashToken(TOKEN)]: { uid: 'u1', name: 'Grok', canWrite: false, createdAt: '2026-10-22T00:00:00Z' },
    ['agentTokens/' + hashToken(OTHER)]: { uid: 'u2', name: 'Claude', canWrite: true, createdAt: '2026-10-22T00:00:00Z' },
    ...snapshotDocs('u1', SNAP)
  });
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(makeHandler(() => db));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => server && server.close());

async function connect(url, opts) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), opts));
  return client;
}
const call = async (client, name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

test('lists the read tools, all marked read-only', async () => {
  const c = await connect(base + '/mcp/' + TOKEN);
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(),
    ['find_keys_for_vehicle', 'get_inventory', 'get_key', 'list_jobs', 'list_purchases', 'list_tools', 'search_keys', 'snapshot_info']);
  assert.ok(tools.every(t => t.annotations && t.annotations.readOnlyHint === true));
  assert.match(c.getInstructions(), /locksmith/);
  await c.close();
});

test('snapshot_info: time, counts, access', async () => {
  const c = await connect(base + '/mcp/' + TOKEN);
  const r = await call(c, 'snapshot_info');
  assert.equal(r.dataAsOf, '2026-10-22T01:00:00.000Z');
  assert.equal(r.counts.keys, 6);
  assert.equal(r.counts.unitsInStock, 6);
  assert.equal(r.access, 'read only');
  await c.close();
});

test('search_keys: FCC ID, year + model, SKU on another key, renamed part number', async () => {
  const c = await connect(base + '/mcp/' + TOKEN);
  const fcc = await call(c, 'search_keys', { query: 'm3n a2c931423' });
  assert.deepEqual(fcc.keys.map(k => k.pn).sort(), ['YCKG#0011', 'YCKG#1105', 'YCKG#B-RC']);
  const car = await call(c, 'search_keys', { query: '2019 F150' });
  assert.deepEqual(car.keys.map(k => k.pn).sort(), ['H128', 'YCKG#0011', 'YCKG#B-RC']);
  const sku = await call(c, 'search_keys', { query: 'YCKG#F-RC' });
  assert.equal(sku.keys[0].pn, 'YCKG#B-RC');
  const old = await call(c, 'search_keys', { query: 'OLD-5925' });
  assert.equal(old.keys[0].pn, '5925');
  assert.match(old.renamed, /OLD-5925 was renamed to 5925/);
  const none = await call(c, 'search_keys', { query: '1999 F-150' });
  assert.equal(none.total, 0);
  await c.close();
});

test('get_key: by second SKU, versions carry their stock, test keys for the keyway', async () => {
  const c = await connect(base + '/mcp/' + TOKEN);
  const k = await call(c, 'get_key', { pn: 'yckg f-rc' });
  assert.equal(k.pn, 'YCKG#B-RC');
  const opts = k.prices[0].options;
  assert.equal(opts.find(o => o.sku === 'YCKG#F-RC').thisKey, true);
  assert.equal(opts.find(o => o.sku === 'YCKG#0011').stock, 2);
  assert.deepEqual(k.testKeys, [{ keyway: 'HU101', qty: 12 }]);
  assert.ok(k.vehicles.includes('Ford F-150 2018-2023'));
  const missing = await call(c, 'get_key', { pn: 'NOPE' });
  assert.match(missing.error, /No key/);
  await c.close();
});

test('find_keys_for_vehicle: in-stock first, aliases and loose model names', async () => {
  const c = await connect(base + '/mcp/' + TOKEN);
  const r = await call(c, 'find_keys_for_vehicle', { make: 'ford', model: 'f150', year: 2019 });
  assert.deepEqual(r.keys.map(k => k.pn), ['YCKG#0011', 'YCKG#B-RC', 'H128']);
  assert.equal(r.note, undefined);   // "F-Series/F150/..." is an exact F150
  assert.deepEqual(r.keys[0].testKeys, ['HU101: 12']);
  const bronco = await call(c, 'find_keys_for_vehicle', { make: 'Ford', model: 'Bronco', year: 2022 });
  assert.equal(bronco.keys[bronco.keys.length - 1].pn, 'YCKG#1105');   // none in stock: last
  const chevy = await call(c, 'find_keys_for_vehicle', { make: 'Chevy', model: 'Silverado', year: 2010 });
  assert.equal(chevy.keys[0].pn, '5925');
  assert.equal(chevy.note, undefined);   // "Silverado" starts "Silverado 1500"
  const loose = await call(c, 'find_keys_for_vehicle', { make: 'Chevy', model: '1500', year: 2010 });
  assert.match(loose.note, /close model names/);
  await c.close();
});

test('get_inventory: on hand by default, reorder list with atOrBelow', async () => {
  const c = await connect(base + '/mcp/' + TOKEN);
  const r = await call(c, 'get_inventory');
  assert.equal(r.total, 3);
  assert.equal(r.units, 6);
  assert.equal(r.keys[0].pn, '8701');
  const low = await call(c, 'get_inventory', { atOrBelow: 0 });
  assert.deepEqual(low.keys.map(k => k.pn).sort(), ['5925', 'H128', 'YCKG#1105']);
  await c.close();
});

test('list_jobs and list_purchases: filters and totals', async () => {
  const c = await connect(base + '/mcp/' + TOKEN);
  const jobs = await call(c, 'list_jobs', { since: '2026-10-01' });
  assert.equal(jobs.total, 1);
  assert.equal(jobs.charged, 300);
  assert.equal(jobs.jobs[0].equipment, 'FDRS');
  const byKey = await call(c, 'list_jobs', { query: '8701' });
  assert.equal(byKey.jobs[0].id, 'j1');
  const inv = await call(c, 'list_purchases', { invoice: 'inv 1001' });
  assert.equal(inv.total, 1);
  const byPn = await call(c, 'list_purchases', { pn: 'yckg0011' });
  assert.equal(byPn.spent, 100);
  await c.close();
});

test('bearer header works as well as the link', async () => {
  const c = await connect(base + '/mcp', { requestInit: { headers: { Authorization: 'Bearer ' + TOKEN } } });
  assert.equal((await call(c, 'snapshot_info')).counts.keys, 6);
  await c.close();
});

test('a bad or revoked link is refused', async () => {
  await assert.rejects(connect(base + '/mcp/lsa_' + 'z'.repeat(43)));
  await assert.rejects(connect(base + '/mcp/not-a-token'));
  const res = await fetch(base + '/mcp/lsa_' + 'z'.repeat(43), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error.message, /revoked/);
});

test('a user who never synced gets told how to fix it', async () => {
  const c = await connect(base + '/mcp/' + OTHER);
  const r = await call(c, 'search_keys', { query: '8701' });
  assert.match(r.error, /sync once/);
  await c.close();
});

test('a snapshot missing a part is not used', async () => {
  const t = 'lsa_' + 'c'.repeat(43);
  await db.collection('agentTokens').doc(hashToken(t)).set({ uid: 'u3', name: 'X', canWrite: false });
  for (const [p, d] of Object.entries(snapshotDocs('u3', SNAP, { parts: 3, dropPart: 1 }))) db.docs.set(p, d);
  const c = await connect(base + '/mcp/' + t);
  assert.match((await call(c, 'snapshot_info')).error, /incomplete/);
  await c.close();
});

test('use is recorded on the link for the app to show', async () => {
  const doc = db.docs.get('agentTokens/' + hashToken(TOKEN));
  assert.ok(doc.lastUsedAt && Date.now() - Date.parse(doc.lastUsedAt) < 60000);
});

test('health check and unknown paths', async () => {
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/nope')).status, 404);
  assert.equal((await fetch(base + '/mcp/' + TOKEN)).status, 405);
});
