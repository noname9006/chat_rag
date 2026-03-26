'use strict';

// compact_analysis.js
// Deterministic Markdown report from full_exhaustive_analysis.json or fast_analysis.json
// CommonJS, Node.js >= 18, no external dependencies, no LLM required

const fs = require('fs');
const path = require('path');

// ─── CLI argument parsing ────────────────────────────────────────────────────

const args = process.argv.slice(2);

const FLAG_DRY_RUN   = args.includes('--dry-run');
const FLAG_NO_WEEKLY = args.includes('--no-weekly');

let topN = 10;

const consumedIndices = new Set();

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--top-n' && args[i + 1]) {
        const n = parseInt(args[i + 1], 10);
        if (!isNaN(n) && n > 0) topN = n;
        consumedIndices.add(i);
        consumedIndices.add(i + 1);
        i++;
    }
}

const fileArgs = args.filter((a, idx) => !a.startsWith('--') && !consumedIndices.has(idx));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate() {
    return new Date().toISOString().slice(0, 10);
}

function mdTable(headers, rows) {
    if (!rows || rows.length === 0) return '_No data._';
    const header = '| ' + headers.join(' | ') + ' |';
    const sep    = '|' + headers.map(() => '---|').join('');
    const body   = rows.map(r => '| ' + r.join(' | ') + ' |').join('\n');
    return [header, sep, body].join('\n');
}

// ─── Exhaustive format renderer ───────────────────────────────────────────────

function renderExhaustive(data, opts) {
    const { topN, noWeekly } = opts;
    const lines = [];

    lines.push('# Exhaustive Analysis — Compact Report');
    lines.push(`_Generated: ${formatDate()}_`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // Overview
    lines.push('## 📊 Overview');
    lines.push(`- Analysis date: ${data.analysisDate ? data.analysisDate.slice(0, 10) : formatDate()}`);
    lines.push(`- Total duration: ${data.totalDuration || 'n/a'}`);
    lines.push(`- Total months: ${data.summary?.totalMonths ?? data.monthly?.length ?? 'n/a'}`);
    lines.push(`- Total messages: ${data.summary?.totalMessages ?? 'n/a'}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // Global Summary
    const gs = data.globalSummary;
    if (gs) {
        lines.push('## 🌍 Global Summary');
        lines.push('');
        if (gs.overall_narrative) {
            lines.push(gs.overall_narrative);
            lines.push('');
        }

        if (gs.most_discussed_products && gs.most_discussed_products.length > 0) {
            lines.push('**Most discussed products:**');
            lines.push(mdTable(
                ['Product', 'Why popular'],
                gs.most_discussed_products.slice(0, topN).map(p => [p.name || '', p.why || ''])
            ));
            lines.push('');
        }

        if (gs.persistent_issues && gs.persistent_issues.length > 0) {
            lines.push('**Persistent issues:**');
            gs.persistent_issues.forEach(issue => lines.push(`- ${issue}`));
            lines.push('');
        }

        if (gs.community_evolution) {
            lines.push('**Community evolution:**');
            lines.push(gs.community_evolution);
            lines.push('');
        }

        if (gs.key_milestones && gs.key_milestones.length > 0) {
            lines.push('**Key milestones:**');
            gs.key_milestones.forEach(m => lines.push(`- ${m}`));
            lines.push('');
        }

        lines.push('---');
        lines.push('');
    }

    // Monthly Summaries
    if (data.monthly && data.monthly.length > 0) {
        lines.push('## 📅 Monthly Summaries');
        lines.push('');

        for (const month of data.monthly) {
            const ms = month.monthSummary;
            lines.push(`### ${month.monthLabel} (${month.totalMessages} messages)`);
            lines.push('');

            if (ms) {
                if (ms.executive_summary) {
                    lines.push(ms.executive_summary);
                    lines.push('');
                }

                if (ms.top_products_month && ms.top_products_month.length > 0) {
                    const topProds = ms.top_products_month.slice(0, topN)
                        .map(p => `${p.name} (${p.sentiment || 'n/a'})`)
                        .join(', ');
                    lines.push(`**Top products:** ${topProds}`);
                }

                if (ms.major_issues && ms.major_issues.length > 0) {
                    lines.push(`**Major issues:** ${ms.major_issues.slice(0, topN).join(', ')}`);
                }

                if (ms.month_mood) {
                    lines.push(`**Mood:** ${ms.month_mood}`);
                }
                lines.push('');
            }

            // Weekly summaries
            if (!noWeekly && month.weeklySummaries && month.weeklySummaries.length > 0) {
                for (const week of month.weeklySummaries) {
                    const ws = week.weekSummary;
                    if (!ws) continue;
                    lines.push(`#### Week ${week.week || ''} (${week.totalMessages || 0} messages)`);
                    lines.push('');
                    if (ws.week_narrative) {
                        lines.push(ws.week_narrative);
                        lines.push('');
                    }
                    if (ws.top_products && ws.top_products.length > 0) {
                        lines.push(`**Top products:** ${ws.top_products.slice(0, topN).map(p => `${p.name} (${p.sentiment || 'n/a'})`).join(', ')}`);
                    }
                    if (ws.key_issues && ws.key_issues.length > 0) {
                        lines.push(`**Key issues:** ${ws.key_issues.slice(0, topN).join(', ')}`);
                    }
                    lines.push('');
                }
            }

            lines.push('---');
            lines.push('');
        }
    }

    // Aggregated sections
    renderAggregated(lines, data.aggregated, topN);

    return lines.join('\n');
}

// ─── Fast format renderer ─────────────────────────────────────────────────────

function renderFast(data, opts) {
    const { topN } = opts;
    const lines = [];

    lines.push('# Fast Analysis — Compact Report');
    lines.push(`_Generated: ${formatDate()}_`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // Overview
    lines.push('## 📊 Overview');
    lines.push(`- Analysis date: ${data.analysisDate ? data.analysisDate.slice(0, 10) : formatDate()}`);
    lines.push(`- Total months: ${data.monthly?.length ?? 'n/a'}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // Monthly Summaries
    if (data.monthly && data.monthly.length > 0) {
        lines.push('## 📅 Monthly Summaries');
        lines.push('');

        for (const month of data.monthly) {
            lines.push(`### ${month.monthLabel} (${month.totalMessages || month.messages?.length || 0} messages)`);
            lines.push('');

            const ins = month.insights;
            if (ins) {
                if (ins.key_insights && ins.key_insights.length > 0) {
                    ins.key_insights.forEach(i => lines.push(`- ${i}`));
                    lines.push('');
                }

                if (ins.products_mentioned && ins.products_mentioned.length > 0) {
                    const prods = ins.products_mentioned.slice(0, topN)
                        .map(p => `${p.name} (${p.sentiment || 'n/a'})`)
                        .join(', ');
                    lines.push(`**Products:** ${prods}`);
                }

                if (ins.pain_points && ins.pain_points.length > 0) {
                    lines.push(`**Pain points:** ${ins.pain_points.slice(0, topN).join(', ')}`);
                }

                if (ins.overall_mood) {
                    lines.push(`**Mood:** ${ins.overall_mood}`);
                }
                lines.push('');
            }

            lines.push('---');
            lines.push('');
        }
    }

    // Aggregated sections
    renderAggregated(lines, data.aggregated, topN);

    return lines.join('\n');
}

// ─── Shared aggregated renderer ───────────────────────────────────────────────

function renderAggregated(lines, aggregated, topN) {
    if (!aggregated) return;

    if (aggregated.topProducts && aggregated.topProducts.length > 0) {
        lines.push('## 📈 Aggregated: Top Products');
        lines.push('');
        lines.push(mdTable(
            ['Product', 'Mentions', 'Sentiment'],
            aggregated.topProducts.slice(0, topN).map(p => [
                p.name || '',
                String(p.totalMentions ?? p.mentions ?? ''),
                p.avgSentiment || p.sentiment || ''
            ])
        ));
        lines.push('');
    }

    if (aggregated.topPainPoints && aggregated.topPainPoints.length > 0) {
        lines.push('## 🔥 Aggregated: Top Pain Points');
        lines.push('');
        lines.push(mdTable(
            ['Issue', 'Frequency'],
            aggregated.topPainPoints.slice(0, topN).map(p => [
                p.issue || p.name || '',
                String(p.frequency ?? p.count ?? '')
            ])
        ));
        lines.push('');
    }

    if (aggregated.topTopics && aggregated.topTopics.length > 0) {
        lines.push('## 💬 Aggregated: Top Topics');
        lines.push('');
        lines.push(mdTable(
            ['Topic', 'Count'],
            aggregated.topTopics.slice(0, topN).map(t => [
                t.topic || t.name || '',
                String(t.count ?? t.frequency ?? '')
            ])
        ));
        lines.push('');
    }
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
    // Resolve input/output paths
    const defaultInput = fs.existsSync('full_exhaustive_analysis.json')
        ? 'full_exhaustive_analysis.json'
        : 'fast_analysis.json';

    const inputPath = path.resolve(fileArgs[0] || defaultInput);

    const inputBase = path.basename(inputPath, '.json');
    const outputPath = path.resolve(fileArgs[1] || `${inputBase}_compact.md`);

    // Read JSON
    if (!fs.existsSync(inputPath)) {
        console.error(`❌  Input file not found: ${inputPath}`);
        process.exit(1);
    }

    const fileSizeBytes = fs.statSync(inputPath).size;
    const fileSizeMB = (fileSizeBytes / 1024 / 1024).toFixed(1);
    console.log(`📂 Reading ${path.basename(inputPath)} (${fileSizeMB} MB)...`);

    let data;
    try {
        data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    } catch (err) {
        console.error(`❌  Failed to parse JSON: ${err.message}`);
        process.exit(1);
    }

    const isExhaustive = data.analysisType === 'exhaustive' || !!data.globalSummary;
    console.log(`✅ Format detected: ${isExhaustive ? 'exhaustive' : 'fast'}`);
    console.log(`   Months: ${data.monthly?.length ?? 0}, topN: ${topN}, no-weekly: ${FLAG_NO_WEEKLY}`);

    const opts = { topN, noWeekly: FLAG_NO_WEEKLY };
    const markdown = isExhaustive
        ? renderExhaustive(data, opts)
        : renderFast(data, opts);

    if (FLAG_DRY_RUN) {
        console.log('\n🔍 Dry-run mode — output preview:\n');
        console.log('─'.repeat(60));
        console.log(markdown.slice(0, 2000) + (markdown.length > 2000 ? '\n... [truncated for preview]' : ''));
        console.log('─'.repeat(60));
        console.log('\nDry-run complete. File not written.');
        return;
    }

    fs.writeFileSync(outputPath, markdown, 'utf8');
    const outKB = (Buffer.byteLength(markdown, 'utf8') / 1024).toFixed(1);
    console.log(`\n✅ Compact report written to ${path.basename(outputPath)} (${outKB} KB)`);
}

main();
