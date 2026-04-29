# RTS Audit

Automates pulling RTS Financial purchase-report data into Airtable.

Logs into [rtspro.com](https://rtspro.com), opens the Purchase Report, downloads the per-purchase Excel files for the configured date range, parses them, and updates matching Airtable records with six RTS-side fields.

## Stack

- **Playwright** — browser automation (login, navigation, downloads)
- **xlsx** — parses the Excel files RTS exports
- **Airtable REST API** — record lookup + updates (via `airtable.js`)
- **dotenv** — credentials/secrets from `.env`

## Setup

1. Install dependencies:
   ```bash
   npm install
   npx playwright install chromium
   ```

2. Create a `.env` file at the project root:
   ```
   RTS_USER=your-rts-email@example.com
   RTS_PASS=your-rts-password
   AIRTABLE_TOKEN=pat_your_personal_access_token
   ```

3. (Optional) Adjust `CONFIG` in `index.js`:
   - `dateRange` — the date range to filter the Purchase Report by (e.g. `'04/21/2026 – 04/29/2026'`)
   - `airtable.baseId`, `tableId` — your Airtable base + table
   - `airtable.dispatchField`, `loadField`, `customerField`, `collectField` — fields used for matching
   - `airtable.fieldMap` — maps Excel columns to Airtable column names for the 6 RTS fields written back

## Usage

```bash
npm run dev
```

The first run launches a non-headless Chromium, autofills credentials, and waits for you to confirm login (so 2FA / consent screens can be handled). On confirmation, the session is persisted to `auth.json` so subsequent runs skip login.

Flow:

1. Open `https://rtspro.com/`
2. Navigate to `/factoring/reports/purchase-report`
3. Set the date range and click **View**
4. Set rows-per-page to 100
5. For each row: click → click the download icon → save Excel to `downloads/` → parse → store in an in-memory Map keyed by Invoice #
6. Click **View** between rows to refresh the list
7. Push the Map into Airtable (see matching strategy below)

## Matching strategy

The Excel `Invoice #` is sometimes the Airtable `Dispatch #` (5 digits) and sometimes the `Load Number` (any length). For each invoice the script:

1. Fetches Airtable records where `Dispatch #` equals the invoice OR `Load Number` equals the invoice (deduped).
2. Verifies each candidate using:
   - **Fuzzy customer match** — token-overlap ratio between Excel `Customer` and Airtable `Customer` (drops company-suffix stopwords like `inc`, `llc`, `dba`).
   - **Collect amount match** — Excel `Invoice Amount` compared to Airtable `Collect` (1¢ tolerance).
3. A candidate scores `customerSim + (collectMatch ? 1 : 0)`. Threshold: `0.5` (i.e. either the customer tokens overlap by ≥50% or the Collect amount matches exactly).

Records that match by number but fail verification are reported as **Ambiguous**. Invoices with no number match at all are reported as **Unmatched**.

## Fields written to Airtable

The six fields in `CONFIG.airtable.fieldMap` are populated from the Excel:

| Excel column        | Airtable field        |
| ------------------- | --------------------- |
| `Held Amount`       | `RTS Held Amount`     |
| `Denied Amount`     | `RTS Denied Amount`   |
| `Days Due`          | `RTS Days Dues`       |
| `Fee`               | `RTS Fee`             |
| `Reserve Escrow`    | `RTS Reserve Escrow`  |
| `Funded Amount`     | `RTS Funded Amount`   |

Empty cells in the Excel (e.g. on `Denied` rows) are skipped so existing Airtable values aren't overwritten with blanks.

## Files

| File           | Purpose                                                                       |
| -------------- | ----------------------------------------------------------------------------- |
| `index.js`     | Main entrypoint — Playwright flow, Excel parsing, Airtable orchestration      |
| `airtable.js`  | Airtable REST helpers: `getRecords`, `getRecordsByField`, `updateRecords`     |
| `headed.js`    | Standalone scratch script (manual login + work)                               |
| `auth.json`    | Persisted Playwright storage state (cookies/session) — recreated after login  |
| `.env`         | RTS credentials + Airtable PAT (not committed)                                |
| `downloads/`   | Saved Excel files + diagnostic screenshots (gitignored)                       |

## Notes

- `auth.json` and `.env` should never be committed.
- If RTS rotates the session, delete `auth.json` and re-run — autofill will re-establish.
- The `acceptDownloads: true` browser context is required for Playwright to capture the Excel downloads.
- Geolocation is pre-granted to `rtspro.com` to suppress the location prompt.
- Selectors marked `// TODO: confirm` in `CONFIG.selectors` may need adjustment if RTS changes their UI.
