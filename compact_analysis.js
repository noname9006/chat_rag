'use strict';

// compact_analysis.js
// LLM-assisted summarization of full_analysis.json → full_analysis_compact.md
// CommonJS, Node.js >= 18, no external dependencies

const fs = require('fs');
const path = require('path');

// ─── CLI argument parsing ────────────────────────────────────────────────────

const args = process.argv.slice(2);

const FLAG_DRY_RUN = args.includes('--dry-run');

let llmUrl = 'http://localhost:1234/v1';
let maxTokensPerSection = 1024;

// Track which indices are consumed as flag values so they aren't treated as file paths
const consumedIndices = new Set();

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
        llmUrl = args[i + 1].replace(/\/$/, ''); // strip trailing slash
        consumedIndices.add(i);
        consumedIndices.add(i + 1);
        i++;
    } else if (args[i] === '--max-tokens' && args[i + 1]) {
        const n = parseInt(args[i + 1], 10);
        if (!isNaN(n) && n > 0) maxTokensPerSection = n;
        consumedIndices.add(i);
        consumedIndices.add(i + 1);
        i++;
    }
}

const fileArgs = args.filter((a, idx) => !a.startsWith('--') && !consumedIndices.has(idx));
const inputPath  = path.resolve(fileArgs[0] || 'full_analysis.json');
const outputPath = path.resolve(fileArgs[1] || 'full_analysis_compact.md');

// ─── LLM call ───────────────────────────────────────────────────────────────

async function callLLM(prompt) {
    const requestBody = {
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: maxTokensPerSection
    };

    let response;
    try {
        response = await fetch(`${llmUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });
    } catch (err) {
        console.error(`\n❌  Cannot reach LM Studio at ${llmUrl}`);
        console.error(`   ${err.message}`);
        console.error('   Make sure LM Studio is running and its local server is started.');
        process.exit(1);
    }

    if (!response.ok) {
        console.error(`\n❌  LM Studio returned HTTP ${response.status}`);
        process.exit(1);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? '';
    const totalTokens = data.usage?.total_tokens ?? '?';
    return { content, totalTokens };
}

// ─── Prompt builder ──────────────────────────────────────────────────────────

const MAX_JSON_CHARS = 6000;

function buildPrompt(key, sectionValue) {
    let jsonStr = JSON.stringify(sectionValue);
    let truncated = false;
    if (jsonStr.length > MAX_JSON_CHARS) {
        // Truncate at character boundary — the result is intentionally not valid JSON;
        // it is only fed to the LLM as context for summarization, not parsed.
        jsonStr = jsonStr.slice(0, MAX_JSON_CHARS) + ' [truncated]';
        truncated = true;
    }

    return `You are summarizing a section of a Telegram chat analysis report.

Section name: "${key}"
Section data (JSON)${truncated ? ' (truncated)' : ''}:
${jsonStr}

Write a concise, human-readable summary of this section in 3-8 sentences of clear English prose.
Focus on the most important findings, numbers, and patterns.
Do not repeat the raw data — synthesize it.
If the data contains lists, highlight only the top items.
Be factual and specific.`;
}

// ─── Markdown helpers ────────────────────────────────────────────────────────

function toSectionTitle(key) {
    // Convert snake_case / camelCase to Title Case
    return key
        .replace(/_/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\b\w/g, c => c.toUpperCase());
}

function formatDate() {
    return new Date().toISOString().slice(0, 10);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    // 1. Read JSON
    if (!fs.existsSync(inputPath)) {
        console.error(`❌  Input file not found: ${inputPath}`);
        process.exit(1);
    }

    const fileSizeBytes = fs.statSync(inputPath).size;
    const fileSizeMB = (fileSizeBytes / 1024 / 1024).toFixed(1);
    process.stdout.write(`📂 Reading ${path.basename(inputPath)} (${fileSizeMB} MB)...\n`);

    let analysis;
    try {
        const raw = fs.readFileSync(inputPath, 'utf8');
        analysis = JSON.parse(raw);
    } catch (err) {
        console.error(`❌  Failed to parse JSON: ${err.message}`);
        process.exit(1);
    }

    const keys = Object.keys(analysis);
    console.log(`✅ JSON parsed. Found ${keys.length} top-level sections.\n`);

    if (FLAG_DRY_RUN) {
        console.log('🔍 Dry-run mode — printing prompts without calling LLM.\n');
        console.log('─'.repeat(60));
    }

    // 2. Process each section
    const sections = [];

    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const label = `[${i + 1}/${keys.length}]`;
        process.stdout.write(`🤖 Processing section ${label}: ${key}...\n`);

        const prompt = buildPrompt(key, analysis[key]);

        if (FLAG_DRY_RUN) {
            console.log(`\n--- PROMPT for "${key}" ---`);
            console.log(prompt);
            console.log('─'.repeat(60) + '\n');
            sections.push({ key, content: `_(dry-run — no LLM output)_` });
            continue;
        }

        const { content, totalTokens } = await callLLM(prompt);
        console.log(`   ✅ Done (${totalTokens} tokens)`);
        sections.push({ key, content });
    }

    // 3. Build Markdown document
    const lines = [
        `# full_analysis — Compact Analysis Report`,
        `_Generated: ${formatDate()} · LLM-assisted summary_`,
        '',
        '---',
        ''
    ];

    for (const { key, content } of sections) {
        lines.push(`## ${toSectionTitle(key)}`);
        lines.push('');
        lines.push(content.trim());
        lines.push('');
        lines.push('---');
        lines.push('');
    }

    const markdown = lines.join('\n');
    fs.writeFileSync(outputPath, markdown, 'utf8');

    const outKB = (Buffer.byteLength(markdown, 'utf8') / 1024).toFixed(1);
    console.log(`\n✅ Compact report written to ${path.basename(outputPath)} (${outKB} KB)`);
    console.log('Done.');
}

main();
