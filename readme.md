# Telegram Chat RAG Analyzer

Exhaustive RAG-based analyzer for Telegram chat history with LM Studio integration. Designed for deep analysis of large chat datasets (100k+ messages) with maximum accuracy.

## Features

- ✅ **Exhaustive Analysis**: Every message counted, hierarchical aggregation (batches → days → weeks → months)
- ✅ **Fast Analysis**: Smart sampling for quick overview (minutes instead of hours)
- ✅ **Interactive RAG**: Ask questions about chat history with semantic search
- ✅ **Pure JavaScript**: No native dependencies, works on any platform
- ✅ **Chunked Storage**: Handles large datasets (100k+ messages) without memory issues
- ✅ **LM Studio Integration**: Uses local LLM for privacy and cost efficiency

## Requirements

- **Node.js**: >=18.0.0
- **LM Studio**: Running local LLM server
- **RAM**: 8GB+ recommended
- **Disk**: ~2-5GB for index storage

## Installation
```bash
npm install
```

## Setup

### 1. Export Telegram Chat

1. Open Telegram Desktop
2. Select chat → ⋮ → Export chat history
3. Format: JSON
4. Save as `chat_export.json` in project directory

### 2. Configure LM Studio

1. Download and install [LM Studio](https://lmstudio.ai/)
2. Load a model (recommended: `ruadapt_qwen2.5_3B` or `Qwen2.5-7B-Instruct`)
3. Go to **Local Server** tab
4. Set **Context Length**: `12288`
5. Click **Start Server** (default port: 1234)

### 3. Verify LM Studio
```bash
curl http://localhost:1234/v1/models
```

Should return JSON with model info.

## Usage

### Build Index (First Time)
```bash
npm run build-index
```

Creates vector index from chat history. Takes 10-30 minutes depending on message count.

### Exhaustive Analysis (Maximum Accuracy)
```bash
npm run analysis:exhaustive
```

**Features:**
- Analyzes every message in 120-message batches
- Hierarchical aggregation: batches → days → weeks → months → global summary
- Complete coverage, no sampling
- Output: `full_exhaustive_analysis.json`

**Time:** ~10 minutes per month (~6-8 hours for 30 months)

**Best for:** Final analysis, maximum accuracy, detailed reports

### Fast Analysis (Quick Overview)
```bash
npm run analysis:fast
```

**Features:**
- Smart sampling (160 representative messages per month)
- Quick aggregation
- Output: `fast_analysis.json`

**Time:** ~1-2 minutes per month (~30-60 minutes for 30 months)

**Best for:** Exploratory analysis, quick insights, testing

### Interactive Mode (Ask Questions)
```bash
npm start
# or with explicit mode
node rag.js --mode=simple
node rag.js --mode=adaptive
node rag.js --mode=twopass
```

**Search modes:**
- `simple` — single semantic query, fast
- `adaptive` — adjusts search strategy based on question complexity
- `twopass` — two-stage search for deeper context retrieval

**Commands inside interactive session:**
- `/mode simple` — switch to simple mode
- `/mode adaptive` — switch to adaptive mode
- `/mode twopass` — switch to two-pass mode
- `exit` — quit

**Example queries:**
- "What do people say about Revolut?"
- "What were the main complaints about Wise?"
- "Who recommended Interactive Brokers and why?"
- "What tax-related issues were discussed?"

> **Note:** Interactive mode works independently from exhaustive analysis — it uses the vector index (chunks), not `full_exhaustive_analysis.json`. You can run interactive queries while exhaustive analysis is running, or after it completes.

## Project Structure
```
telegram-chat-rag-analyzer/
├── package.json              # Dependencies and scripts
├── rag.js                    # Main application
├── compact_analysis.js       # Compact Markdown report generator (no LLM)
├── convert_to_doc.js         # Convert analysis JSON to documents
├── README.md                 # This file
├── chat_export.json          # Your Telegram export (place here)
├── chat_index_chunks/        # Vector index (auto-generated)
│   ├── manifest.json
│   ├── messages.json
│   ├── metadata.json
│   └── vectors_*.json
├── full_exhaustive_analysis.json  # Exhaustive analysis output
└── fast_analysis.json             # Fast analysis output
```

## Post-processing Tools

### Compact Report (no LLM required)
```bash
npm run compact
```

Converts `full_exhaustive_analysis.json` or `fast_analysis.json` to a concise Markdown report.
No LLM needed — pure deterministic transformation.

**Options:**
- `--top-n N` — number of items in aggregated lists (default: 10)
- `--no-weekly` — skip weekly summaries in monthly sections
- `--dry-run` — preview without writing file

**Output:** `full_exhaustive_analysis_compact.md`

### Convert to Document
```bash
npm run convert          # Full Markdown
npm run convert:summary  # Highlights only
npm run convert:html     # Interactive HTML (collapsible sections)
npm run convert:all      # All three formats
```

Converts analysis JSON to human-readable documents. Works with both exhaustive and fast analysis output.

## Output Format

### Exhaustive Analysis
```json
{
  "analysisType": "exhaustive",
  "analysisDate": "2026-03-23T...",
  "totalDuration": "360 minutes",
  "summary": {
    "totalMonths": 30,
    "totalMessages": 149469,
    "totalBatches": 1245
  },
  "monthly": [
    {
      "monthLabel": "2023-08",
      "totalMessages": 5234,
      "analysisTime": "30 minutes",
      "coverage": "5280 messages analyzed (~100%)",
      "weeklySummaries": [
        {
          "week": "2023-08-W1",
          "totalMessages": 1200,
          "weekSummary": {
            "week_narrative": "...",
            "top_products": [...],
            "key_issues": [...]
          }
        }
      ],
      "monthSummary": {
        "executive_summary": "...",
        "top_products_month": [...],
        "major_issues": [...],
        "trending_topics": [...],
        "month_mood": "mixed"
      }
    }
  ],
  "globalSummary": {
    "overall_narrative": "...",
    "most_discussed_products": [...],
    "persistent_issues": [...],
    "community_evolution": "...",
    "key_milestones": [...]
  }
}
```

### Fast Analysis
```json
{
  "analysisType": "fast",
  "monthly": [...],
  "aggregated": {
    "topProducts": [
      {"name": "revolut", "mentions": 89, "avgSentiment": "positive"}
    ],
    "topPainPoints": [...],
    "topTopics": [...]
  }
}
```

## Configuration

### Change Context Limit

Edit `rag.js`:
```javascript
const analyzer = new LMStudioAnalyzer('http://localhost:1234/v1', 12288);
//                                                                    ↑
//                                                            Change this value
```

**Recommended values:**
- `8192` - For 6-7GB VRAM GPUs
- `12288` - For 8GB VRAM GPUs (default)
- `16384` - For 12GB+ VRAM GPUs

### Change Batch Size

Edit `rag.js` line in `exhaustiveMonthAnalysis`:
```javascript
const batchAnalyses = await exhaustiveBatchAnalysis(month.messages, analyzer, 40);
//                                                                             ↑
//                                                                    Adjust batch size
```

**Trade-offs:**
- Larger batches (80-120): Faster analysis, less granular
- Smaller batches (20-30): Slower analysis, more detailed

### Change LM Studio URL

Edit `rag.js`:
```javascript
const analyzer = new LMStudioAnalyzer('http://localhost:1234/v1', 12288);
//                                     ↑
//                            Change host/port if needed
```

## Performance Tips

### For Large Datasets (100k+ messages)

1. **Increase Node.js memory:**
```bash
   node --max-old-space-size=8192 rag.js --exhaustive
```

2. **Run overnight:** Exhaustive analysis takes hours - start before sleep

3. **Monitor VRAM:** Use Task Manager (GPU Memory) to check LM Studio usage

### For Faster Analysis

1. **Use smaller model:** 3B parameters instead of 7B+
2. **Reduce context:** Lower from 12288 to 8192
3. **Use fast mode:** `npm run analysis:fast`

## Troubleshooting

### "Index directory not found"

Run `npm run build-index` first to create vector index.

### "LM Studio connection error"

1. Check LM Studio is running
2. Verify server started on port 1234
3. Test: `curl http://localhost:1234/v1/models`

### "Invalid string length" during index save

Dataset too large for single JSON. Code automatically uses chunked storage, but if error persists:
1. Increase Node.js memory: `--max-old-space-size=8192`
2. Or split dataset into smaller time periods

### Slow analysis

1. **Check VRAM usage:** If >95%, model might be offloading to RAM
2. **Reduce context:** Lower `contextLimit` to 8192 or 4096
3. **Use smaller model:** Try 3B parameters instead of 7B+
4. **Check batch size:** Larger batches = faster but less detailed

### Out of memory

1. Increase Node.js memory limit
2. Close other applications
3. Use fast analysis instead of exhaustive

## Analysis Strategies Comparison

| Strategy | Time (30 months) | Accuracy | Coverage | Best For |
|----------|------------------|----------|----------|----------|
| **Exhaustive** | 6-8 hours | ⭐⭐⭐⭐⭐ | 100% | Final reports, maximum accuracy |
| **Fast** | 30-60 minutes | ⭐⭐⭐⭐ | ~5% sampled | Quick insights, exploration |
| **Interactive** | Per query | ⭐⭐⭐⭐ | Relevant only | Specific questions, deep dives (uses vector index, independent of exhaustive) |

## Recommended Workflow

```bash
# 1. First run: build the vector index
npm run build-index

# 2. Optional: quick overview (30–60 min)
npm run analysis:fast

# 3. Full analysis overnight (6–8 hours)
npm run analysis:exhaustive

# 4. Generate compact report (seconds, no LLM)
npm run compact

# 5. Interactive deep-dive: ask specific questions
npm start
```

The interactive mode and exhaustive analysis are **independent** — interactive uses the vector index (chunks), exhaustive uses LLM batch processing. You can run interactive queries while exhaustive analysis is running, or after it completes.

## Use Cases

### Community Management
- Identify recurring pain points
- Track product sentiment over time
- Find unanswered questions
- Monitor community mood

### Market Research
- Product popularity trends
- Competitor mentions and sentiment
- Feature requests aggregation
- Customer pain point analysis

### Support Analysis
- Common issues identification
- Support burden quantification
- FAQ generation from questions
- Issue priority ranking

## Advanced Usage

### Custom Analysis Prompts

Edit prompts in `rag.js` functions:
- `exhaustiveBatchAnalysis` - Batch-level extraction
- `aggregateDaysToWeeks` - Weekly summaries
- `createMonthSummary` - Monthly summaries
- `createGlobalSummary` - Global history summary

### Extend Output Format

Add fields to JSON structures returned by analysis functions. LLM will extract them if prompted correctly.

### Multi-Language Support

Change system prompts language - LLM adapts automatically. Embeddings support 100+ languages out of box.

## Contributing

This is a personal tool open-sourced for community benefit. Feel free to fork and adapt to your needs.

## License

MIT License - use freely, no attribution required.

## Acknowledgments

- **@xenova/transformers** - Transformers.js for embeddings
- **LM Studio** - Local LLM inference
- **Telegram** - Chat export functionality

---

**Author:** Evggen  
**Version:** 3.0.0  
**Last Updated:** March 2026