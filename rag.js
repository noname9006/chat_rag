const fs = require('fs');
const { pipeline } = require('@xenova/transformers');
const readline = require('readline');

// ============================================================================
// 1. TELEGRAM CHAT LOADER
// ============================================================================

class TelegramChatLoader {
    constructor(jsonPath) {
        this.jsonPath = jsonPath;
        this.messages = [];
    }

    load() {
        console.log('Loading JSON...');
        const raw = fs.readFileSync(this.jsonPath, 'utf-8');
        const data = JSON.parse(raw);
        
        for (const msg of data.messages) {
            if (msg.type !== 'message') continue;
            
            const text = this.extractText(msg);
            if (!text || text.trim().length < 10) continue;
            
            this.messages.push({
                id: msg.id,
                date: new Date(msg.date_unixtime * 1000),
                author: msg.from || 'Unknown',
                text: text,
                replyTo: msg.reply_to_message_id
            });
        }
        
        console.log(`✅ Loaded ${this.messages.length} messages\n`);
        return this.messages;
    }
    
    extractText(msg) {
        const text = msg.text || '';
        
        if (typeof text === 'string') {
            return text;
        } else if (Array.isArray(text)) {
            return text.map(item => {
                if (typeof item === 'string') return item;
                if (typeof item === 'object') return item.text || '';
                return '';
            }).join('');
        }
        return '';
    }
}

// ============================================================================
// 2. SIMPLE VECTOR INDEX (Pure JS)
// ============================================================================

class SimpleVectorIndex {
    constructor() {
        this.vectors = [];
        this.metadata = [];
    }
    
    add(vector, metadata) {
        this.vectors.push(vector);
        this.metadata.push(metadata);
    }
    
    cosineSimilarity(a, b) {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
    
    search(queryVector, topK = 5) {
        const similarities = this.vectors.map((vec, idx) => ({
            index: idx,
            similarity: this.cosineSimilarity(queryVector, vec),
            metadata: this.metadata[idx]
        }));
        
        similarities.sort((a, b) => b.similarity - a.similarity);
        return similarities.slice(0, topK);
    }
    
    size() {
        return this.vectors.length;
    }
}

// ============================================================================
// 3. RAG SYSTEM (with chunked storage + three search modes)
// ============================================================================

class ChatRAG {
    constructor() {
        this.embedder = null;
        this.index = new SimpleVectorIndex();
        this.messages = [];
        this.searchMode = 'twopass'; // Options: 'simple', 'adaptive', 'twopass'
    }
    
    async initialize(messages) {
        console.log('🧠 Initializing embedder (multilingual-e5-small)...');
        this.embedder = await pipeline(
            'feature-extraction',
            'Xenova/multilingual-e5-small'
        );
        
        this.messages = messages;
        console.log('🔄 Creating embeddings...');
        
        const batchSize = 32;
        for (let i = 0; i < messages.length; i += batchSize) {
            const batch = messages.slice(i, i + batchSize);
            const texts = batch.map(m => `query: ${m.author}: ${m.text}`);
            
            const output = await this.embedder(texts, {
                pooling: 'mean',
                normalize: true
            });
            
            for (let j = 0; j < batch.length; j++) {
                const embedding = Array.from(output[j].data);
                this.index.add(embedding, i + j);
            }
            
            const progress = Math.min(i + batchSize, messages.length);
            process.stdout.write(`\r   Progress: ${progress}/${messages.length} messages`);
        }
        console.log('\n');
        
        console.log(`✅ RAG index ready! (${this.index.size()} vectors)\n`);
    }
    
    // ════════════════════════════════════════════════════════════════════
    // SEARCH MODE 1: SIMPLE (original, fast)
    // ════════════════════════════════════════════════════════════════════
    
    async searchSimple(query, maxResults = 30, minSimilarity = 0.4) {
        const queryEmbedding = await this.embedder(`query: ${query}`, {
            pooling: 'mean',
            normalize: true
        });
        
        const queryVector = Array.from(queryEmbedding[0].data);
        const allResults = this.index.search(queryVector, maxResults);
        
        const filtered = allResults.filter(r => r.similarity > minSimilarity);
        const limited = filtered.slice(0, 30);
        
        return limited.map(r => ({
            message: this.messages[r.metadata],
            similarity: r.similarity
        }));
    }
    
    // ════════════════════════════════════════════════════════════════════
    // SEARCH MODE 2: ADAPTIVE (context-aware)
    // ════════════════════════════════════════════════════════════════════
    
    async searchAdaptive(query, contextLimit = 12288, minSimilarity = 0.35) {
        // Calculate how many messages fit in context
        // ~65 tokens per message (Russian text average)
        // Reserve: 200 tokens for prompt, 1500 for answer
        const availableTokens = contextLimit - 1700;
        const maxMessages = Math.floor(availableTokens / 65);
        
        console.log(`   Adaptive mode: targeting ${maxMessages} messages for context ${contextLimit}`);
        
        const queryEmbedding = await this.embedder(`query: ${query}`, {
            pooling: 'mean',
            normalize: true
        });
        
        const queryVector = Array.from(queryEmbedding[0].data);
        const allResults = this.index.search(queryVector, maxMessages * 2);
        
        const filtered = allResults.filter(r => r.similarity > minSimilarity);
        const limited = filtered.slice(0, maxMessages);
        
        return limited.map(r => ({
            message: this.messages[r.metadata],
            similarity: r.similarity
        }));
    }
    
    // ════════════════════════════════════════════════════════════════════
    // SEARCH MODE 3: TWO-PASS (highest quality)
    // ════════════════════════════════════════════════════════════════════
    
    async searchTwoPass(query, contextLimit = 12288) {
        // ═══════════════════════════════════════════════════════════
        // PASS 1: WIDE NET — find all potentially relevant messages
        // ═══════════════════════════════════════════════════════════
        
        console.log('   Pass 1: Wide search (top-100, similarity > 0.3)...');
        
        const queryEmbedding = await this.embedder(`query: ${query}`, {
            pooling: 'mean',
            normalize: true
        });
        
        const queryVector = Array.from(queryEmbedding[0].data);
        
        // Search top-100 by cosine similarity
        const firstPass = this.index.search(queryVector, 100);
        
        // Soft filter: similarity > 0.3
        const filtered = firstPass.filter(r => r.similarity > 0.3);
        
        console.log(`   Pass 1: Found ${filtered.length} candidates`);
        
        if (filtered.length === 0) {
            console.log('   ⚠️  No candidates found, returning empty results\n');
            return [];
        }
        
        // ═══════════════════════════════════════════════════════════
        // PASS 2: SMART RE-RANKING — select the best ones
        // ═══════════════════════════════════════════════════════════
        
        console.log('   Pass 2: Re-ranking by combined score...');
        
        // Calculate how many messages fit
        const availableTokens = contextLimit - 1700;
        const maxMessages = Math.floor(availableTokens / 65);
        
        // Re-rank by combined score
        const reranked = filtered
            .map(r => {
                const msg = this.messages[r.metadata];
                const msgLength = msg.text.length;
                
                // Combined score:
                // 70% — relevance (similarity)
                // 30% — informativeness (text length)
                const score = r.similarity * 0.7 + (msgLength / 1000) * 0.3;
                
                return {
                    ...r,
                    score: score,
                    length: msgLength
                };
            })
            .sort((a, b) => b.score - a.score)  // Sort by score descending
            .slice(0, maxMessages);  // Take top N that fit context
        
        console.log(`   Pass 2: Selected ${reranked.length} messages`);
        console.log(`   Score range: ${reranked[0].score.toFixed(3)} - ${reranked[reranked.length-1].score.toFixed(3)}`);
        console.log(`   Similarity range: ${reranked[0].similarity.toFixed(3)} - ${reranked[reranked.length-1].similarity.toFixed(3)}\n`);
        
        // Return final selection
        return reranked.map(r => ({
            message: this.messages[r.metadata],
            similarity: r.similarity,
            score: r.score,
            length: r.length
        }));
    }
    
    // ════════════════════════════════════════════════════════════════════
    // UNIFIED SEARCH — delegates to selected mode
    // ════════════════════════════════════════════════════════════════════
    
    async search(query, contextLimit = 12288) {
        console.log(`   Search mode: ${this.searchMode}`);
        
        switch(this.searchMode) {
            case 'simple':
                return await this.searchSimple(query);
            case 'adaptive':
                return await this.searchAdaptive(query, contextLimit);
            case 'twopass':
                return await this.searchTwoPass(query, contextLimit);
            default:
                throw new Error(`Unknown search mode: ${this.searchMode}`);
        }
    }
    
    setSearchMode(mode) {
        if (!['simple', 'adaptive', 'twopass'].includes(mode)) {
            throw new Error(`Invalid search mode: ${mode}. Use 'simple', 'adaptive', or 'twopass'`);
        }
        this.searchMode = mode;
        console.log(`✅ Search mode set to: ${mode}\n`);
    }
    
    saveIndex(basePath) {
        console.log(`💾 Saving index...`);
        
        const indexDir = basePath.replace('.json', '_chunks');
        if (!fs.existsSync(indexDir)) {
            fs.mkdirSync(indexDir, { recursive: true });
        }
        
        console.log('   Saving messages...');
        fs.writeFileSync(`${indexDir}/messages.json`, JSON.stringify(this.messages));
        
        const chunkSize = 10000;
        const numChunks = Math.ceil(this.index.vectors.length / chunkSize);
        console.log(`   Saving ${this.index.vectors.length} vectors in ${numChunks} chunks...`);
        
        for (let i = 0; i < numChunks; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, this.index.vectors.length);
            const chunk = this.index.vectors.slice(start, end);
            fs.writeFileSync(`${indexDir}/vectors_${i}.json`, JSON.stringify(chunk));
            process.stdout.write(`\r   Progress: ${i+1}/${numChunks} chunks`);
        }
        console.log('');
        
        console.log('   Saving metadata...');
        fs.writeFileSync(`${indexDir}/metadata.json`, JSON.stringify(this.index.metadata));
        
        fs.writeFileSync(`${indexDir}/manifest.json`, JSON.stringify({
            totalVectors: this.index.vectors.length,
            totalMessages: this.messages.length,
            numChunks: numChunks,
            chunkSize: chunkSize,
            created: new Date().toISOString()
        }, null, 2));
        
        console.log(`✅ Index saved to ${indexDir}/\n`);
    }
    
    async loadIndex(basePath) {
        const indexDir = basePath.replace('.json', '_chunks');
        console.log(`📂 Loading index from ${indexDir}...`);
        
        if (!fs.existsSync(indexDir)) {
            throw new Error(`Index directory not found: ${indexDir}`);
        }
        
        const manifest = JSON.parse(fs.readFileSync(`${indexDir}/manifest.json`, 'utf-8'));
        console.log(`   Index created: ${manifest.created}`);
        console.log(`   Total vectors: ${manifest.totalVectors}, chunks: ${manifest.numChunks}`);
        
        console.log('   Loading messages...');
        const rawMessages = JSON.parse(fs.readFileSync(`${indexDir}/messages.json`, 'utf-8'));
        
        // FIXED: Restore Date objects
        this.messages = rawMessages.map(m => ({
            ...m,
            date: new Date(m.date)
        }));
        
        console.log('   Loading vectors...');
        this.index.vectors = [];
        for (let i = 0; i < manifest.numChunks; i++) {
            const chunk = JSON.parse(fs.readFileSync(`${indexDir}/vectors_${i}.json`, 'utf-8'));
            this.index.vectors.push(...chunk);
            process.stdout.write(`\r   Progress: ${i+1}/${manifest.numChunks} chunks`);
        }
        console.log('');
        
        console.log('   Loading metadata...');
        this.index.metadata = JSON.parse(fs.readFileSync(`${indexDir}/metadata.json`, 'utf-8'));
        
        console.log('🧠 Initializing embedder...');
        this.embedder = await pipeline(
            'feature-extraction',
            'Xenova/multilingual-e5-small'
        );
        
        console.log(`✅ Index loaded! (${this.index.size()} vectors)\n`);
    }
}

// ============================================================================
// 4. LM STUDIO ANALYZER
// ============================================================================

class LMStudioAnalyzer {
    constructor(baseUrl = 'http://localhost:1234/v1', contextLimit = 12288) {
        this.baseUrl = baseUrl;
        this.contextLimit = contextLimit;
    }
    
    async analyze(query, context) {
        console.log(`   Using ${context.length} messages in context`);
        
        const contextText = context.map((item, i) => {
            const date = item.message.date.toLocaleDateString('ru-RU');
            const text = item.message.text.substring(0, 400);
            const simInfo = item.similarity ? ` [sim: ${item.similarity.toFixed(3)}]` : '';
            const scoreInfo = item.score ? ` [score: ${item.score.toFixed(3)}]` : '';
            return `[${i+1}] ${item.message.author} (${date})${simInfo}${scoreInfo}:\n${text}`;
        }).join('\n\n');

        const prompt = `You are analyzing Russian-language fintech community chat about banks and fintech services in EU.

Question (in Russian): ${query}

Context from chat (in Russian, ${context.length} messages):
${contextText}

Analyze and answer the question IN RUSSIAN. Include:
1. Конкретные мнения участников
2. Упомянутые продукты/сервисы
3. Проблемы или положительные стороны
4. Если есть противоречия - укажи разные точки зрения

Answer in Russian, be concise and factual.`;

        return await this.analyzeRaw(prompt);
    }
    
    async analyzeRaw(prompt) {
        const estimatedInputTokens = Math.ceil(prompt.length);
        const availableTokens = this.contextLimit - estimatedInputTokens - 300; // 300 safety buffer
        const outputTokens = Math.min(4000, Math.max(512, availableTokens));

        if (estimatedInputTokens > this.contextLimit - 1500) {
            console.warn(`⚠️  Prompt close to limit! (~${estimatedInputTokens} tokens)`);
        }

        const isJsonOnlyRequest = prompt.includes('JSON only') || prompt.includes('Output JSON only');

        const requestBody = {
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
            max_tokens: outputTokens
        };
        if (isJsonOnlyRequest) {
            requestBody.messages = [
                {
                    role: 'system',
                    content: 'You are a JSON-only API. Output valid JSON only. No explanations, no markdown, no preamble, no text before or after the JSON object.'
                },
                { role: 'user', content: prompt }
            ];
        }

        try {
            const response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });
            
            if (!response.ok) {
                throw new Error(`LM Studio error: ${response.status}`);
            }
            
            const data = await response.json();

            if (data.usage?.total_tokens === 0) {
                throw new Error('Client disconnected during generation (total_tokens=0)');
            }

            return data.choices[0].message.content;
        } catch (error) {
            return `❌ LM Studio connection error: ${error.message}\n\nCheck that LM Studio is running on http://localhost:1234`;
        }
    }
}

// ============================================================================
// 5. UTILITY FUNCTIONS (defined early for hoisting)
// ============================================================================

function groupByMonth(messages) {
    const groups = {};
    
    messages.forEach(msg => {
        const date = new Date(msg.date);
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        const key = `${year}-${String(month).padStart(2, '0')}`;
        
        if (!groups[key]) {
            groups[key] = {
                monthLabel: key,
                messages: []
            };
        }
        groups[key].messages.push(msg);
    });
    
    return Object.values(groups).sort((a, b) => 
        a.monthLabel.localeCompare(b.monthLabel)
    );
}

function getWeekNumber(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function calculateAvgSentiment(sentiments) {
    if (!sentiments || sentiments.length === 0) return 'neutral';
    
    const counts = { positive: 0, negative: 0, neutral: 0 };
    sentiments.forEach(s => {
        if (s === 'positive' || s === 'negative' || s === 'neutral') {
            counts[s] = (counts[s] || 0) + 1;
        } else {
            counts['neutral'] = (counts['neutral'] || 0) + 1;
        }
    });
    
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted[0][0];
}

function intelligentSample(messages, count) {
    if (messages.length <= count) return messages;
    
    const long = messages
        .filter(m => m.text.length > 100)
        .sort((a, b) => b.text.length - a.text.length)
        .slice(0, Math.floor(count * 0.5));
    
    const byDay = {};
    messages.forEach(m => {
        const day = m.date.toISOString().split('T')[0];
        if (!byDay[day]) byDay[day] = [];
        byDay[day].push(m);
    });
    
    const days = Object.keys(byDay).sort();
    const perDay = Math.max(1, Math.ceil(count * 0.3 / days.length));
    const timeSampled = [];
    
    days.forEach(day => {
        const daySample = byDay[day]
            .filter(m => !long.includes(m) && m.text.length > 50)
            .slice(0, perDay);
        timeSampled.push(...daySample);
    });
    
    const byAuthor = {};
    messages.forEach(m => {
        if (!byAuthor[m.author]) byAuthor[m.author] = [];
        byAuthor[m.author].push(m);
    });
    
    const authorSampled = [];
    const authors = Object.keys(byAuthor);
    const perAuthor = Math.max(1, Math.ceil(count * 0.2 / authors.length));
    
    authors.forEach(author => {
        const authorMsgs = byAuthor[author]
            .filter(m => !long.includes(m) && !timeSampled.includes(m) && m.text.length > 50)
            .slice(0, perAuthor);
        authorSampled.push(...authorMsgs);
    });
    
    const combined = [...new Set([...long, ...timeSampled, ...authorSampled])];
    return combined.slice(0, count);
}

// ============================================================================
// 6. EXHAUSTIVE BATCH ANALYSIS (HYBRID PROMPTS)
// ============================================================================

function chunkByTime(messages, maxSize = 120, gapMinutes = 120) {
    if (!messages || messages.length === 0) return [];
    const chunks = [];
    let current = [messages[0]];
    for (let i = 1; i < messages.length; i++) {
        const gap = (messages[i].date - messages[i-1].date) / 60000;
        if (gap > gapMinutes || current.length >= maxSize) {
            chunks.push(current);
            current = [];
        }
        current.push(messages[i]);
    }
    if (current.length) chunks.push(current);
    return chunks;
}

function extractFirstJsonObject(raw) {
    const start = raw.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < raw.length; i++) {
        const ch = raw[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return raw.slice(start, i + 1);
        }
    }
    // Unterminated — return everything from start (for truncation repair)
    return raw.slice(start);
}

function tryRepairJson(raw) {
    // Attempt 1: direct parse of the whole response
    try { return JSON.parse(raw); } catch {}

    // Extract the first complete JSON object using balanced-brace scanning
    const extracted = extractFirstJsonObject(raw);
    if (!extracted) return null;
    let str = extracted;

    // Attempt 2: parse the extracted object as-is
    try { return JSON.parse(str); } catch {}

    // Attempt 3: sanitize control characters inside strings
    // Replace literal control chars that are invalid in JSON strings
    str = str.replace(/[\x00-\x1F\x7F]/g, (c) => {
        const map = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
        return map[c] !== undefined ? map[c] : '';
    });
    try { return JSON.parse(str); } catch {}

    // Attempt 4: fix truncated JSON — strip the last incomplete entry and close brackets
    let fixed = str;
    // Remove trailing incomplete string value: ,"key": "incomplete...
    fixed = fixed.replace(/,\s*"[^"\\]*(?:\\.[^"\\]*)*"\s*:\s*"[^"]*$/, '');
    // Remove trailing incomplete array element: ,"incomplete...
    fixed = fixed.replace(/,\s*"[^"]*$/, '');
    // Remove trailing comma before closing
    fixed = fixed.replace(/,\s*$/, '');
    // Count unclosed brackets and braces
    const opens = (fixed.match(/\[/g) || []).length - (fixed.match(/\]/g) || []).length;
    const objOpens = (fixed.match(/\{/g) || []).length - (fixed.match(/\}/g) || []).length;
    for (let i = 0; i < opens; i++) fixed += ']';
    for (let i = 0; i < objOpens; i++) fixed += '}';
    try { return JSON.parse(fixed); } catch {}

    return null;
}

async function exhaustiveBatchAnalysis(messages, analyzer, batchSize = 80) {
    console.log(`\n📊 Exhaustive analysis of ${messages.length} messages (batches of ${batchSize})`);
    
    const timeChunks = chunkByTime(messages, batchSize, 120);
    const batches = [];
    for (const chunk of timeChunks) {
        if (chunk.length <= batchSize) {
            batches.push(chunk);
        } else {
            for (let i = 0; i < chunk.length; i += batchSize) {
                batches.push(chunk.slice(i, i + batchSize));
            }
        }
    }
    
    console.log(`   Total batches: ${batches.length}\n`);
    
    const batchAnalyses = [];

    // Dynamic character budget: reserve space for prompt template and output
    const PROMPT_OVERHEAD_TOKENS = 400;
    const OUTPUT_RESERVE_TOKENS = 1500;
    const CHARS_PER_TOKEN = 1; // Cyrillic: ~1 char per token
    const availableBudgetChars = (analyzer.contextLimit - PROMPT_OVERHEAD_TOKENS - OUTPUT_RESERVE_TOKENS) * CHARS_PER_TOKEN;

    function buildBatchPrompt(msgs, batchLabel, totalBatches) {
        const perMsg = msgs.length > 0 ? Math.floor(availableBudgetChars / msgs.length) : 200;
        const charLimit = Math.max(40, perMsg);
        return `You are analyzing Russian-language fintech community chat (batch ${batchLabel}/${totalBatches}).

Messages in Russian (${msgs.length} total):
${msgs.map(m => `${m.author}: ${m.text.substring(0, charLimit)}`).join('\n')}

Extract ALL mentions in JSON format (field names in English, content values in Russian):
{
  "products_mentioned": [{"name":"product name", "sentiment":"positive/negative/neutral", "context":"краткий контекст на русском"}],
  "pain_points": ["конкретная проблема на русском"],
  "topics": ["тема на русском"],
  "questions": ["вопрос без ответа на русском"],
  "key_insights": ["важный инсайт на русском"]
}

Be maximally detailed. Output JSON only, no explanations.`;
    }
    
    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const batchNum = i + 1;
        
        process.stdout.write(`\r   Batch ${batchNum}/${batches.length} (${batch.length} messages)...`);
        
        const prompt = buildBatchPrompt(batch, batchNum, batches.length);

        const response = await analyzer.analyzeRaw(prompt);
        
        let parsed = tryRepairJson(response);

        // Retry once with a smaller/simplified prompt on parse failure
        if (!parsed) {
            const half = batch.slice(0, Math.ceil(batch.length / 2));
            const retryPrompt = `Analyze this Russian fintech chat excerpt and return JSON only.

Messages:
${half.map(m => `${m.author}: ${m.text.substring(0, 80)}`).join('\n')}

Return this exact JSON structure:
{"products_mentioned":[],"pain_points":[],"topics":[],"questions":[],"key_insights":[]}

JSON only, no explanations.`;

            const retryRequestBody = {
                messages: [
                    {
                        role: 'system',
                        content: 'You are a JSON-only API. Output valid JSON only. No explanations, no markdown, no preamble, no text before or after the JSON object.'
                    },
                    { role: 'user', content: retryPrompt }
                ],
                temperature: 0.1,
                max_tokens: 1024
            };
            try {
                const retryResponse = await fetch(`${analyzer.baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(retryRequestBody)
                });
                if (retryResponse.ok) {
                    const retryData = await retryResponse.json();
                    if (retryData.usage?.total_tokens !== 0) {
                        parsed = tryRepairJson(retryData.choices[0].message.content);
                    }
                }
            } catch (retryError) {
                console.log(`\n      ⚠️  Batch ${batchNum}: Retry also failed — ${retryError.message}`);
            }
        }

        if (parsed) {
            batchAnalyses.push({
                batchNumber: batchNum,
                messageCount: batch.length,
                startDate: batch[0].date,
                endDate: batch[batch.length - 1].date,
                data: parsed
            });
        } else {
            console.log(`\n      ⚠️  Batch ${batchNum}: JSON parsing failed after all repair attempts`);
            batchAnalyses.push({
                batchNumber: batchNum,
                messageCount: batch.length,
                startDate: batch[0].date,
                endDate: batch[batch.length - 1].date,
                data: {
                    products_mentioned: [],
                    pain_points: [],
                    topics: [],
                    questions: [],
                    key_insights: []
                }
            });
        }
        
        const delay = batches.length > 100 ? 500 : 200;
        await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    console.log(`\n   ✅ Analyzed ${batchAnalyses.length}/${batches.length} batches\n`);
    
    return batchAnalyses;
}

// ============================================================================
// 7. AGGREGATE BATCHES TO DAYS
// ============================================================================

function aggregateBatchesToDays(batchAnalyses) {
    console.log('   Aggregating batches into daily summaries...');
    
    const dayGroups = {};
    
    batchAnalyses.forEach(batch => {
        const day = batch.startDate.toISOString().split('T')[0];
        
        if (!dayGroups[day]) {
            dayGroups[day] = {
                day: day,
                batches: [],
                totalMessages: 0,
                products: {},
                painPoints: {},
                topics: {},
                questions: [],
                insights: []
            };
        }
        
        dayGroups[day].batches.push(batch.batchNumber);
        dayGroups[day].totalMessages += batch.messageCount;
        
        batch.data.products_mentioned?.forEach(p => {
            const key = p.name.toLowerCase().trim();
            if (!key || key.length < 2) return;
            
            if (!dayGroups[day].products[key]) {
                dayGroups[day].products[key] = {
                    name: p.name,
                    sentiments: [],
                    contexts: []
                };
            }
            dayGroups[day].products[key].sentiments.push(p.sentiment || 'neutral');
            
            if (p.context && dayGroups[day].products[key].contexts.length < 5) {
                dayGroups[day].products[key].contexts.push(p.context);
            }
        });
        
        batch.data.pain_points?.forEach(pp => {
            if (!pp || typeof pp !== 'string') return;
            const key = pp.toLowerCase().trim();
            if (key.length < 3) return;
            dayGroups[day].painPoints[key] = (dayGroups[day].painPoints[key] || 0) + 1;
        });
        
        batch.data.topics?.forEach(t => {
            if (!t || typeof t !== 'string') return;
            const key = t.toLowerCase().trim();
            if (key.length < 3) return;
            dayGroups[day].topics[key] = (dayGroups[day].topics[key] || 0) + 1;
        });
        
        if (batch.data.questions && Array.isArray(batch.data.questions)) {
            dayGroups[day].questions.push(...batch.data.questions.slice(0, 5));
        }
        
        if (batch.data.key_insights && Array.isArray(batch.data.key_insights)) {
            dayGroups[day].insights.push(...batch.data.key_insights.slice(0, 5));
        }
    });
    
    const dailySummaries = Object.values(dayGroups).map(day => ({
        day: day.day,
        totalMessages: day.totalMessages,
        batchesAnalyzed: day.batches.length,
        products: Object.values(day.products).map(p => ({
            name: p.name,
            mentions: p.sentiments.length,
            avgSentiment: calculateAvgSentiment(p.sentiments),
            contexts: p.contexts.slice(0, 3)
        })).sort((a, b) => b.mentions - a.mentions),
        painPoints: Object.entries(day.painPoints)
            .map(([issue, count]) => ({ issue, count }))
            .sort((a, b) => b.count - a.count),
        topics: Object.entries(day.topics)
            .map(([topic, count]) => ({ topic, count }))
            .sort((a, b) => b.count - a.count),
        keyQuestions: [...new Set(day.questions)].slice(0, 10),
        keyInsights: [...new Set(day.insights)].slice(0, 10)
    })).sort((a, b) => a.day.localeCompare(b.day));
    
    console.log(`   ✅ Created ${dailySummaries.length} daily summaries\n`);
    
    return dailySummaries;
}

// ============================================================================
// 8. AGGREGATE DAYS TO WEEKS (HYBRID PROMPTS)
// ============================================================================

async function aggregateDaysToWeeks(dailySummaries, analyzer) {
    console.log('   Aggregating daily summaries into weekly...');
    
    const weekGroups = {};
    
    dailySummaries.forEach(day => {
        const date = new Date(day.day);
        const year = date.getFullYear();
        const week = getWeekNumber(date);
        const key = `${year}-W${String(week).padStart(2, '0')}`;
        
        if (!weekGroups[key]) {
            weekGroups[key] = {
                week: key,
                days: [],
                totalMessages: 0
            };
        }
        
        weekGroups[key].days.push(day);
        weekGroups[key].totalMessages += day.totalMessages;
    });
    
    const weeklySummaries = [];
    
    for (const [weekLabel, weekData] of Object.entries(weekGroups)) {
        console.log(`      Week ${weekLabel}...`);
        
        const daysSummary = weekData.days.map(day => {
            const topProducts = day.products.slice(0, 5).map(p => `${p.name}(${p.mentions})`).join(', ') || 'none';
            const topIssues = day.painPoints.slice(0, 3).map(p => p.issue).join('; ') || 'none';
            return `${day.day}: ${day.totalMessages} messages. Products: ${topProducts}. Issues: ${topIssues}`;
        }).join('\n');
        
        const prompt = `Summary of week ${weekLabel} from Russian-language fintech community chat (${weekData.totalMessages} messages).

Daily summaries:
${daysSummary}

Based on daily data create weekly summary in JSON (field names in English, content in Russian):
{
  "top_products": [{"name":"...", "sentiment":"...", "trend":"rising/falling/stable"}],
  "recurring_issues": ["повторяющаяся проблема"],
  "emerging_topics": ["новая тема недели"],
  "week_mood": "positive/negative/neutral/mixed",
  "notable_changes": ["что изменилось за неделю"]
}

JSON only, no explanations.`;

        const response = await analyzer.analyzeRaw(prompt);
        
        const parsed = tryRepairJson(response);
        if (parsed) {
            weeklySummaries.push({
                week: weekLabel,
                totalMessages: weekData.totalMessages,
                daysAnalyzed: weekData.days.length,
                dailyDetails: weekData.days,
                weekSummary: parsed
            });
        } else {
            console.log(`         ⚠️  Week ${weekLabel}: JSON parsing failed after all repair attempts`);
            weeklySummaries.push({
                week: weekLabel,
                totalMessages: weekData.totalMessages,
                daysAnalyzed: weekData.days.length,
                dailyDetails: weekData.days,
                weekSummary: {
                    top_products: [],
                    recurring_issues: [],
                    emerging_topics: [],
                    week_mood: 'neutral',
                    notable_changes: []
                }
            });
        }
    }
    
    console.log(`   ✅ Created ${weeklySummaries.length} weekly summaries\n`);
    
    return weeklySummaries;
}

// ============================================================================
// 9. CREATE MONTH SUMMARY (HYBRID PROMPTS)
// ============================================================================

async function createMonthSummary(weeklySummaries, analyzer, monthLabel) {
    console.log('   Creating final monthly summary...');
    
    if (weeklySummaries.length === 0) {
        console.log('   ⚠️  No weekly summaries to aggregate');
        return {
            executive_summary: 'Недостаточно данных для месячной сводки',
            top_products_month: [],
            major_issues: [],
            trending_topics: [],
            sentiment_evolution: 'unknown',
            key_events: [],
            month_mood: 'neutral'
        };
    }
    
    const weeksSummary = weeklySummaries.map(w => {
        const topProducts = w.weekSummary.top_products?.slice(0, 5).map(p => p.name).join(', ') || 'n/a';
        const issues = w.weekSummary.recurring_issues?.slice(0, 3).join('; ') || 'n/a';
        return `${w.week}: ${w.totalMessages} messages. Products: ${topProducts}. Issues: ${issues}. Mood: ${w.weekSummary.week_mood || 'neutral'}`;
    }).join('\n');
    
    const totalMessages = weeklySummaries.reduce((sum, w) => sum + w.totalMessages, 0);
    
    const prompt = `Create final summary for month ${monthLabel} from Russian-language fintech community chat (${totalMessages} messages).

Weekly summaries:
${weeksSummary}

Synthesize monthly picture in JSON (field names in English, content in Russian):
{
  "executive_summary": "краткая суть месяца в 2-3 предложениях",
  "top_products_month": [{"name":"...", "sentiment":"...", "total_mentions_estimate":"high/medium/low", "key_developments":"что произошло с продуктом за месяц"}],
  "major_issues": ["главная проблема месяца с описанием"],
  "trending_topics": ["актуальная тема месяца"],
  "sentiment_evolution": "как менялось настроение: начало→середина→конец",
  "key_events": ["важное событие месяца если было"],
  "month_mood": "positive/negative/neutral/mixed"
}

JSON only, no explanations.`;

    const response = await analyzer.analyzeRaw(prompt);
    
    const parsed = tryRepairJson(response);
    if (parsed) {
        return parsed;
    } else {
        console.log(`   ⚠️  Monthly summary parsing failed after all repair attempts`);
    }
    
    return {
        executive_summary: `Месяц ${monthLabel} с ${totalMessages} сообщениями проанализирован`,
        top_products_month: [],
        major_issues: [],
        trending_topics: [],
        sentiment_evolution: 'стабильное',
        key_events: [],
        month_mood: 'neutral'
    };
}

// ============================================================================
// 10. EXHAUSTIVE MONTH ANALYSIS
// ============================================================================

async function exhaustiveMonthAnalysis(month, analyzer) {
    const title = `EXHAUSTIVE ANALYSIS: ${month.monthLabel}`;
    const messageInfo = `Messages: ${month.messages.length}`;
    
    console.log(`\n╔${'═'.repeat(58)}╗`);
    console.log(`║  📊 ${title.padEnd(52)}║`);
    console.log(`║  ${messageInfo.padEnd(56)}║`);
    console.log(`╚${'═'.repeat(58)}╝`);
    
    const startTime = Date.now();
    
    console.log('\n[1/4] Batch analysis (every message counted)...');
    const batchAnalyses = await exhaustiveBatchAnalysis(month.messages, analyzer, 40);
    
    console.log('\n[2/4] Aggregating into daily summaries...');
    const dailySummaries = aggregateBatchesToDays(batchAnalyses);
    
    console.log('\n[3/4] Aggregating into weekly summaries...');
    const weeklySummaries = await aggregateDaysToWeeks(dailySummaries, analyzer);
    
    console.log('\n[4/4] Creating final monthly summary...');
    const monthSummary = await createMonthSummary(weeklySummaries, analyzer, month.monthLabel);
    
    const duration = Math.round((Date.now() - startTime) / 1000 / 60);
    
    console.log(`\n✅ Month ${month.monthLabel} analyzed in ${duration} minutes`);
    console.log(`   • Batches: ${batchAnalyses.length}`);
    console.log(`   • Days: ${dailySummaries.length}`);
    console.log(`   • Weeks: ${weeklySummaries.length}`);
    
    return {
        monthLabel: month.monthLabel,
        totalMessages: month.messages.length,
        analysisTime: `${duration} minutes`,
        batches: batchAnalyses,
        dailySummaries: dailySummaries,
        weeklySummaries: weeklySummaries,
        monthSummary: monthSummary,
        coverage: `${batchAnalyses.length * 80} messages analyzed (~${Math.round(batchAnalyses.length * 80 / month.messages.length * 100)}%)`
    };
}

// ============================================================================
// 11. AGGREGATE ALL MONTHS
// ============================================================================

function aggregateAllMonths(monthlyAnalyses) {
    console.log('   Aggregating all months...');
    
    const products = {};
    const painPoints = {};
    const topics = {};
    
    monthlyAnalyses.forEach(month => {
        month.monthSummary?.top_products_month?.forEach(p => {
            const name = p.name?.toLowerCase();
            if (!name) return;
            
            if (!products[name]) {
                products[name] = {
                    name: p.name,
                    mentions: 0,
                    sentiments: []
                };
            }
            products[name].mentions++;
            products[name].sentiments.push(p.sentiment || 'neutral');
        });
        
        month.monthSummary?.major_issues?.forEach(issue => {
            if (!issue || typeof issue !== 'string') return;
            const key = issue.toLowerCase();
            painPoints[key] = (painPoints[key] || 0) + 1;
        });
        
        month.monthSummary?.trending_topics?.forEach(topic => {
            if (!topic || typeof topic !== 'string') return;
            const key = topic.toLowerCase();
            topics[key] = (topics[key] || 0) + 1;
        });
    });
    
    return {
        topProducts: Object.values(products)
            .map(p => ({
                name: p.name,
                totalMentions: p.mentions,
                avgSentiment: calculateAvgSentiment(p.sentiments)
            }))
            .sort((a, b) => b.totalMentions - a.totalMentions),
        topPainPoints: Object.entries(painPoints)
            .map(([issue, frequency]) => ({ issue, frequency }))
            .sort((a, b) => b.frequency - a.frequency),
        topTopics: Object.entries(topics)
            .map(([topic, count]) => ({ topic, count }))
            .sort((a, b) => b.count - a.count)
    };
}

// ============================================================================
// 12. FULL EXHAUSTIVE ANALYSIS
// ============================================================================

async function fullExhaustiveAnalysis(messages, analyzer) {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║  📊 EXHAUSTIVE ANALYSIS OF ENTIRE CHAT HISTORY        ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');
    
    const monthlyGroups = groupByMonth(messages);
    console.log(`📅 Total months: ${monthlyGroups.length}`);
    console.log(`📨 Total messages: ${messages.length}\n`);
    
    const startTime = Date.now();
    const monthlyAnalyses = [];
    
    for (let i = 0; i < monthlyGroups.length; i++) {
        const month = monthlyGroups[i];
        const analysis = await exhaustiveMonthAnalysis(month, analyzer);
        monthlyAnalyses.push(analysis);
        
        console.log(`\n${'═'.repeat(60)}`);
        console.log(`Progress: ${i+1}/${monthlyGroups.length} months`);
        console.log(`${'═'.repeat(60)}\n`);
    }
    
    console.log('📊 Aggregating all months...\n');
    const aggregated = aggregateAllMonths(monthlyAnalyses);
    
    console.log('📊 Creating global summary of entire history...\n');
    const globalSummary = await createGlobalSummary(monthlyAnalyses, analyzer);
    
    const totalDuration = Math.round((Date.now() - startTime) / 1000 / 60);
    
    fs.writeFileSync('full_exhaustive_analysis.json', JSON.stringify({
        analysisType: 'exhaustive',
        analysisDate: new Date().toISOString(),
        totalDuration: `${totalDuration} minutes`,
        summary: {
            totalMonths: monthlyGroups.length,
            totalMessages: messages.length,
            totalBatches: monthlyAnalyses.reduce((sum, m) => sum + m.batches.length, 0)
        },
        monthly: monthlyAnalyses,
        aggregated: aggregated,
        globalSummary: globalSummary
    }, null, 2));
    
    displayExhaustiveResults(monthlyAnalyses, aggregated, globalSummary, totalDuration);
    
    console.log('\n✅ Full exhaustive analysis completed!');
    console.log(`   Time: ${totalDuration} minutes (${(totalDuration/60).toFixed(1)} hours)`);
    console.log(`   File: full_exhaustive_analysis.json\n`);
}

async function createGlobalSummary(monthlyAnalyses, analyzer) {
    const monthsSummaries = monthlyAnalyses.map(m => 
        `${m.monthLabel}: ${m.totalMessages} messages. ${m.monthSummary?.executive_summary || 'n/a'}`
    ).join('\n');
    
    const prompt = `Create final summary of entire Russian-language fintech community chat history.

Monthly summaries:
${monthsSummaries}

Create JSON summary (field names in English, content in Russian):
{
  "overall_narrative": "общая история развития сообщества",
  "most_discussed_products": [{"name":"...", "why":"причина популярности"}],
  "persistent_issues": ["проблема которая не решалась"],
  "community_evolution": "как менялось сообщество со временем",
  "key_milestones": ["важное событие в истории чата"]
}

JSON only, no explanations.`;

    const response = await analyzer.analyzeRaw(prompt);
    
    const parsed = tryRepairJson(response);
    if (parsed) return parsed;
    console.log(`   ⚠️  Global summary parsing failed after all repair attempts`);
    
    return {
        overall_narrative: 'Сводка обсуждений финтех-сообщества',
        most_discussed_products: [],
        persistent_issues: [],
        community_evolution: 'Сообщество развивалось со временем',
        key_milestones: []
    };
}

function displayExhaustiveResults(monthlyAnalyses, aggregated, globalSummary, duration) {
    console.log('\n' + '═'.repeat(60));
    console.log('📊 EXHAUSTIVE ANALYSIS RESULTS');
    console.log('═'.repeat(60));
    
    console.log(`\n⏱️  Total time: ${duration} minutes (${(duration/60).toFixed(1)} hours)`);
    console.log(`📊 Months analyzed: ${monthlyAnalyses.length}`);
    console.log(`📨 Total messages: ${monthlyAnalyses.reduce((sum, m) => sum + m.totalMessages, 0)}`);
    console.log(`📦 Total batches: ${monthlyAnalyses.reduce((sum, m) => sum + m.batches.length, 0)}`);
    
    if (globalSummary) {
        console.log(`\n📖 Community history:`);
        console.log(`   ${globalSummary.overall_narrative}`);
        
        if (globalSummary.most_discussed_products && globalSummary.most_discussed_products.length > 0) {
            console.log(`\n🏆 Most discussed products:`);
            globalSummary.most_discussed_products.slice(0, 10).forEach((p, i) => {
                console.log(`   ${i+1}. ${p.name} - ${p.why}`);
            });
        }
        
        if (globalSummary.persistent_issues && globalSummary.persistent_issues.length > 0) {
            console.log(`\n⚠️  Persistent issues:`);
            globalSummary.persistent_issues.forEach((issue, i) => {
                console.log(`   ${i+1}. ${issue}`);
            });
        }
    }
    
    if (aggregated && aggregated.topProducts.length > 0) {
        console.log(`\n🏦 Top products (aggregated):`);
        aggregated.topProducts.slice(0, 15).forEach((p, i) => {
            const icon = p.avgSentiment === 'positive' ? '✅' : p.avgSentiment === 'negative' ? '❌' : '➖';
            console.log(`   ${i+1}. ${p.name} (${p.totalMentions}x) ${icon}`);
        });
    }
    
    console.log(`\n📈 Monthly dynamics (last 6 months):`);
    monthlyAnalyses.slice(-6).forEach(m => {
        console.log(`\n   ${m.monthLabel} (${m.totalMessages} messages):`);
        if (m.monthSummary && m.monthSummary.executive_summary) {
            console.log(`      ${m.monthSummary.executive_summary}`);
        }
    });
}

// ============================================================================
// 13. FAST ANALYSIS (HYBRID PROMPTS)
// ============================================================================

async function fastMonthAnalysis(month, analyzer) {
    console.log(`\n📊 Fast analysis: ${month.monthLabel} (${month.messages.length} messages)`);
    
    const sample = intelligentSample(month.messages, 160);
    console.log(`   Sampled ${sample.length} representative messages`);
    
    const prompt = `Analyze month ${month.monthLabel} from Russian-language fintech community chat (${month.messages.length} messages total, showing 160 representative).

Messages in Russian:
${sample.map(m => `${m.author}: ${m.text.substring(0, 150)}`).join('\n')}

Extract in JSON (field names in English, content in Russian):
{
  "products_mentioned": [{"name":"...", "sentiment":"positive/negative/neutral"}],
  "pain_points": ["проблема"],
  "topics": ["тема"],
  "overall_mood": "positive/negative/neutral/mixed",
  "key_insights": ["инсайт"]
}

JSON only, no explanations.`;

    const response = await analyzer.analyzeRaw(prompt);
    
    const parsed = tryRepairJson(response);
    if (parsed) {
        return {
            monthLabel: month.monthLabel,
            totalMessages: month.messages.length,
            sampledMessages: sample.length,
            data: parsed
        };
    } else {
        console.log(`   ⚠️  Parsing failed after all repair attempts`);
    }
    
    return {
        monthLabel: month.monthLabel,
        totalMessages: month.messages.length,
        sampledMessages: sample.length,
        data: {
            products_mentioned: [],
            pain_points: [],
            topics: [],
            overall_mood: 'neutral',
            key_insights: []
        }
    };
}

async function fullFastAnalysis(messages, analyzer) {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║  ⚡ FAST ANALYSIS (sampling-based)                     ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');
    
    const monthlyGroups = groupByMonth(messages);
    console.log(`📅 Total months: ${monthlyGroups.length}`);
    console.log(`📨 Total messages: ${messages.length}\n`);
    
    const startTime = Date.now();
    const monthlyInsights = [];
    
    for (let i = 0; i < monthlyGroups.length; i++) {
        const month = monthlyGroups[i];
        const analysis = await fastMonthAnalysis(month, analyzer);
        monthlyInsights.push(analysis);
        console.log(`   ✅ ${month.monthLabel} completed`);
    }
    
    const totalDuration = Math.round((Date.now() - startTime) / 1000 / 60);
    
    const aggregated = aggregateFastResults(monthlyInsights);
    
    fs.writeFileSync('fast_analysis.json', JSON.stringify({
        analysisType: 'fast',
        analysisDate: new Date().toISOString(),
        totalDuration: `${totalDuration} minutes`,
        summary: {
            totalMonths: monthlyGroups.length,
            totalMessages: messages.length
        },
        monthly: monthlyInsights,
        aggregated: aggregated
    }, null, 2));
    
    displayFastResults(monthlyInsights, aggregated, totalDuration);
    
    console.log('\n✅ Fast analysis completed!');
    console.log(`   Time: ${totalDuration} minutes`);
    console.log(`   File: fast_analysis.json\n`);
}

function aggregateFastResults(monthlyInsights) {
    const products = {};
    const painPoints = {};
    const topics = {};
    
    monthlyInsights.forEach(month => {
        month.data.products_mentioned?.forEach(p => {
            const name = p.name?.toLowerCase();
            if (!name) return;
            
            if (!products[name]) {
                products[name] = { name: p.name, sentiments: [] };
            }
            products[name].sentiments.push(p.sentiment || 'neutral');
        });
        
        month.data.pain_points?.forEach(pp => {
            if (!pp || typeof pp !== 'string') return;
            const key = pp.toLowerCase();
            painPoints[key] = (painPoints[key] || 0) + 1;
        });
        
        month.data.topics?.forEach(t => {
            if (!t || typeof t !== 'string') return;
            const key = t.toLowerCase();
            topics[key] = (topics[key] || 0) + 1;
        });
    });
    
    return {
        topProducts: Object.values(products)
            .map(p => ({
                name: p.name,
                mentions: p.sentiments.length,
                avgSentiment: calculateAvgSentiment(p.sentiments)
            }))
            .sort((a, b) => b.mentions - a.mentions),
        topPainPoints: Object.entries(painPoints)
            .map(([issue, count]) => ({ issue, count }))
            .sort((a, b) => b.count - a.count),
        topTopics: Object.entries(topics)
            .map(([topic, count]) => ({ topic, count }))
            .sort((a, b) => b.count - a.count)
    };
}

function displayFastResults(monthlyInsights, aggregated, duration) {
    console.log('\n' + '═'.repeat(60));
    console.log('⚡ FAST ANALYSIS RESULTS');
    console.log('═'.repeat(60));
    
    console.log(`\n⏱️  Total time: ${duration} minutes`);
    console.log(`📊 Months analyzed: ${monthlyInsights.length}`);
    
    console.log(`\n🏦 Top products:`);
    aggregated.topProducts.slice(0, 15).forEach((p, i) => {
        const icon = p.avgSentiment === 'positive' ? '✅' : p.avgSentiment === 'negative' ? '❌' : '➖';
        console.log(`   ${i+1}. ${p.name} (${p.mentions}x) ${icon}`);
    });
    
    console.log(`\n⚠️  Top pain points:`);
    aggregated.topPainPoints.slice(0, 15).forEach((p, i) => {
        console.log(`   ${i+1}. ${p.issue} (${p.count}x)`);
    });
    
    console.log(`\n📌 Top topics:`);
    aggregated.topTopics.slice(0, 15).forEach((t, i) => {
        console.log(`   ${i+1}. ${t.topic} (${t.count}x)`);
    });
}

// ============================================================================
// 14. INTERACTIVE MODE (with search mode selector)
// ============================================================================

async function interactiveMode(rag, analyzer) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║  🤖 RAG Chat Analyzer - Interactive Mode              ║');
    console.log('╚════════════════════════════════════════════════════════╝');
    console.log(`\nCurrent search mode: ${rag.searchMode}`);
    console.log('\nCommands:');
    console.log('  - Ask questions about the chat (in Russian or English)');
    console.log('  - "/mode simple" - switch to simple search (30 messages)');
    console.log('  - "/mode adaptive" - switch to adaptive search (~160 messages)');
    console.log('  - "/mode twopass" - switch to two-pass search (best quality)');
    console.log('  - "exit" or "quit" to exit\n');
    
    const askQuestion = () => {
        rl.question('💬 Question: ', async (query) => {
            if (!query.trim()) {
                askQuestion();
                return;
            }
            
            if (query.toLowerCase() === 'exit' || query.toLowerCase() === 'quit') {
                console.log('\n👋 Goodbye!\n');
                rl.close();
                return;
            }
            
            // Handle mode switching
            if (query.toLowerCase().startsWith('/mode ')) {
                const mode = query.substring(6).trim();
                try {
                    rag.setSearchMode(mode);
                } catch (e) {
                    console.log(`❌ ${e.message}\n`);
                }
                askQuestion();
                return;
            }
            
            console.log('\n🔍 Searching for relevant messages...');
            const results = await rag.search(query, analyzer.contextLimit);
            
            if (results.length === 0) {
                console.log('   ⚠️  No relevant messages found\n');
                askQuestion();
                return;
            }
            
            const simRange = `${results[0].similarity.toFixed(3)} - ${results[results.length-1].similarity.toFixed(3)}`;
            console.log(`   Found: ${results.length} messages (similarity: ${simRange})`);
            
            if (results[0].score) {
                const scoreRange = `${results[0].score.toFixed(3)} - ${results[results.length-1].score.toFixed(3)}`;
                console.log(`   Score range: ${scoreRange}`);
            }
            
            console.log('\n📝 Context (top 5):');
            results.slice(0, 5).forEach((item, i) => {
                const preview = item.message.text.substring(0, 60).replace(/\n/g, ' ');
                const scoreInfo = item.score ? ` [score: ${item.score.toFixed(3)}]` : '';
                console.log(`   [${i+1}] ${item.message.author}${scoreInfo}: ${preview}...`);
            });
            
            console.log('\n🧠 Analyzing via LM Studio...\n');
            const answer = await analyzer.analyze(query, results);
            
            console.log('─'.repeat(60));
            console.log(answer);
            console.log('─'.repeat(60));
            console.log('');
            
            askQuestion();
        });
    };
    
    askQuestion();
}

// ============================================================================
// 15. MAIN
// ============================================================================

async function main() {
    const args = process.argv.slice(2);
    const chatPath = 'chat_export.json';
    const indexPath = 'chat_index.json';
    
    const rag = new ChatRAG();
    const analyzer = new LMStudioAnalyzer('http://localhost:1234/v1', 12288);
    
    // Check for search mode override
    const modeArg = args.find(arg => arg.startsWith('--mode='));
    if (modeArg) {
        const mode = modeArg.split('=')[1];
        try {
            rag.setSearchMode(mode);
        } catch (e) {
            console.error(`❌ ${e.message}`);
            process.exit(1);
        }
    }
    
    if (!fs.existsSync(chatPath)) {
        console.error(`❌ File ${chatPath} not found!`);
        console.log('Place your Telegram export in current directory and name it chat_export.json\n');
        process.exit(1);
    }
    
    const indexDirPath = indexPath.replace('.json', '_chunks');
    if ((fs.existsSync(indexPath) || fs.existsSync(indexDirPath)) && !args.includes('--rebuild')) {
        console.log('📦 Found saved index\n');
        await rag.loadIndex(indexPath);
    } else {
        const loader = new TelegramChatLoader(chatPath);
        const messages = loader.load();
        
        if (messages.length === 0) {
            console.error('❌ No messages found for indexing!');
            process.exit(1);
        }
        
        await rag.initialize(messages);
        rag.saveIndex(indexPath);
    }
    
    if (args.includes('--build-only')) {
        console.log('✅ Index built. Exiting.\n');
        return;
    }
    
    if (args.includes('--exhaustive')) {
        await fullExhaustiveAnalysis(rag.messages, analyzer);
    } else if (args.includes('--fast')) {
        await fullFastAnalysis(rag.messages, analyzer);
    } else {
        await interactiveMode(rag, analyzer);
    }
}

main().catch(error => {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
});