# Climate change news aggregator scraper — AGENTS

This Actor aggregates climate change news from RSS/Atom feeds and site pages.

Features:
- RSS/Atom feed ingestion (fast, preferred).
- Topic/listing page crawling with heuristics to discover article links.
- Article metadata extraction: title, author, published_at, summary, tags.
- Optional full article extraction and storage in Key-Value store.
- Optional basic sentiment scoring for summaries/articles.
- Deduplication by URL or title (configurable).
- CheerioCrawler by default, PlaywrightCrawler optional for JS-heavy pages.

How to use
1) Provide feed URLs in `.actor/input_schema.json` or via the Actor input in Apify Console.
2) Add site start URLs for discovery pages (optional).
3) Configure keywords to tag results local to climate topics.
4) Run the Actor; results appear in the Dataset; full article JSON/text is in Key-Value store under `articles/<encoded-url>`.

Do / Don't
- Do respect the Terms of Service and robots.txt of target sites.
- Do prefer RSS feeds and official APIs where available.
- Don't bypass paywalls or scrape private/protected content.
- Don't store or publish copyrighted full-article text without permission; you may store for internal analysis if permitted.

Possible improvements (pick one)
- Add NLP summarization (GPT/OpenAI or local summarizer) to produce concise summaries.
- Add deduplication across runs (store canonical fingerprints in KV and skip duplicates).
- Add named-entity extraction (organizations, locations, people) and topical clustering.
- Add scheduling and time-series/backfill (build a timeline of coverage per topic).
- Add multilingual support and language detection.
- Add automated alerts (webhooks) for articles matching high-priority keywords.

Quick local setup
- npm install
- apify run

If you'd like, I can implement one of the improvements now (e.g., add summarization, incremental dedupe, entity extraction, or scheduling). Provide the number or describe custom changes.