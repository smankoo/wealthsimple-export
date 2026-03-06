# Wealthsimple Transaction Exporter for YNAB

A Firefox extension that adds CSV export buttons to Wealthsimple account pages. Transactions are exported in YNAB-compatible format.

## What it does

Adds "Export CSV" buttons (This Month, Last 3 Months, All Time) to the Activity section on Wealthsimple account detail pages. Clicking a button fetches all completed transactions for that account via Wealthsimple's GraphQL API and downloads a CSV file.

## CSV format

The exported CSV uses YNAB's expected format:

```
Date,Payee,Memo,Amount
2026-03-02,Jane Doe,Interac e-Transfer from Jane Doe,1500.00
2026-03-01,Wealthsimple,Interest payment,12.34
2026-02-20,ACME Corp,Bill pay,-150.00
```

- Date: `YYYY-MM-DD`
- Amount: signed (negative = outflow, positive = inflow)
- No currency symbols or thousands separators

## Supported transaction types

- Interac e-Transfers (in/out)
- Bill payments
- Direct deposits (AFT)
- EFT transfers
- Internal transfers between Wealthsimple accounts
- Credit card purchases, refunds, payments
- Cashback rewards
- Interest payments
- Stock/ETF/Crypto buy/sell orders
- Dividends
- P2P payments
- Prepaid purchases

## Installation

### From Firefox Add-ons (recommended)

Install from [addons.mozilla.org](https://addons.mozilla.org/en-CA/firefox/addon/wealthsimple-export/).

### Manual / Development

1. Clone this repo
2. Open `about:debugging#/runtime/this-firefox` in Firefox
3. Click "Load Temporary Add-on"
4. Select `manifest.json` from this directory

## Building the .xpi

The `.xpi` is just a zip file with `manifest.json` at the root:

```bash
zip -r wealthsimple-export.xpi manifest.json content.js icons/ LICENSE README.md
```

Or use Mozilla's `web-ext` tool for validation + build:

```bash
npx web-ext build
```

This outputs a `.zip` in `web-ext-artifacts/`. AMO accepts both `.zip` and `.xpi`.

## How it works

The extension runs as a content script on `my.wealthsimple.com`. It reads the OAuth token from your existing session cookie and calls Wealthsimple's GraphQL API to fetch transaction data. No data is sent anywhere — everything stays in your browser and the CSV is generated locally.

## Privacy

This extension does not collect, store, or transmit any user data. All processing happens locally in your browser. The only network requests are to Wealthsimple's own API using your existing authenticated session.

## License

MIT
