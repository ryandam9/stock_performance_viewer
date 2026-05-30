# ASX ETF EOD Explorer

A 100% client-side single-page application for exploring ASX ETF end-of-day data. It loads a SQLite database directly from S3 into the browser via [sql.js](https://github.com/sql-js/sql.js/) (SQLite compiled to WebAssembly) and renders interactive charts with [Plotly](https://plotly.com/javascript/). No backend, no build step — just open the HTML file.

## Features

- **Schema Explorer** — sidebar lists every table in the database with column names, types, and row counts. Click any table to jump to that ticker.
- **Explore** — pick a ticker (auto-discovered from the DB) and view its price history as a line, area, or candlestick chart. Period presets (1M/3M/6M/YTD/1Y/MAX) plus a custom date range. Stats cards show high, low, average volume, and price change.
- **Compare** — overlay multiple series on a single chart, optionally rebased to 100 for relative performance comparison across ETFs.
- **SQL Console** — run arbitrary SQL queries against the live database, view results in a table, or plot any two columns as x/y.
- **Column Auto-Detection** — automatically identifies date, open, high, low, close, volume, and symbol columns using flexible regex matching. Override manually if needed.
- **Multi-CDN Fallback** — loads Plotly and sql.js from multiple CDNs with automatic fallback if a source fails.
- **Dark Theme** — custom dark UI with green accent colors and a dark-on-dark chart theme.

## How it works

1. On load, the page fetches Plotly and sql.js from CDNs (with fallback).
2. It fetches a SQLite `.db` file from a configurable S3 URL (defaults to a bucket in `ap-southeast-2`).
3. sql.js loads the file into an in-memory SQLite database using WebAssembly.
4. The app introspects the schema, auto-detects tickers (supporting both "one table per ETF" and "one table with a symbol column" patterns), and populates the UI.

## Configuration

The S3 URL can be changed via the input field at the top of the page. The database object must be readable (public-read or presigned URL) and the bucket must have a CORS policy that allows the browser origin.

## CORS

Since the browser fetches the `.db` file directly from S3, the bucket must allow cross-origin requests. See the "CORS / fetch error" section in the app for the exact S3 CORS configuration to apply.
