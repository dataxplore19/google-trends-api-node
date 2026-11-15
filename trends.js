/**
 * Google Trends data in Node.js: interest over time, interest by region, and daily trending searches.
 *
 * Gets the data through the Apify Actor data_xplorer/google-trends-fast-scraper, so there is no
 * Google rate limit (HTTP 429) to handle on your side and no unofficial package to keep patched.
 *
 * Examples:
 *   node trends.js interest chatgpt "climate change" --geo US --timeframe "today 3-m"
 *   node trends.js interest bitcoin --geo FR --regions
 *   node trends.js trending --country US --hours 24 --watch "bitcoin,taylor swift"
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ApifyClient } from 'apify-client';

const ACTOR = 'data_xplorer/google-trends-fast-scraper';
const TIMEFRAMES = ['now 1-h', 'now 4-h', 'now 1-d', 'now 7-d', 'today 1-m', 'today 3-m', 'today 12-m', 'today 5-y'];

async function runActor(input) {
    const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
    const run = await client.actor(ACTOR).call(input);
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    return items;
}

const csvCell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLine = (cells) => `${cells.map(csvCell).join(',')}\n`;

function writeCsv(path, header, rows) {
    writeFileSync(path, csvLine(header) + rows.map(csvLine).join(''));
    console.log(`${rows.length} rows written to ${path}`);
}

/** Minimal CSV reader (handles quotes, commas and newlines inside cells). */
function readCsv(path) {
    const text = readFileSync(path, 'utf8');
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
            else if (c === '"') quoted = false;
            else cell += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
        else if (c !== '\r') cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const [header = [], ...body] = rows;
    return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/** Telegram message if TELEGRAM_TOKEN and TELEGRAM_CHAT_ID are set, console otherwise. */
async function notify(text) {
    const { TELEGRAM_TOKEN: token, TELEGRAM_CHAT_ID: chat } = process.env;
    if (!token || !chat) return console.log(text);
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text }),
    });
}

/** Interest over time (0-100) for each keyword, plus interest by region with --regions. */
async function interest(keywords, opts) {
    const timeline = [];
    const regions = [];
    for (const keyword of keywords) {
        const [item] = await runActor({
            mode: 'keyword',
            keyword,
            predefinedTimeframe: opts.timeframe,
            geo: opts.geo,
            fetchRegionalData: opts.regions,
        });
        if (!item) { console.log(`${keyword}: no data`); continue; }
        const series = Object.entries(item.timeline_data?.[keyword] ?? {});
        for (const [day, value] of series) timeline.push([day, keyword, value]);
        for (const r of item.region_data ?? []) regions.push([keyword, r.rank, r.region, r.value]);
        if (series.length) {
            const [peakDay, peak] = series.reduce((a, b) => (b[1] > a[1] ? b : a));
            const [lastDay, last] = series.at(-1);
            console.log(`${keyword}: peak ${peak} on ${peakDay}, latest ${last} on ${lastDay} (${item.data_granularity} data)`);
        }
    }
    writeCsv(opts.out, ['date', 'keyword', 'value'], timeline);
    if (opts.regions) writeCsv('interest_by_region.csv', ['keyword', 'rank', 'region', 'value'], regions);
}

/** Today's trending searches for a country. Alerts on new terms and on watched words. */
async function trending(opts) {
    const [item] = await runActor({
        mode: 'trending',
        trendingSearchesCountry: opts.country,
        trendingSearchesTimeframe: String(opts.hours),
        trendingSearchesMaxItems: Number(opts.max),
    });
    const searches = item?.trending_searches ?? [];

    const seen = new Set();
    if (existsSync(opts.out)) {
        for (const r of readCsv(opts.out)) if (r.country === opts.country) seen.add(r.term);
    } else {
        appendFileSync(opts.out, csvLine(['checkedAt', 'country', 'rank', 'term', 'volume', 'related']));
    }

    const watch = opts.watch.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
    const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

    for (const s of searches) {
        const related = s.related_terms ?? [];
        appendFileSync(opts.out, csvLine([now, opts.country, s.rank, s.term, s.trend_volume ?? '', related.slice(0, 5).join('; ')]));
        console.log(`${String(s.rank).padStart(3)}. ${s.term} (${s.trend_volume ?? '?'})`);

        const text = [s.term, ...related].join(' ').toLowerCase();
        const hits = watch.filter((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(w)}($|[^\\p{L}\\p{N}])`, 'u').test(text));
        if (hits.length) {
            await notify(`Google Trends ${opts.country}: '${s.term}' is trending (${s.trend_volume ?? '?'}), matches ${hits.join(', ')}`);
        } else if (opts['alert-new'] && seen.size && !seen.has(s.term)) {
            await notify(`New on Google Trends ${opts.country}: '${s.term}' (${s.trend_volume ?? '?'})`);
        }
    }
}

const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        geo: { type: 'string', default: '' },
        timeframe: { type: 'string', default: 'today 12-m' },
        regions: { type: 'boolean', default: false },
        country: { type: 'string', default: 'US' },
        hours: { type: 'string', default: '24' },
        max: { type: 'string', default: '25' },
        watch: { type: 'string', default: '' },
        'alert-new': { type: 'boolean', default: false },
        out: { type: 'string' },
    },
});

const [command, ...keywords] = positionals;
if (!process.env.APIFY_TOKEN) throw new Error('Set the APIFY_TOKEN environment variable.');

if (command === 'interest' && keywords.length) {
    if (!TIMEFRAMES.includes(opts.timeframe)) throw new Error(`--timeframe must be one of: ${TIMEFRAMES.join(', ')}`);
    await interest(keywords, { ...opts, out: opts.out ?? 'interest_over_time.csv' });
} else if (command === 'trending') {
    if (!['4', '24', '48', '168'].includes(opts.hours)) throw new Error('--hours must be 4, 24, 48 or 168');
    await trending({ ...opts, out: opts.out ?? 'trending_history.csv' });
} else {
    console.log('Usage:\n  node trends.js interest <keyword> [<keyword>...] [--geo US] [--timeframe "today 3-m"] [--regions]\n'
        + '  node trends.js trending [--country US] [--hours 24] [--max 25] [--watch "word1,word2"] [--alert-new]');
    process.exitCode = 1;
}
