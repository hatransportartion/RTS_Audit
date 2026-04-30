# RTS Audit

Automates pulling RTS Financial reports into Airtable. Supports multiple RTS accounts and two report types:

- **Purchases** — RTS Pro Purchase Report → 6 RTS amount fields per matched Airtable load.
- **Payments** — RTS Pro Payments Report → payment date, check #, activity type, and check amount per matched Airtable load.

## Stack

- **Playwright** — browser automation (Auth0 login, navigation, downloads)
- **xlsx** — parses the Excel files RTS exports
- **Airtable REST API** — record lookup + updates (`airtable.js`)
- **dotenv** — credentials from `.env`

## Setup

1. Install dependencies:
   ```bash
   npm install
   npx playwright install chromium
   ```

2. Create `.env`:
   ```
   RTS_USER=...
   RTS_PASS=...

   RTS_CHANDI_USER=...
   RTS_CHANDI_PASS=...

   RTS_313_USER=...
   RTS_313_PASS=...

   AIRTABLE_TOKEN=pat_your_personal_access_token
   ```

3. (Optional) Adjust `CONFIG` in `index.js`:
   - `airtable.baseId`, `airtable.tableId`
   - `airtable.dispatchField`, `loadField`, `customerField`, `collectField` — fields used for matching
   - `airtable.fieldMap` — Excel → Airtable field name map
   - `selectors.*` — Playwright selectors (most marked `// TODO: confirm` if RTS UI changes)

## Running

There are six runner functions exported at the bottom of `index.js`. Pick one by uncommenting it (and commenting the others):

```js
const DATE_RANGE = '01/01/2026 – 01/31/2026';

// === PURCHASES (writes 6 RTS amount fields) ===
// runRTSDefault(DATE_RANGE).catch(...);
// runRTSChandi(DATE_RANGE).catch(...);
// runRTS313(DATE_RANGE).catch(...);

// === PAYMENTS (writes payment date / check # / activity type / check amount) ===
runPaymentsRTSDefault(DATE_RANGE).catch(...);
// runPaymentsRTSChandi(DATE_RANGE).catch(...);
// runPaymentsRTS313(DATE_RANGE).catch(...);
```

Then:
```bash
npm run dev
```

The first run for each account opens a non-headless Chromium, autofills credentials, and waits for you to confirm login (so 2FA / consent screens can be handled). On confirmation the session is persisted to `auth-<account>.json` so subsequent runs skip login.

> **Note on the date format**: the date input on the RTS page uses an en-dash (`–`), not a hyphen. Keep `DATE_RANGE` formatted exactly like `MM/DD/YYYY – MM/DD/YYYY`.

## Accounts

Each account in `ACCOUNTS` (top of `index.js`) maps to its own env-var pair and storage-state file:

| Key       | Display name  | Env vars                          | Auth file              |
| --------- | ------------- | --------------------------------- | ---------------------- |
| `default` | RTS Default   | `RTS_USER`, `RTS_PASS`            | `auth-default.json`    |
| `chandi`  | RTS Chandi    | `RTS_CHANDI_USER`, `RTS_CHANDI_PASS` | `auth-chandi.json`  |
| `313`     | RTS 313       | `RTS_313_USER`, `RTS_313_PASS`    | `auth-313.json`        |

## Purchases flow

1. Navigate to `/factoring/reports/purchase-report`.
2. Set date range, click View.
3. Set rows-per-page to 100.
4. For each row: click → click the download icon → save Excel → parse → store in an in-memory Map keyed by Excel `Invoice #`.
5. Click View between rows to refresh the list.
6. Push the Map to Airtable.

**Matching strategy** — Excel `Invoice #` may be either Airtable `Dispatch #` (5 digits) or `Load Number` (any length):

1. Fetch records where `Dispatch #` OR `Load Number` matches the invoice (deduped by record ID).
2. Verify each candidate using:
   - **Fuzzy customer match** — token-overlap ratio of Excel `Customer` vs Airtable `Customer` (drops company-suffix stopwords like `inc`, `llc`, `dba`).
   - **Collect amount match** — Excel `Invoice Amount` vs Airtable `Collect` (1¢ tolerance).
3. A candidate scores `customerSim + (collectMatch ? 1 : 0)`. Threshold: `0.5`.

Records that match by number but fail verification are reported as **Ambiguous**. Invoices with no number match are reported as **Unmatched**.

**Fields written** (mapped via `CONFIG.airtable.fieldMap`):

| Excel column     | Airtable field        |
| ---------------- | --------------------- |
| `Held Amount`    | `RTS Held Amount`     |
| `Denied Amount`  | `RTS Denied Amount`   |
| `Days Due`       | `RTS Days Dues`       |
| `Fee`            | `RTS Fee`             |
| `Reserve Escrow` | `RTS Reserve Escrow`  |
| `Funded Amount`  | `RTS Funded Amount`   |

## Payments flow

1. Navigate to `/factoring/reports/payments-report`.
2. Set date range, click View.
3. Wait ~8s for report to render.
4. Click the page-level download icon — a single Excel containing all payment rows for the range.
5. Parse → build a Map keyed by `Invoice Number` (falling back to `Load Number`).
6. Push to Airtable.

**Matching strategy** — same dual-key lookup (`Dispatch #` OR `Load Number`). Each match takes the first candidate and updates it. (See note in `pushPaymentsToAirtable` if you want to add fuzzy debtor / amount verification later.)

**Fields written:**

| Excel column     | Airtable field      |
| ---------------- | ------------------- |
| `Payment Date`   | `RTS Payment Date`  |
| `Check Number`   | `RTS Check Number`  |
| `Activity Type`  | `RTS Activity Type` |
| `Check Amount`   | `RTS Check Amount`  |

Empty cells in the Excel are skipped so existing Airtable values aren't overwritten with blanks.

## Files

| File                | Purpose                                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| `index.js`          | Main entrypoint — Playwright flow, Excel parsing, Airtable orchestration      |
| `airtable.js`       | Airtable REST helpers: `getRecords`, `getRecordsByField`, `updateRecords`     |
| `auth-*.json`       | Persisted Playwright storage state per account (auto-created after login)     |
| `.env`              | RTS credentials + Airtable PAT (gitignored)                                   |
| `downloads/`        | Saved Excel files + diagnostic screenshots (gitignored)                       |
| `package.json`      | Dependencies + `npm run dev` script                                           |

## Notes

- **Never commit `.env` or `auth-*.json`.** `.gitignore` covers both.
- If RTS rotates the session, delete the relevant `auth-*.json` and re-run — autofill will re-establish.
- Geolocation is pre-granted to `rtspro.com` to suppress the location prompt.
- The download capture relies on Playwright's `acceptDownloads: true` browser context.
- If a date filter doesn't appear to take effect (you keep getting the same row count for different months), check the `[filter] Input value after typing:` log to confirm the new value reached the input.
- Records updated successfully but invisible in your Airtable view? The view's filter is hiding them — check the table without the view filter to confirm `RTS *` fields are populated.
