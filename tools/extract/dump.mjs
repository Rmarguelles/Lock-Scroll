// Stage 1 of the key-data extraction: run the existing app headless and dump
// its fully merged state, so every override, rename, supersession and
// migration the app applies at startup is honored without re-implementing it.
//
//   node tools/extract/dump.mjs [backup.json] [out.json]
//
// With no backup, dumps the built-in catalog only. With a backup (Settings ->
// Export, LockAndScroll_Backup_*.json), the app is first started on an empty
// profile (one-time migrations run and mark themselves done, as on a new
// device), then the backup's stores are written to IndexedDB and the app is
// reloaded so init() merges them exactly as it would on that device.

import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
function loadPlaywright() {
    for (const p of ['playwright', '/opt/node-tools/node_modules/playwright']) {
        try { return require(p); } catch (e) { /* try next */ }
    }
    throw new Error('Playwright not found. Install it with: npm i -g playwright');
}
const { chromium } = loadPlaywright();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const backupPath = process.argv[2] && process.argv[2] !== '-' ? path.resolve(process.argv[2]) : null;
const outPath = path.resolve(process.argv[3] || path.join(ROOT, 'data/raw/app-state.json'));

// Backup field -> IndexedDB key, where they differ. 'records' is the exporting
// device's already-merged DB; it is kept only to cross-check the result.
const BACKUP_TO_IDB = { stock: 'stock', lishi: 'lishi', lishiVehicle: 'lishiVehicle' };
const BACKUP_SKIP = new Set(['version', 'exportDate', 'records']);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serve() {
    const server = http.createServer((req, res) => {
        const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
        if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
            const idx = path.join(p, 'index.html');
            if (fs.existsSync(idx)) { res.writeHead(200, { 'content-type': 'text/html' }); return fs.createReadStream(idx).pipe(res); }
            res.writeHead(404); return res.end();
        }
        res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
        fs.createReadStream(p).pipe(res);
    });
    return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

async function waitForInit(page) {
    // init() fills #totalCount once the DB is merged and filters are built
    await page.waitForFunction(() => {
        const el = document.getElementById('totalCount');
        return el && /^\d+$/.test(el.textContent.trim()) && typeof DB !== 'undefined' && DB.length > 0;
    }, null, { timeout: 60000 });
    await page.waitForTimeout(1500); // let trailing async migrations settle
}

const server = await serve();
const url = `http://127.0.0.1:${server.address().port}/index.html`;
const browser = await chromium.launch({ executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined });
const context = await browser.newContext({ serviceWorkers: 'block' });
const page = await context.newPage();
page.on('dialog', d => d.dismiss());

try {
    await page.goto(url);
    await waitForInit(page);

    let backupRecords = null, backupFids = null;
    if (backupPath) {
        const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
        backupRecords = Array.isArray(backup.records) ? backup.records : null;
        backupFids = backup.fidAssignments || null;
        const stores = {};
        for (const [k, v] of Object.entries(backup)) {
            if (BACKUP_SKIP.has(k) || v === null || v === undefined) continue;
            stores[BACKUP_TO_IDB[k] || k] = v;
        }
        const written = await page.evaluate(async stores => {
            for (const [k, v] of Object.entries(stores)) await saveToIndexedDB(k, v);
            return Object.keys(stores);
        }, stores);
        console.log(`Seeded ${written.length} stores from backup: ${written.join(', ')}`);
        await page.reload();
        await waitForInit(page);
    }

    const state = await page.evaluate(() => {
        // Snapshot records now: getUniqueVehicles() below writes a custom
        // vehicle's keyway/chip/frequency/... onto real DB keys that lack them.
        const keys = DB.map(k => {
            const tkKeyways = typeof getTestKeyKeywaysForKey === 'function' ? getTestKeyKeywaysForKey(k) : [];
            return {
                record: structuredClone(k),
                computed: {
                    category: normalizeKeyType(k.keyType),
                    fccIds: getKeyFccIds(k),
                    fids: getKeyFids(k),
                    lishiTools: getKeyLishiTools(k),
                    stock: stockData[k.pn] || 0,
                    supersededBy: resolvePnSupersession(k.pn),
                    testKeys: tkKeyways.map(kw => ({ keyway: kw, poolQty: getTestKeyPoolQty(kw) }))
                }
            };
        });
        const vehicles = Object.values(getUniqueVehicles()).map(v => ({
            ...v,
            keys: v.keys.map(k => k.pn),
            keyways: [...(v.keyways || [])],
            fccids: [...(v.fccids || [])],
            chips: [...(v.chips || [])],
            frequencies: [...(v.frequencies || [])],
            groupKey: `${v.make}|${v.model}|${v.startYear}|${v.endYear}`
        }));
        const testKeyPools = {};
        Object.keys(testKeyInventory).forEach(kw => {
            if (isLiveTestKeyEntry(testKeyInventory[kw])) testKeyPools[kw] = getTestKeyPoolQty(kw);
        });
        return {
            appVersion: (document.querySelector('h1 small') || {}).textContent || null,
            keys,
            vehicles,
            testKeyPools,
            stores: {
                stockData, lishiData, lishiVehicleData, lishiInventory, MASTER_LISHI_TOOLS,
                testKeyInventory, fidAssignments, fidMerges, fidPrefixes,
                pnSupersessions, discontinuedPns, customVehicles, vehicleYearNotes,
                vehicleYearRanges, keyRelationships, fccRelationships, customKeyways,
                ilcoRef // reference year ranges: a candidate source for the vehicle gate
            }
        };
    });

    state.extractedAt = new Date().toISOString();
    state.source = backupPath ? { backup: path.basename(backupPath) } : { backup: null };
    if (backupRecords) state.backupRecords = backupRecords;
    if (backupFids) state.backupFidAssignments = backupFids;

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(state, null, 1));
    console.log(`App ${state.appVersion}: ${state.keys.length} keys, ${state.vehicles.length} vehicle rows -> ${path.relative(process.cwd(), outPath)}`);
} finally {
    await browser.close();
    server.close();
}
