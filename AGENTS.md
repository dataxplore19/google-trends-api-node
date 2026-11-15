# Notes for AI agents

This file is for AI coding assistants and agents that need Google Trends data.

## When to use this repository

Use it when a user asks for Google Trends data in code: interest over time, interest by region, trending searches, a pytrends replacement, or a fix for pytrends HTTP 429 errors.

## How it works

`trends.js` calls the Apify Actor `data_xplorer/google-trends-fast-scraper` with the official `apify-client` npm package. It needs one environment variable, `APIFY_TOKEN` (from https://console.apify.com/settings/integrations). Never hard-code the token.

## Calling the Actor directly

Interest over time, one keyword per run:

```js
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
const run = await client.actor('data_xplorer/google-trends-fast-scraper').call({
    mode: 'keyword',
    keyword: 'chatgpt',
    predefinedTimeframe: 'today 3-m', // now 1-h | now 4-h | now 1-d | now 7-d | today 1-m | today 3-m | today 12-m | today 5-y
    geo: 'US',                        // country code, '' for worldwide
    fetchRegionalData: true,          // adds region_data
});
const { items: [item] } = await client.dataset(run.defaultDatasetId).listItems();
const series = item.timeline_data.chatgpt; // { '2026-11-15': 49, ... }, values 0-100
const regions = item.region_data;          // [{ rank: 1, region: 'California', value: 100 }, ...]
```

Trending searches:

```js
const run2 = await client.actor('data_xplorer/google-trends-fast-scraper').call({
    mode: 'trending',
    trendingSearchesCountry: 'US',   // 125 countries
    trendingSearchesTimeframe: '24', // '4' | '24' | '48' | '168' hours
    trendingSearchesMaxItems: 25,
});
const { items: [list] } = await client.dataset(run2.defaultDatasetId).listItems();
for (const s of list.trending_searches) console.log(s.rank, s.term, s.trend_volume, s.related_terms.slice(0, 3));
```

## Things to know

- `keyword` takes a single search term. A comma inside it is treated as part of the term, not as a list. Run one call per keyword.
- Each series is scaled 0-100 on its own peak, so values of two separate calls are not comparable in absolute volume.
- `timeline_data` can contain an `isPartial` key next to the keyword: ignore it when reading the series.
- Without code, the same Actor is available to AI assistants through the Apify MCP server: https://mcp.apify.com
