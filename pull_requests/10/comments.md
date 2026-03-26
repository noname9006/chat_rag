## Updated requirements from user

Please expand the scope of `convert_to_doc.js` to produce **three outputs** instead of one.

### 1. Full Markdown doc (`full_analysis.md`)
As originally specified — full dynamic walk of the JSON, all sections.

### 2. Concise summary Markdown (`full_analysis_summary.md`)
A short ~5–10 page highlights-only doc. Extract only:
- **Top-level stats**: total messages, date range, chat name, participant count
- **Top 10 topics** by frequency/relevance (truncate the rest)
- **Top 10 most active participants** by message count (truncate the rest)
- **Key insights**: maximum 10 items
- **Monthly timeline**: full monthly message counts table (grouped by YYYY-MM, no day/week breakdown)
- **Top 5 reacted messages** by total reaction count

Keep it under ~500 lines. Skip raw chunks, Q&A threads, and verbose sub-arrays.

### 3. Interactive HTML file (`full_analysis.html`)
A self-contained single HTML file (no external dependencies, inline CSS only):
- Clean readable style (font, spacing, subtle colors)
- Every top-level section as a `<details><summary>` collapsible panel — collapsed by default
- Tables for arrays of objects (topics, participants, timeline)
- Bullet lists for string arrays
- Long text in blockquote style
- "Expand All / Collapse All" toggle button (pure inline JS, no libraries)
- Sticky header with chat name and generation date
- Monthly timeline as a proper HTML table

### Updated `package.json` scripts
```json
"convert": "node convert_to_doc.js",
"convert:summary": "node convert_to_doc.js --summary",
"convert:html": "node convert_to_doc.js --html",
"convert:all": "node convert_to_doc.js --all"
```

Default (no flag) = full Markdown only. `--all` generates all three outputs at once.

### Timeline (reminder)
Monthly granularity only — `YYYY-MM` grouped table, no day or week rows.