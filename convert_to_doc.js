'use strict';
// convert_to_doc.js — Converts a full_analysis.json file to a human-readable Markdown document.
// Usage:
//   node convert_to_doc.js                          # full_analysis.json → full_analysis.md
//   node convert_to_doc.js my_analysis.json         # custom input → full_analysis.md
//   node convert_to_doc.js input.json output.md     # fully custom paths

const fs = require('fs');
const path = require('path');

// ─── CLI args ────────────────────────────────────────────────────────────────
const inputPath  = process.argv[2] || 'full_analysis.json';
const outputPath = process.argv[3] || 'full_analysis.md';

const MAX_DEPTH = 10;           // circular / deep nesting protection
const BLOCKQUOTE_THRESHOLD = 200; // chars above which plain text → blockquote

// ─── Markdown helpers ────────────────────────────────────────────────────────

/** Capitalize first letter and replace underscores/hyphens with spaces. */
function prettyKey(key) {
    return String(key).replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Return true when every element of the array is an object with identical keys
 * AND all cell values are primitives (no nested objects/arrays).
 */
function isTableArray(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return false;
    const first = arr[0];
    if (first === null || typeof first !== 'object' || Array.isArray(first)) return false;
    const keys = Object.keys(first);
    if (keys.length === 0) return false;
    const sortedKeys = JSON.stringify(keys.slice().sort());
    return arr.every(item => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
        if (JSON.stringify(Object.keys(item).sort()) !== sortedKeys) return false;
        // Only use table rendering when all cell values are primitive
        return keys.every(k => {
            const v = item[k];
            return v === null || typeof v !== 'object';
        });
    });
}

/** Render a scalar (string, number, boolean, null, date-like string) as Markdown text. */
function renderScalar(value) {
    if (value === null || value === undefined) return '_null_';
    if (typeof value === 'boolean') return value ? '`true`' : '`false`';
    if (typeof value === 'number') return String(value);
    const str = String(value);
    return str;
}

/** Render an array of objects as a Markdown table. */
function renderTable(arr, depth) {
    const keys = Object.keys(arr[0]);
    const header = '| ' + keys.map(prettyKey).join(' | ') + ' |';
    const separator = '| ' + keys.map(() => '---').join(' | ') + ' |';
    const rows = arr.map(item => {
        const cells = keys.map(k => {
            const v = item[k];
            if (v === null || v === undefined) return '_null_';
            if (typeof v === 'object') return '`' + JSON.stringify(v).substring(0, 60) + '`';
            const s = renderScalar(v);
            // keep table cells compact
            return s.length > 80 ? s.substring(0, 77) + '…' : s;
        });
        return '| ' + cells.join(' | ') + ' |';
    });
    return [header, separator, ...rows].join('\n');
}

/**
 * Recursively convert a value to Markdown lines.
 * @param {*} value       – the value to render
 * @param {number} depth  – current nesting depth (0 = top-level section body)
 * @param {number} headingBase – the '#' level to use for object keys at this depth
 * @returns {string[]} array of Markdown lines
 */
function valueToLines(value, depth, headingBase) {
    if (depth > MAX_DEPTH) {
        return ['> _(max depth reached — value truncated)_'];
    }

    // null / undefined
    if (value === null || value === undefined) {
        return ['_null_'];
    }

    // Primitive scalar
    if (typeof value !== 'object') {
        const str = renderScalar(value);
        if (typeof value === 'string' && str.length > BLOCKQUOTE_THRESHOLD) {
            // wrap long text in a blockquote
            return ['> ' + str.replace(/\n/g, '\n> ')];
        }
        return [str];
    }

    // Array
    if (Array.isArray(value)) {
        if (value.length === 0) return ['_empty_'];

        // Table when every element is an object with matching keys
        if (isTableArray(value)) {
            return [renderTable(value, depth), ''];
        }

        // Array of scalars → bullet list
        if (value.every(item => item === null || typeof item !== 'object')) {
            return value.map(item => `- ${renderScalar(item)}`);
        }

        // Mixed / array of objects with varying shapes → numbered list with nested content
        const lines = [];
        value.forEach((item, idx) => {
            if (item === null || typeof item !== 'object') {
                lines.push(`- ${renderScalar(item)}`);
                return;
            }
            // Object item in array
            const itemKeys = Object.keys(item);
            // If item has a natural "name" / "label" / "title" / "week" / "month" key use it as label
            const labelKey = ['name', 'label', 'title', 'week', 'month', 'id'].find(k => itemKeys.includes(k));
            const label = labelKey ? ` **${renderScalar(item[labelKey])}**` : ` Item ${idx + 1}`;
            lines.push(`-${label}`);
            const subLines = objectToLines(item, depth + 1, headingBase + 1, labelKey ? [labelKey] : []);
            subLines.forEach(l => lines.push('  ' + l));
        });
        return lines;
    }

    // Plain object → key/value rendering
    return objectToLines(value, depth, headingBase, []);
}

/**
 * Render a plain object's key/value pairs to Markdown lines.
 * @param {Object} obj
 * @param {number} depth
 * @param {number} headingBase – heading level for sub-keys (### #### etc.)
 * @param {string[]} skipKeys  – keys to omit (already used as label)
 */
function objectToLines(obj, depth, headingBase, skipKeys) {
    const lines = [];
    for (const [key, value] of Object.entries(obj)) {
        if (skipKeys.includes(key)) continue;
        if (value === null || value === undefined) {
            lines.push(`**${prettyKey(key)}:** _null_  `);
            continue;
        }
        if (typeof value !== 'object') {
            const str = renderScalar(value);
            if (typeof value === 'string' && str.length > BLOCKQUOTE_THRESHOLD) {
                lines.push(`**${prettyKey(key)}:**`);
                lines.push('');
                lines.push('> ' + str.replace(/\n/g, '\n> '));
                lines.push('');
            } else {
                lines.push(`**${prettyKey(key)}:** ${str}  `);
            }
            continue;
        }
        // value is an object or array — add a sub-heading if depth allows
        const hLevel = Math.min(headingBase, 6);
        const heading = '#'.repeat(hLevel) + ' ' + prettyKey(key);
        lines.push('');
        lines.push(heading);
        lines.push('');
        const subLines = valueToLines(value, depth + 1, headingBase + 1);
        subLines.forEach(l => lines.push(l));
        lines.push('');
    }
    return lines;
}

// ─── Main conversion ─────────────────────────────────────────────────────────

function convert(data, inputFile) {
    const baseName = path.basename(inputFile, path.extname(inputFile));
    const generatedDate = new Date().toISOString().slice(0, 10);

    const mdLines = [
        `# ${baseName} — Analysis Report`,
        `_Generated: ${generatedDate}_`,
        '',
        '---',
        '',
    ];

    const topKeys = Object.keys(data);
    console.log(`📋 Top-level sections found: ${topKeys.join(', ')}`);

    topKeys.forEach((key, idx) => {
        console.log(`   ⚙️  Processing section [${idx + 1}/${topKeys.length}]: ${key}`);
        mdLines.push(`## ${prettyKey(key)}`);
        mdLines.push('');

        const sectionLines = valueToLines(data[key], 1, 3);
        sectionLines.forEach(l => mdLines.push(l));

        mdLines.push('');
        mdLines.push('---');
        mdLines.push('');
    });

    return mdLines.join('\n');
}

// ─── Entry point ─────────────────────────────────────────────────────────────

function main() {
    const absInput  = path.resolve(inputPath);
    const absOutput = path.resolve(outputPath);

    if (!fs.existsSync(absInput)) {
        console.error(`❌ Input file not found: ${absInput}`);
        process.exit(1);
    }

    const fileSizeMB = (fs.statSync(absInput).size / 1024 / 1024).toFixed(1);
    console.log(`\n📂 Reading ${absInput} (${fileSizeMB} MB)…`);
    if (parseFloat(fileSizeMB) > 30) {
        console.log('   ⚠️  Large file detected — loading into memory (Node.js built-in JSON.parse). Ensure sufficient RAM.');
    }

    let data;
    try {
        const raw = fs.readFileSync(absInput, 'utf8');
        console.log('✅ File read successfully.');
        data = JSON.parse(raw);
        console.log('✅ JSON parsed successfully.');
    } catch (err) {
        console.error(`❌ Failed to read/parse JSON: ${err.message}`);
        process.exit(1);
    }

    console.log('\n🔄 Converting to Markdown…');
    const markdown = convert(data, inputPath);

    fs.writeFileSync(absOutput, markdown, 'utf8');
    const outSizeKB = (fs.statSync(absOutput).size / 1024).toFixed(1);
    console.log(`\n✅ Markdown written to ${absOutput} (${outSizeKB} KB)`);
    console.log('Done.\n');
}

main();
