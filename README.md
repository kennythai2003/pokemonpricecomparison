# 🃏 Card Price Tracker

Fetch US & JP prices from PriceCharting in parallel — way faster than Google Apps Script.

## Setup (one time)

1. Install dependencies:
   ```
   npm install
   ```

2. Start the server:
   ```
   npm start
   ```

3. Open your browser to: **http://localhost:3000**

## How to use

1. In Google Sheets: **File → Download → Comma Separated Values (.csv)**
2. Drop the CSV onto the website
3. Map your columns (name, set, US link, JP link) — it auto-guesses based on column names
4. Click **⚡ Fetch All Prices**
5. Results show instantly as batches complete
6. Export back to CSV if needed

## Why it's faster

- Fetches all URLs **in parallel** (no sleep delays)
- No Google Apps Script quota limits
- Runs locally on your machine
