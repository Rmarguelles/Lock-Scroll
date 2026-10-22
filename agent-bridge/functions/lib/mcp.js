// The MCP server an agent talks to. One is built per request (the bridge is
// stateless, which is what a Cloud Function wants), for one access link: its
// owner's snapshot and its rights.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as T from './tools.js';

export const SERVER_INFO = { name: 'lock-and-scroll', version: '1.0.0' };

const INSTRUCTIONS = [
  'Lock & Scroll is an automotive locksmith\'s key catalog and inventory: keys by part number (pn) with FCC IDs, FIDs, chips, keyways, buttons, vehicle applications, stock on hand and distributor prices, plus job and purchase history.',
  'The data is what the app had at its last sync (snapshot_info gives the time).',
  'Part numbers are matched without case, spaces or dashes. A distributor SKU such as "YCKG#0011" is a part number. Some keys answer to more than one SKU (otherPns).',
  'To find a key for a car use find_keys_for_vehicle; for anything else use search_keys, then get_key for the full record.',
  'A key from a distributor listing lists its versions (e.g. OEM Board OEM Shell, OEM Recased (No Logo), New Aftermarket) under prices[].options; option.key is the part number that version is filed under.',
  'Prices are in US dollars. Stock is units on hand.'
].join(' ');

const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// getData() loads the snapshot lazily, so a tools/list never reads Firestore.
export function buildServer({ getData, access }) {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  const withSnap = fn => async args => {
    const data = await getData();
    if (data.missing) {
      return json({ error: 'No data yet. Open Lock & Scroll, sign in and sync once; the app saves what agents can read after each sync.' });
    }
    if (data.error) return json({ error: data.error });
    return json(fn(data, args || {}));
  };

  server.registerTool('snapshot_info', {
    title: 'Data status',
    description: 'When the data was last synced from the app, how much there is (keys, stock, jobs, purchases), the vendors on file, and what this connection can do (every tool only reads).',
    inputSchema: {},
    annotations: READ
  }, withSnap(d => T.snapshotInfo(d.snap, d.meta, access)));

  server.registerTool('search_keys', {
    title: 'Search keys',
    description: 'Find keys by any mix of words: part number, distributor SKU, FCC ID, FID, OEM number, keyway, chip, key type, buttons, brand, or vehicle make/model. A 4-digit word is a model year. Every word must match. Returns short rows; use get_key for details.',
    inputSchema: {
      query: z.string().describe('e.g. "M3N-A2C931423", "YCKG#0011", "2019 F-150", "HU101 proximity 5 button"'),
      limit: z.number().int().min(1).max(100).optional().describe('Most rows to return (default 20).')
    },
    annotations: READ
  }, withSnap((d, a) => T.searchKeys(d.snap, a)));

  server.registerTool('get_key', {
    title: 'Get key',
    description: 'Everything on one key: FCC IDs, FIDs, chip, keyway, buttons, frequency, battery, emergency blade, Lishi tools, OEM and cross-reference numbers, stock, every vendor price and distributor version (with the stock of each version), vehicles, test keys for its keyway, notes. Accepts a part number, any of its SKUs, an old part number that was renamed, or an OEM or cross-reference number listed on the key.',
    inputSchema: { pn: z.string().describe('Part number, SKU or OEM number, e.g. "8701", "YCKG#1105" or "13530712".') },
    annotations: READ
  }, withSnap((d, a) => T.getKey(d.snap, a)));

  server.registerTool('find_keys_for_vehicle', {
    title: 'Keys for a vehicle',
    description: 'Keys that fit a vehicle, in-stock first, with price, chip, keyway, Lishi tool, emergency blade and test keys on hand. Model names match without spaces or dashes (F150 = F-150).',
    inputSchema: {
      make: z.string().describe('e.g. "Ford", "Chevy", "Toyota"'),
      model: z.string().describe('e.g. "F-150", "Grand Cherokee"'),
      year: z.number().int().min(1950).max(2100).optional().describe('Model year; leave out for every year.')
    },
    annotations: READ
  }, withSnap((d, a) => T.findKeysForVehicle(d.snap, a)));

  server.registerTool('get_inventory', {
    title: 'Inventory',
    description: 'Stock on hand. By default every key with stock above zero, most first, plus test key counts by keyway. Narrow with a search query, or list keys at or below a count to find what to reorder.',
    inputSchema: {
      query: z.string().optional().describe('Same words as search_keys, e.g. "Toyota" or "HU101".'),
      atOrBelow: z.number().int().min(0).optional().describe('Only keys with this many or fewer on hand (includes zero).'),
      includeZero: z.boolean().optional().describe('Include keys with none on hand.'),
      limit: z.number().int().min(1).max(1000).optional()
    },
    annotations: READ
  }, withSnap((d, a) => T.getInventory(d.snap, a)));

  server.registerTool('list_jobs', {
    title: 'Job history',
    description: 'Completed jobs, newest first: vehicle, job type, customer, VIN, work order or property reference, keys used from stock, test keys, equipment (cables/adapters), amount charged, notes. Also lists jobs in progress. Filter by dates, make, model or a word in the label, customer, VIN, reference, notes or equipment.',
    inputSchema: {
      since: z.string().optional().describe('ISO date, e.g. "2026-10-01".'),
      until: z.string().optional().describe('ISO date.'),
      make: z.string().optional(),
      model: z.string().optional(),
      query: z.string().optional().describe('Word in the label, customer, VIN, reference, notes, equipment, job type or a key part number.'),
      limit: z.number().int().min(1).max(500).optional().describe('Default 25.')
    },
    annotations: READ
  }, withSnap((d, a) => T.listJobs(d.snap, a)));

  server.registerTool('list_purchases', {
    title: 'Purchase history',
    description: 'Keys bought, newest first: date, vendor, part number, quantity, price each, total, invoice/order number. Check here before recording a receipt so the same order is not counted twice.',
    inputSchema: {
      since: z.string().optional().describe('ISO date.'),
      until: z.string().optional().describe('ISO date.'),
      vendor: z.string().optional(),
      invoice: z.string().optional().describe('Invoice or order number, matched exactly (ignoring case and punctuation).'),
      pn: z.string().optional().describe('Part number or SKU.'),
      limit: z.number().int().min(1).max(1000).optional().describe('Default 50.')
    },
    annotations: READ
  }, withSnap((d, a) => T.listPurchases(d.snap, a)));

  server.registerTool('list_tools', {
    title: 'Tools and equipment',
    description: 'Programmers, cables, adapters and other equipment on file, with category, status (owned/wanted) and the platforms they work with.',
    inputSchema: { query: z.string().optional().describe('Word in the name, part number, category or platform.') },
    annotations: READ
  }, withSnap((d, a) => T.listTools(d.snap, a)));

  return server;
}
