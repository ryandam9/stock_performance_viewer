# ASX ETF EOD Explorer

A 100% client-side single-page application for exploring ASX ETF end-of-day data. It loads a SQLite database directly from S3 into the browser via [sql.js](https://github.com/sql-js/sql.js/) (SQLite compiled to WebAssembly) and renders interactive charts with [Plotly](https://plotly.com/javascript/). No backend, no build step — just open `explorer.html`.

## Features

- **Schema Explorer** — sidebar lists every table in the database with column names, types, and row counts. Click any table to jump to that ticker. The filter box is debounced.
- **Explore** — pick a ticker (auto-discovered from the DB) and view its price history as a line, area, or candlestick chart. Period presets (1M/3M/6M/YTD/1Y/MAX) plus a custom date range. Stats cards show high, low, average volume, and price change. Rows with unparseable dates are surfaced as a warning stat rather than silently dropped.
- **Compare** — overlay multiple series on a single chart, optionally rebased to 100 for relative performance comparison across ETFs.
- **SQL Console** — run arbitrary SQL queries against the live database, view results in a table, or plot any two columns as x/y.
- **Column Auto-Detection** — automatically identifies date, open, high, low, close, volume, and symbol columns using flexible regex matching. Override manually if needed.
- **Multi-CDN Fallback** — loads Plotly and sql.js from multiple CDNs with automatic fallback if a source fails.
- **Offline cache** — once a database has loaded successfully, a copy is kept in the browser's Cache API. If a later fetch fails (e.g. you're offline), the app falls back to that copy and flags it in the status bar. (Requires a secure context — `https://` or `localhost`; not available over `file://`.)
- **Dark Theme** — custom dark UI with green accent colors and a dark-on-dark chart theme.

## File layout

The app is intentionally dependency-free in the browser and split into three plain files (no bundler):

| File            | Purpose                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `explorer.html` | Markup only. Links the stylesheet and the two scripts.                                                                                                                         |
| `explorer.css`  | All styles.                                                                                                                                                                    |
| `lib.js`        | Pure, side-effect-free helpers (date parsing, formatting, column detection, validation). UMD-style so it loads as a browser `<script>` **and** `require()`s in Node for tests. |
| `app.js`        | UI logic. Depends on the DOM, Plotly, sql.js, and `window.ETFLib` (from `lib.js`).                                                                                             |

`lib.js` must load before `app.js`.

## How it works

1. On load, the page fetches Plotly and sql.js from CDNs (with fallback).
2. It fetches a SQLite `.db` file from a configurable S3 URL (defaults to a bucket in `ap-southeast-2`), streaming the download so progress is shown for large files.
3. sql.js loads the file into an in-memory SQLite database using WebAssembly.
4. The app introspects the schema, auto-detects tickers (supporting both "one table per ETF" and "one table with a symbol column" patterns), and populates the UI.

## Expected database format

Either layout works:

- **One table per ETF** — each table is a ticker (e.g. a `VAS` table) with at least a date column and a close/price column. OHLC + volume columns light up candlesticks and extra stats.
- **One table, many symbols** — a single table with a symbol/ticker column plus date and price columns; each distinct symbol becomes a selectable series.

Column names are matched case-insensitively (e.g. `Date`, `datetime`, `dt`; `Close`, `Adj Close`, `price`, `last`; `symbol`, `ticker`, `code`). Use the **Columns — override auto-detection** panel on the Explore tab if a column is mis-detected.

### A note on date formats

Ambiguous `DD/MM/YYYY` strings are interpreted as **Australian** order (day first), so `01/02/2023` is 1 February 2023. ISO `YYYY-MM-DD` and epoch seconds/milliseconds are also recognised. Anything else is counted and reported in the Explore stats as "Unparsed dates".

## Configuration

The S3 URL can be changed via the input field at the top of the page (validated before fetching). The database object must be readable (public-read or presigned URL) and the bucket must have a CORS policy that allows the browser origin.

## CORS

Since the browser fetches the `.db` file directly from S3, the bucket must allow cross-origin requests. See the "CORS / fetch error" section in the app for the exact S3 CORS configuration to apply.

## Security

All values that originate from the database or user input (table/column names, cell values, error messages, the source URL) are HTML-escaped or written via `textContent` before being inserted into the DOM, so a malicious database cannot inject script into the page.

## Development

The browser app needs no build step. Tooling is only for the test/lint workflow:

```bash
npm install        # one-time
npm test           # run the Vitest unit suite (covers lib.js)
npm run lint       # ESLint
npm run format     # Prettier (writes); format:check to verify only
```

Pure logic lives in `lib.js` and is unit-tested in `test/`. CI (`.github/workflows/ci.yml`) runs lint, format check, and tests on every push and pull request.
