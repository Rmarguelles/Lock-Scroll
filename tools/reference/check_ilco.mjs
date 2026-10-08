// Audit Ilco extractor output (ilco_extract.py) before it becomes the vehicle
// reference. Rows are kept verbatim; this only parses them and flags the ones
// that look like extraction errors, so they can be checked against the book.
//
//   node tools/reference/check_ilco.mjs <dir-or-files...> [--json out.json]
//
// Row format: Make | Model | Years | Application | Code Series | Key Blank [| Prox]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRODUCTION = JSON.parse(fs.readFileSync(path.join(HERE, 'production-years.json'), 'utf8'));

const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const inputs = args.filter((a, i) => a !== '--json' && args[i - 1] !== '--json');
const files = inputs.flatMap(p => fs.statSync(p).isDirectory()
    ? fs.readdirSync(p).filter(f => f.endsWith('.txt')).sort().map(f => path.join(p, f)) : [p]);

// A model label that is really a trim, a body note or text from another column.
const NOT_A_MODEL = [
    [/\b[A-Z]\d{2,3}\/[a-z]{2}\d{2}\b/i, 'key blank text in the model column'],
    [/Models AND Years|\bDoor & \d Door\b|^\d Door/i, 'table note in the model column'],
    [/^(st|slt|sport|laramie|power|wagon|trx4|cabs|light duty|w\/ prox|\d{3,4}(\/hd)?(\/\d{3,4})*|cf\d+|srt( 10)?)$/i, 'trim or series fragment, not a model'],
];
const MECH_BLANK = /^(P?\d{3,4}[A-Z]{0,3}\/)?([A-Z]{1,3}\d{2,3}[A-Z]*|HU\d+[A-Z]*|TOY\d+[A-Z]*|FO\d+|SIP\d+|DW\d+\w*|MIT\d+|NI\d+|NSN\d+|HON\d+\w*|TR\d+|LXP\d+|X\d+)$/i;
const OEM_PN = /^(OEM#?)?(\d{7,}|\d{3}-[A-Z]?\d{4,}|\d{5}-[A-Z0-9]{3}-[A-Z0-9]{3}|\d{8}[A-Z]{2}|[A-Z0-9]{4,5}-[A-Z0-9]{5}|\d{5}-\d{5})$/i;

const norm = s => s.toLowerCase().replace(/\(.*?\)/g, '').replace(/\bw\/o?\b.*$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
function productionFor(make, model) {
    const table = PRODUCTION[make];
    if (!table) return null;
    const n = norm(model);
    // longest table name the label starts with ("Explorer Sport Trac" before "Explorer")
    const hit = Object.keys(table).sort((a, b) => b.length - a.length).find(k => n === norm(k) || n.startsWith(norm(k) + ' '));
    return hit ? { name: hit, spans: table[hit] } : null;
}

const rows = [];
for (const file of files) {
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (!line.trim()) return;
        const cells = line.split('|').map(c => c.trim());
        const [make, model, years, application, codeSeries, blankCell = '', proxCell = ''] = cells;
        const ym = (years || '').match(/^(\d{4})(?:-(\d{4}))?$/);
        const startYear = ym ? +ym[1] : null, endYear = ym ? +(ym[2] || ym[1]) : null;
        const blanks = blankCell.split('/').map(s => s.trim()).filter(Boolean);
        const prox = proxCell === 'Prox';
        const issues = [];

        for (const [re, why] of NOT_A_MODEL) if (re.test(model || '')) issues.push(why);
        if (!ym) issues.push(`unreadable years "${years}"`);
        if (!blankCell) issues.push('no key blank');
        if (/\[|\]/.test(line)) issues.push('stray bracket');
        if (blanks.some(b => /^-|-$|^\d{3}-$/.test(b) || /^[A-Z]{1,3}-?[A-Z]?\d{3,4}$/i.test(b) && blankCell.includes('-/'))) issues.push('OEM part number split across a line break');
        if (prox && blanks.length && blanks.every(b => MECH_BLANK.test(b))) issues.push('tagged Prox but every blank is a mechanical key');
        if (!prox && blanks.length && blanks.every(b => OEM_PN.test(b))) issues.push('only OEM fob part numbers but not tagged Prox');

        const prod = productionFor(make, model || '');
        if (prod && ym) {
            const fits = prod.spans.some(([a, b]) => startYear >= a - 1 && endYear <= (b ?? 2100) + 1);
            if (!fits) issues.push(`${prod.name} was built ${prod.spans.map(([a, b]) => `${a}-${b ?? 'now'}`).join(', ')}: row says ${years}`);
        }
        rows.push({ file: path.basename(file), line: i + 1, raw: line, make, model, years, startYear, endYear, application, codeSeries, blanks, prox, issues });
    });
}

const flagged = rows.filter(r => r.issues.length);
const byFile = {};
rows.forEach(r => { const f = (byFile[r.file] ||= { rows: 0, flagged: 0 }); f.rows++; if (r.issues.length) f.flagged++; });
console.log(`${rows.length} rows, ${flagged.length} flagged\n`);
Object.entries(byFile).forEach(([f, c]) => console.log(`${f.padEnd(16)} ${String(c.rows).padStart(4)} rows  ${String(c.flagged).padStart(3)} flagged`));
const reasons = {};
flagged.forEach(r => r.issues.forEach(i => { const k = i.replace(/:.*$/, '').replace(/ was built.*/, ' outside production years'); reasons[k] = (reasons[k] || 0) + 1; }));
console.log('\nBy reason:'); Object.entries(reasons).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${n}× ${k}`));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ rows, flagged: flagged.length }, null, 1));
