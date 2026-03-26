'use strict';
// convert_to_doc.js — Converts full_analysis.json to human-readable documents.
// Usage:
//   node convert_to_doc.js                   # full_analysis.json → full_analysis.md (full)
//   node convert_to_doc.js --summary         # → full_analysis_summary.md (highlights only)
//   node convert_to_doc.js --html            # → full_analysis.html (interactive)
//   node convert_to_doc.js --all             # all three outputs
//   node convert_to_doc.js input.json        # custom input file, full Markdown output

const fs   = require('fs');
const path = require('path');

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const FLAG_SUMMARY = args.includes('--summary');
const FLAG_HTML    = args.includes('--html');
const FLAG_ALL     = args.includes('--all');

// Non-flag arguments are treated as file paths
const fileArgs = args.filter(a => !a.startsWith('--'));
const inputPath  = fileArgs[0] || 'full_analysis.json';

const MAX_DEPTH = 10;
const BLOCKQUOTE_THRESHOLD = 200;
const TOP_N = 10;  // max items in summary lists

// ─── Helpers ─────────────────────────────────────────────────────────────────

function prettyKey(key) {
  return String(key).replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function renderScalar(value) {
  if (value === null || value === undefined) return '_null_';
  if (typeof value === 'boolean') return value ? '`true`' : '`false`';
  return String(value);
}

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
    return keys.every(k => { const v = item[k]; return v === null || typeof v !== 'object'; });
  });
}

function renderTable(arr) {
  const keys = Object.keys(arr[0]);
  const header    = '| ' + keys.map(prettyKey).join(' | ') + ' |';
  const separator = '| ' + keys.map(() => '---').join(' | ') + ' |';
  const rows = arr.map(item => {
    const cells = keys.map(k => {
      const v = item[k];
      if (v === null || v === undefined) return '_null_';
      if (typeof v === 'object') return '`' + JSON.stringify(v).substring(0, 60) + '`';
      const s = renderScalar(v);
      return s.length > 80 ? s.substring(0, 77) + '…' : s;
    });
    return '| ' + cells.join(' | ') + ' |';
  });
  return [header, separator, ...rows].join('\n');
}

function valueToLines(value, depth, headingBase) {
  if (depth > MAX_DEPTH) return ['> _(max depth reached — value truncated)_'];
  if (value === null || value === undefined) return ['_null_'];

  if (typeof value !== 'object') {
    const str = renderScalar(value);
    if (typeof value === 'string' && str.length > BLOCKQUOTE_THRESHOLD)
      return ['> ' + str.replace(/\n/g, '\n> ')];
    return [str];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return ['_empty_'];
    if (isTableArray(value)) return [renderTable(value), ''];
    if (value.every(item => item === null || typeof item !== 'object'))
      return value.map(item => `- ${renderScalar(item)}`);
    const lines = [];
    value.forEach((item, idx) => {
      if (item === null || typeof item !== 'object') { lines.push(`- ${renderScalar(item)}`); return; }
      const itemKeys = Object.keys(item);
      const labelKey = ['name', 'label', 'title', 'month', 'week', 'id'].find(k => itemKeys.includes(k));
      const label = labelKey ? ` **${renderScalar(item[labelKey])}**` : ` Item ${idx + 1}`;
      lines.push(`-${label}`);
      objectToLines(item, depth + 1, headingBase + 1, labelKey ? [labelKey] : []).forEach(l => lines.push('  ' + l));
    });
    return lines;
  }

  return objectToLines(value, depth, headingBase, []);
}

function objectToLines(obj, depth, headingBase, skipKeys) {
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    if (skipKeys.includes(key)) continue;
    if (value === null || value === undefined) { lines.push(`**${prettyKey(key)}:** _null_  `); continue; }
    if (typeof value !== 'object') {
      const str = renderScalar(value);
      if (typeof value === 'string' && str.length > BLOCKQUOTE_THRESHOLD) {
        lines.push(`**${prettyKey(key)}:**`, '', '> ' + str.replace(/\n/g, '\n> '), '');
      } else {
        lines.push(`**${prettyKey(key)}:** ${str}  `);
      }
      continue;
    }
    const hLevel = Math.min(headingBase, 6);
    lines.push('', '#'.repeat(hLevel) + ' ' + prettyKey(key), '');
    valueToLines(value, depth + 1, headingBase + 1).forEach(l => lines.push(l));
    lines.push('');
  }
  return lines;
}

// ─── Full Markdown ────────────────────────────────────────────────────────────

function convertToMarkdown(data, inputFile) {
  const baseName = path.basename(inputFile, path.extname(inputFile));
  const generatedDate = new Date().toISOString().slice(0, 10);
  const lines = [`# ${baseName} — Analysis Report`, `_Generated: ${generatedDate}_`, '', '---', ''];
  const topKeys = Object.keys(data);
  console.log(`📋 Top-level sections: ${topKeys.join(', ')}`);
  topKeys.forEach((key, idx) => {
    console.log(`   ⚙️  [${idx + 1}/${topKeys.length}] ${key}`);
    lines.push(`## ${prettyKey(key)}`, '');
    valueToLines(data[key], 1, 3).forEach(l => lines.push(l));
    lines.push('', '---', '');
  });
  return lines.join('\n');
}

// ─── Summary Markdown ─────────────────────────────────────────────────────────

function buildMonthlyTimeline(data) {
  // Look for a timeline/activity section, or build from messages if available
  const timelineKey = Object.keys(data).find(k => /timeline|activity|monthly/i.test(k));
  if (timelineKey) {
    const val = data[timelineKey];
    if (Array.isArray(val) && isTableArray(val)) return renderTable(val.slice(0, 60));
    if (typeof val === 'object' && !Array.isArray(val)) {
      // object keyed by month
      const rows = Object.entries(val)
        .filter(([k]) => /^\d{4}-\d{2}/.test(k))
        .sort(([a], [b]) => a.localeCompare(b));
      if (rows.length > 0) {
        const header    = '| Month | Messages |';
        const separator = '| --- | --- |';
        const tableRows = rows.map(([month, count]) => `| ${month} | ${typeof count === 'object' ? JSON.stringify(count) : count} |`);
        return [header, separator, ...tableRows].join('\n');
      }
    }
  }
  return '_Timeline data not found in analysis._';
}

function getTopN(arr, scoreKey, n) {
  if (!Array.isArray(arr)) return arr;
  const sorted = [...arr].sort((a, b) => {
    const av = a[scoreKey] ?? 0, bv = b[scoreKey] ?? 0;
    return (typeof bv === 'number' ? bv : 0) - (typeof av === 'number' ? av : 0);
  });
  return sorted.slice(0, n);
}

function convertToSummary(data, inputFile) {
  const baseName = path.basename(inputFile, path.extname(inputFile));
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    `# ${baseName} — Summary Report`,
    `_Generated: ${date} · Highlights only_`,
    '', '---', ''
  ];

  // 1. Top-level stats
  lines.push('## Overview', '');
  const summaryKey = Object.keys(data).find(k => /^summary|^overview|^stats|^meta/i.test(k));
  if (summaryKey) {
    const s = data[summaryKey];
    if (typeof s === 'object' && !Array.isArray(s)) {
      Object.entries(s).forEach(([k, v]) => {
        if (typeof v !== 'object') lines.push(`**${prettyKey(k)}:** ${renderScalar(v)}  `);
      });
    }
  } else {
    lines.push('_No summary section found._');
  }
  lines.push('', '---', '');

  // 2. Monthly timeline
  lines.push('## Activity Timeline (Monthly)', '');
  lines.push(buildMonthlyTimeline(data));
  lines.push('', '---', '');

  // 3. Top topics
  lines.push('## Top Topics', '');
  const topicsKey = Object.keys(data).find(k => /topic|theme|subject/i.test(k));
  if (topicsKey) {
    const topics = data[topicsKey];
    if (Array.isArray(topics)) {
      const top = getTopN(topics, 'count', TOP_N);
      if (isTableArray(top)) lines.push(renderTable(top));
      else top.forEach(t => lines.push(`- ${typeof t === 'object' ? JSON.stringify(t) : t}`));
    } else {
      lines.push('_Topics data found but not in expected array format._');
    }
  } else {
    lines.push('_No topics section found._');
  }
  lines.push('', '---', '');

  // 4. Top participants
  lines.push('## Most Active Participants', '');
  const participantsKey = Object.keys(data).find(k => /participant|author|user|member/i.test(k));
  if (participantsKey) {
    const participants = data[participantsKey];
    if (Array.isArray(participants)) {
      const top = getTopN(participants, 'message_count', TOP_N);
      if (isTableArray(top)) lines.push(renderTable(top));
      else top.forEach(p => lines.push(`- ${typeof p === 'object' ? JSON.stringify(p) : p}`));
    } else {
      lines.push('_Participants data found but not in expected array format._');
    }
  } else {
    lines.push('_No participants section found._');
  }
  lines.push('', '---', '');

  // 5. Key insights
  lines.push('## Key Insights', '');
  const insightsKey = Object.keys(data).find(k => /insight|finding|highlight|conclusion/i.test(k));
  if (insightsKey) {
    const insights = data[insightsKey];
    if (Array.isArray(insights)) {
      insights.slice(0, TOP_N).forEach((ins, i) => {
        if (typeof ins === 'string') lines.push(`${i + 1}. ${ins}`);
        else if (typeof ins === 'object') {
          const text = ins.text || ins.content || ins.insight || ins.summary || JSON.stringify(ins);
          lines.push(`${i + 1}. ${text}`);
        }
      });
    } else if (typeof insights === 'string') {
      lines.push(insights);
    } else {
      lines.push('_Insights data found but not in expected format._');
    }
  } else {
    lines.push('_No insights section found._');
  }
  lines.push('', '---', '');

  // 6. Top reacted messages
  lines.push('## Top Reacted Messages', '');
  const reactionsKey = Object.keys(data).find(k => /reaction|popular|top.message/i.test(k));
  if (reactionsKey) {
    const reactions = data[reactionsKey];
    if (Array.isArray(reactions)) {
      getTopN(reactions, 'reaction_count', 5).forEach((msg, i) => {
        const text = msg.text || msg.content || msg.message || '';
        const count = msg.reaction_count || msg.reactions || '';
        lines.push(`${i + 1}. **Reactions: ${count}** — ${String(text).substring(0, 200)}`);
      });
    }
  } else {
    lines.push('_No top reactions section found._');
  }
  lines.push('', '---', '');

  return lines.join('\n');
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function valueToHtml(value, depth) {
  if (depth > MAX_DEPTH) return '<em>(max depth reached)</em>';
  if (value === null || value === undefined) return '<em>null</em>';

  if (typeof value !== 'object') {
    const str = String(value);
    if (typeof value === 'string' && str.length > BLOCKQUOTE_THRESHOLD)
      return `<blockquote>${escapeHtml(str)}</blockquote>`;
    return escapeHtml(str);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '<em>empty</em>';
    if (isTableArray(value)) {
      const keys = Object.keys(value[0]);
      const thead = '<tr>' + keys.map(k => `<th>${escapeHtml(prettyKey(k))}</th>`).join('') + '</tr>';
      const tbody = value.map(item =>
        '<tr>' + keys.map(k => {
          const v = item[k];
          if (v === null || v === undefined) return '<td><em>null</em></td>';
          const s = String(v);
          return `<td>${escapeHtml(s.length > 120 ? s.substring(0, 117) + '…' : s)}</td>`;
        }).join('') + '</tr>'
      ).join('\n');
      return `<table>\n<thead>${thead}</thead>\n<tbody>${tbody}</tbody>\n</table>`;
    }
    if (value.every(item => item === null || typeof item !== 'object'))
      return '<ul>' + value.map(item => `<li>${escapeHtml(renderScalar(item))}</li>`).join('') + '</ul>';
    return '<ul>' + value.map((item, idx) => {
      if (item === null || typeof item !== 'object') return `<li>${escapeHtml(renderScalar(item))}</li>`;
      return `<li>${valueToHtml(item, depth + 1)}</li>`;
    }).join('') + '</ul>';
  }

  // Object
  return '<dl>' + Object.entries(value).map(([k, v]) => {
    if (typeof v !== 'object' || v === null) {
      return `<dt>${escapeHtml(prettyKey(k))}</dt><dd>${escapeHtml(renderScalar(v))}</dd>`;
    }
    return `<dt>${escapeHtml(prettyKey(k))}</dt><dd>${valueToHtml(v, depth + 1)}</dd>`;
  }).join('\n') + '</dl>';
}

function convertToHtml(data, inputFile) {
  const baseName = path.basename(inputFile, path.extname(inputFile));
  const date = new Date().toISOString().slice(0, 10);
  const topKeys = Object.keys(data);

  const sections = topKeys.map(key => {
    const content = valueToHtml(data[key], 1);
    return `
  <details>
    <summary><strong>${escapeHtml(prettyKey(key))}</strong></summary>
    <div class="section-body">
      ${content}
    </div>
  </details>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(baseName)} — Analysis Report</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; background: #f5f5f5; color: #222; }
  header { position: sticky; top: 0; background: #1a1a2e; color: #fff; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; z-index: 100; box-shadow: 0 2px 6px rgba(0,0,0,0.3); }
  header h1 { margin: 0; font-size: 1.1rem; }
  header span { font-size: 0.85rem; opacity: 0.7; }
  #toggle-btn { background: #e94560; color: white; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 0.85rem; }
  #toggle-btn:hover { background: #c73652; }
  main { max-width: 1100px; margin: 24px auto; padding: 0 16px; }
  details { background: #fff; border-radius: 8px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow: hidden; }
  summary { padding: 14px 18px; cursor: pointer; font-size: 1rem; list-style: none; user-select: none; background: #f0f0f0; border-left: 4px solid #1a1a2e; }
  summary:hover { background: #e4e4f0; }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: '▶ '; font-size: 0.75em; margin-right: 6px; color: #888; }
  details[open] summary::before { content: '▼ '; }
  .section-body { padding: 16px 18px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 0.88rem; }
  th { background: #1a1a2e; color: #fff; padding: 8px 10px; text-align: left; }
  td { padding: 6px 10px; border-bottom: 1px solid #eee; }
  tr:nth-child(even) td { background: #fafafa; }
  blockquote { background: #f9f3e3; border-left: 4px solid #e8a838; padding: 10px 14px; margin: 8px 0; border-radius: 4px; font-size: 0.9rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; font-size: 0.9rem; }
  dt { font-weight: 600; color: #555; white-space: nowrap; }
  dd { margin: 0; }
  ul { padding-left: 20px; }
  li { margin: 3px 0; font-size: 0.9rem; }
</style>
</head>
<body>
<header>
  <h1>📊 ${escapeHtml(baseName)} — Analysis Report</h1>
  <span>Generated: ${date}</span>
  <button id="toggle-btn" onclick="toggleAll()">Expand All</button>
</header>
<main>
${sections}
</main>
<script>
  let expanded = false;
  function toggleAll() {
    expanded = !expanded;
    document.querySelectorAll('details').forEach(d => d.open = expanded);
    document.getElementById('toggle-btn').textContent = expanded ? 'Collapse All' : 'Expand All';
  }
</script>
</body>
</html>`;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

function main() {
  const absInput = path.resolve(inputPath);

  if (!fs.existsSync(absInput)) {
    console.error(`❌ Input file not found: ${absInput}`);
    console.error(`   Tip: run from the directory containing full_analysis.json, or pass the path as an argument.`);
    process.exit(1);
  }

  const fileSizeMB = (fs.statSync(absInput).size / 1024 / 1024).toFixed(1);
  console.log(`\n📂 Reading ${absInput} (${fileSizeMB} MB)…`);
  if (parseFloat(fileSizeMB) > 30)
    console.log('   ⚠️  Large file — loading into memory. Ensure sufficient RAM.');

  let data;
  try {
    const raw = fs.readFileSync(absInput, 'utf8');
    console.log('✅ File read.');
    data = JSON.parse(raw);
    console.log('✅ JSON parsed.');
  } catch (err) {
    console.error(`❌ Failed to read/parse JSON: ${err.message}`);
    process.exit(1);
  }

  const base = path.join(path.dirname(absInput), path.basename(inputPath, path.extname(inputPath)));

  const doFull    = FLAG_ALL || (!FLAG_SUMMARY && !FLAG_HTML);
  const doSummary = FLAG_ALL || FLAG_SUMMARY;
  const doHtml    = FLAG_ALL || FLAG_HTML;

  if (doFull) {
    console.log('\n🔄 Generating full Markdown…');
    const md = convertToMarkdown(data, inputPath);
    const out = base + '.md';
    fs.writeFileSync(out, md, 'utf8');
    console.log(`✅ Full Markdown → ${out} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
  }

  if (doSummary) {
    console.log('\n🔄 Generating summary Markdown…');
    const md = convertToSummary(data, inputPath);
    const out = base + '_summary.md';
    fs.writeFileSync(out, md, 'utf8');
    console.log(`✅ Summary → ${out} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
  }

  if (doHtml) {
    console.log('\n🔄 Generating interactive HTML…');
    const html = convertToHtml(data, inputPath);
    const out = base + '.html';
    fs.writeFileSync(out, html, 'utf8');
    console.log(`✅ HTML → ${out} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
  }

  console.log('\nDone.\n');
}

main();