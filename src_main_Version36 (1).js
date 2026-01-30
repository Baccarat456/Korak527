// Climate change news aggregator scraper (RSS + site crawl + optional Playwright)
// - Parses RSS/Atom feeds (preferred), then scans start pages for article links.
// - Extracts metadata: title, author, published_at, summary, tags, keywords matched.
// - Optionally extracts full article body and computes a basic sentiment score.
// - Stores structured items in the Dataset and full article text/JSON in the Key-Value store.

import { Actor } from 'apify';
import { CheerioCrawler, PlaywrightCrawler, Dataset, KeyValueStore, RequestQueue } from 'crawlee';
import RSSParser from 'rss-parser';
import Sentiment from 'sentiment';
import { URL } from 'url';
import cheerio from 'cheerio';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
  rssFeeds = [],
  startUrls = [],
  keywords = [],
  maxRequestsPerCrawl = 500,
  useBrowser = false,
  deduplicateBy = 'url',
  extractFullArticle = true,
  computeSentiment = true,
  followInternalOnly = true,
  concurrency = 10,
} = input;

const proxyConfiguration = await Actor.createProxyConfiguration();
const dataset = await Dataset.open();
const kv = await KeyValueStore.open();
const sentiment = new Sentiment();
const rssParser = new RSSParser();
const requestQueue = await RequestQueue.open();

const seen = new Set(); // basic in-memory dedupe per-run (url or title)

// helper normalize key for deduplication
function dedupeKey(item) {
  if (deduplicateBy === 'title') return (item.title || '').trim().toLowerCase();
  return (item.url || '').trim();
}

// safe URL resolver
function resolveUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch (e) {
    return null;
  }
}

// simple extract summary from element: prefer meta description then first paragraph
function extractSummary($, url) {
  const meta = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
  if (meta && meta.length > 20) return meta.trim();
  const p = $('article p, .article-body p, .post-content p, p').filter((i, el) => $(el).text().trim().length > 40).first();
  return p ? p.text().trim().slice(0, 800) : '';
}

// keyword matching
function matchKeywords(text) {
  const matched = [];
  if (!text) return matched;
  const t = text.toLowerCase();
  for (const k of (keywords || [])) {
    if (k && t.includes(k.toLowerCase())) matched.push(k);
  }
  return matched;
}

// push structured dataset item with optional sentiment
async function saveItem(item) {
  const key = dedupeKey(item);
  if (seen.has(key)) return false;
  seen.add(key);
  if (computeSentiment) {
    try {
      const textForSentiment = item.summary || item.title || '';
      const s = sentiment.analyze(textForSentiment);
      item.sentiment_score = s.score;
      item.sentiment = { comparative: s.comparative, tokens: s.tokens ? s.tokens.slice(0, 20) : [] };
    } catch (e) {
      item.sentiment_score = null;
      item.sentiment = null;
    }
  }
  await dataset.pushData(item);
  return true;
}

// store full article in KV (key: articles/<encoded-url>)
async function storeFullArticle(url, obj) {
  try {
    await kv.setValue(`articles/${encodeURIComponent(url)}`, obj, { contentType: 'application/json' });
  } catch (e) {
    // ignore KV failures but log
    console.warn('KV setValue failed', e.message);
  }
}

// process RSS feeds (fast path)
async function processFeed(feedUrl) {
  try {
    const feed = await rssParser.parseURL(feedUrl);
    for (const entry of feed.items || []) {
      const url = entry.link || entry.guid || entry.id;
      const title = entry.title || '';
      const pub = entry.isoDate || entry.pubDate || '';
      const summary = entry.contentSnippet || entry.content || entry.summary || '';
      const source = feed.title || (new URL(feedUrl).hostname);
      const keywordsMatched = matchKeywords(`${title}\n${summary}`);
      const item = {
        title,
        source,
        published_at: pub,
        author: entry.creator || entry.author || '',
        summary: summary ? summary.slice(0, 800) : '',
        tags: entry.categories || [],
        keywords_matched: keywordsMatched,
        url,
        extracted_at: new Date().toISOString()
      };
      const saved = await saveItem(item);
      if (saved && extractFullArticle && url) {
        // enqueue article page for full body extraction
        await requestQueue.addRequest({ url, userData: { fromFeed: true } });
      }
    }
  } catch (e) {
    console.warn('Failed to parse feed', feedUrl, e.message);
  }
}

// article extraction using Cheerio
async function extractArticleCheerio({ request, $, log }) {
  const url = request.loadedUrl ?? request.url;
  log.info('Extracting article (cheerio)', { url });

  const title = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || $('title').text().trim();
  const author = $('meta[name="author"]').attr('content') || $('[rel="author"]').first().text().trim() || '';
  const published_at = $('meta[property="article:published_time"]').attr('content') || $('time').first().attr('datetime') || '';
  const summary = extractSummary($, url);
  const tags = $('meta[name="keywords"]').attr('content') ? $('meta[name="keywords"]').attr('content').split(',').map(s => s.trim()) : [];
  const text = (() => {
    const article = $('article, .article-body, .post-content').first();
    if (article && article.length) return article.text().replace(/\s+/g, ' ').trim().slice(0, 20000);
    // fallback: join first several paragraphs
    return $('p').map((i, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 20).join('\n\n').slice(0, 20000);
  })();
  const keywordsMatched = matchKeywords(`${title}\n${summary}\n${text}`);

  const item = {
    title,
    source: (() => { try { return new URL(url).hostname; } catch (e) { return ''; } })(),
    published_at,
    author,
    summary,
    tags,
    keywords_matched: keywordsMatched,
    url,
    extracted_at: new Date().toISOString()
  };

  const saved = await saveItem(item);
  if (saved && extractFullArticle) {
    await storeFullArticle(url, { title, author, published_at, text });
  }
}

// article extraction using Playwright (for JS-heavy pages)
async function extractArticlePlaywright({ page, request, log }) {
  const url = request.loadedUrl ?? request.url;
  log.info('Extracting article (playwright)', { url });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  const html = await page.content();
  const $ = cheerio.load(html);
  await extractArticleCheerio({ request, $, log });
}

// enqueue start pages
for (const u of startUrls || []) {
  await requestQueue.addRequest({ url: u, userData: { startHost: (() => { try { return new URL(u).host; } catch { return null; } })() } });
}

// process RSS feeds first
for (const f of rssFeeds || []) {
  if (f && f.url) {
    await processFeed(f.url);
  } else if (typeof f === 'string' && f.trim()) {
    await processFeed(f);
  }
}

// crawler options
const commonRequestHandler = async (ctx) => {
  const { request, $ } = ctx;
  const url = request.url;
  // find article links on listing/topic pages and enqueue them (respect followInternalOnly)
  const anchors = $('a[href]').map((i, el) => $(el).attr('href')).get().filter(Boolean);
  for (const href of anchors.slice(0, 500)) {
    const abs = resolveUrl(url, href);
    if (!abs) continue;
    try {
      if (followInternalOnly && request.userData.startHost) {
        if (new URL(abs).host !== request.userData.startHost) continue;
      }
    } catch (e) {}
    // heuristics: article url likely contains /news/, /2023/, /article, /2024/ etc or ends with a slug
    if (/\/(news|article|story|202[0-9]|202[0-9]\/|\/\d{4}\/\d{2}\/\d{2}\/)/i.test(abs) || /\/[^\/]+-[^\/]+$/i.test(abs)) {
      await requestQueue.addRequest({ url: abs, userData: { startHost: request.userData.startHost || (new URL(request.loadedUrl || request.url).host) } });
    }
  }
  // optionally extract articles from this page directly (some listing pages embed full posts)
  await extractArticleCheerio(ctx);
};

// choose crawler
if (!useBrowser) {
  const crawler = new CheerioCrawler({
    proxyConfiguration,
    requestQueue,
    maxRequestsPerCrawl,
    maxConcurrency: concurrency,
    requestHandlerTimeoutSecs: 60,
    async requestHandler(ctx) {
      await commonRequestHandler(ctx);
    }
  });

  // seed queue with items discovered from RSS
  // requests added earlier for feed articles
  await crawler.run();
} else {
  const crawler = new PlaywrightCrawler({
    launchContext: {},
    requestQueue,
    maxRequestsPerCrawl,
    maxConcurrency: Math.max(1, Math.floor(concurrency / 2)),
    requestHandlerTimeoutSecs: 120,
    async requestHandler(ctx) {
      const { page, request } = ctx;
      // enqueue links and extract article using Playwright
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      // enqueue article links from page
      const anchors = await page.$$eval('a[href]', els => els.map(a => a.getAttribute('href')));
      for (const href of anchors.slice(0, 500)) {
        const abs = resolveUrl(request.url, href);
        if (!abs) continue;
        try {
          if (followInternalOnly && request.userData.startHost) {
            if (new URL(abs).host !== request.userData.startHost) continue;
          }
        } catch (e) {}
        if (/\/(news|article|story|202[0-9]|\/\d{4}\/)/i.test(abs) || /\/[^\/]+-[^\/]+$/i.test(abs)) {
          await requestQueue.addRequest({ url: abs, userData: { startHost: request.userData.startHost || (new URL(request.url).host) } });
        }
      }
      // extract article content
      await extractArticlePlaywright(ctx);
    }
  });

  // run
  await crawler.run();
}

// graceful exit
await Actor.exit();