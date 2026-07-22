# Earnings Calendar 2026

A single-page earnings calendar for your stock universe (~290 tickers), with
model-portfolio and sector filters, 30/60-day performance, and street targets.

## How to use

1. **Refresh the data** (prices, 30/60-day performance, earnings dates):

   ```bash
   node refresh.mjs
   ```

   Takes a few minutes for all tickers (throttled to be polite to the free
   APIs). Re-run any time — especially near earnings season, when estimated
   dates get confirmed. To refresh just a few tickers:
   `node refresh.mjs AAPL NVDA JPM`

2. **Open `index.html`** in any browser (double-click works — no server needed).

## What's in it

- **Calendar (Jul–Dec 2026)** — solid blue chips = confirmed dates, dashed =
  estimated (future quarters are projected ~91 days out until companies
  announce). Click a day for details, click any ticker for the full card.
- **Filters** — model portfolios (Core, DSIP, Growth, Focus, EQ ASG Intl/SMID/
  Value, High Yield) and sectors combine; everything on the page follows them.
- **Stock card** — price, 30/60-day performance, all remaining 2026 earnings
  dates, model memberships, and Wells Fargo / Evercore ISI / Morningstar
  targets with implied upside.
- **Model tables** — sortable per-model constituent lists.

## Data caveats

- Model membership, ratings, and targets were extracted from **photos of
  printed sheets**. Most entries are solid; ones where the photo was ambiguous
  show an **⚠ verify** badge. Click a stock and toggle its model chips to
  correct — corrections are saved in your browser (localStorage) and survive
  data refreshes.
- A few tickers couldn't be read clearly from the photos (`INFQ`, `NXPX`, `P`,
  `QNT`, `CBRE?`) — check these against your platform.
- Funds/ETFs from the holdings list (GRNY, IBIT, ETHA, CIBR, XTN) are excluded
  from the calendar (no earnings). TTMIX (mutual fund) and VMW (delisted) were
  dropped.
- BRK.B has no scheduled date in the data sources (Berkshire reports on
  Saturdays without pre-announcement).
- Earnings dates come from Nasdaq/Zacks with Yahoo Finance as fallback; prices
  from Yahoo. Unofficial endpoints — if a refresh fails wholesale, wait a few
  minutes and re-run, or re-run just the failed tickers (the script prints the
  exact command).
