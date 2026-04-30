import 'dotenv/config';
import { chromium } from 'playwright';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { getRecordsByField, updateRecords } from './airtable.js';

const DOWNLOADS_DIR = path.resolve('downloads');

const ACCOUNTS = {
  default: {
    name: 'RTS Default',
    user: process.env.RTS_USER,
    pass: process.env.RTS_PASS,
    authFile: 'auth-default.json',
  },
  chandi: {
    name: 'RTS Chandi',
    user: process.env.RTS_CHANDI_USER,
    pass: process.env.RTS_CHANDI_PASS,
    authFile: 'auth-chandi.json',
  },
  '313': {
    name: 'RTS 313',
    user: process.env.RTS_313_USER,
    pass: process.env.RTS_313_PASS,
    authFile: 'auth-313.json',
  },
};

const CONFIG = {
  loginUrl: 'https://rtspro.com/',
  purchaseReportUrl: 'https://rtspro.com/factoring/reports/purchase-report',
  paymentsReportUrl: 'https://rtspro.com/factoring/reports/payments-report',
  selectors: {
    username: 'input[name="username"]',
    password: 'input[name="password"]',
    submit: 'button[type="submit"]',
    dateRangeInput: 'input[placeholder*="MM/DD/AAAA"]',
    viewButton: 'button:has(span:text-is("View"))',
    purchaseRow: 'table tbody tr',                          // TODO: confirm purchase-report row selector
    downloadIcon: 'svg[data-testid="GetAppIcon"]',
    paginationNext: 'button[aria-label="Go to next page"]', // TODO: confirm — MUI default
    rowsPerPageDropdown: '.MuiTablePagination-select, [aria-haspopup="listbox"]', // TODO: confirm
    rowInvoiceCell: 'td:nth-child(2)', // TODO: confirm column index for Invoice #
  },
  rowsPerPage: 100,
  parallelDownloads: 3,
  dateRange: '04/21/2026 – 04/29/2026',
  airtable: {
    baseId: 'appFZQtRfsGDkCun4',
    tableId: 'tblO5X9igZQEzaWfw',
    dispatchField: 'Dispatch #', // 5-digit number
    loadField: 'Load Number',    // any length
    customerField: 'Customer',
    collectField: 'Collect',
    fieldMap: {
      heldAmount: 'RTS Held Amount',
      deniedAmount: 'RTS Denied Amount',
      daysDue: 'RTS Days Dues',
      fee: 'RTS Fee',
      reserveEscrow: 'RTS Reserve Escrow',
      fundedAmount: 'RTS Funded Amount',
      paymentDate: 'RTS Payment Date',
      checkNumber: 'RTS Check Number',
      activityType: 'RTS Activity Type',
      checkAmount: 'RTS Check Amount',
    },
  },
  viewport: { width: 1440, height: 900 },
};

async function waitForEnter(prompt) {
  const rl = readline.createInterface({ input, output });
  await rl.question(prompt);
  rl.close();
}

async function autofillLogin(page, account) {
  if (!account.user || !account.pass) {
    throw new Error(`Missing credentials for ${account.name} (set the RTS_*_USER and RTS_*_PASS env vars)`);
  }

  console.log(`[login] Autofilling credentials for ${account.name}...`);
  await page.waitForSelector(CONFIG.selectors.username, { timeout: 20000 });
  await page.fill(CONFIG.selectors.username, account.user);

  const passwordVisibleNow = await page
    .locator(CONFIG.selectors.password)
    .isVisible()
    .catch(() => false);

  if (!passwordVisibleNow) {
    console.log('[login] Clicking continue (identifier step)...');
    await page.click(CONFIG.selectors.submit);
    await page.waitForSelector(CONFIG.selectors.password, { timeout: 20000 });
  }

  console.log('[login] Filling password & submitting...');
  await page.fill(CONFIG.selectors.password, account.pass);
  await page.click(CONFIG.selectors.submit);
}

function isAuthUrl(url) {
  return /auth\.rtspro\.com|\/u\/login|\/authorize/i.test(url);
}

async function saveSession(context, label, authFile) {
  try {
    await context.storageState({ path: authFile });
    console.log(`[auth] Session saved to ${authFile} (${label}).`);
  } catch (err) {
    console.error(`[auth] Failed to save session (${label}):`, err.message);
  }
}

async function isLoginShown(page) {
  if (isAuthUrl(page.url())) return true;

  const candidates = [
    CONFIG.selectors.username,
    CONFIG.selectors.password,
    'input[type="password"]',
    'input[name="email"]',
    'input[type="email"]',
    'form[action*="login" i]',
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
  ];

  for (const sel of candidates) {
    const visible = await page.locator(sel).first().isVisible().catch(() => false);
    if (visible) {
      console.log(`[auth] Login indicator detected: ${sel}`);
      return true;
    }
  }
  return false;
}

async function dumpPageDiagnostics(page, label) {
  try {
    const title = await page.title().catch(() => '');
    const url = page.url();
    console.log(`[diag] (${label}) url=${url} title="${title}"`);

    const screenshotPath = path.join(DOWNLOADS_DIR, `diag-${label}-${Date.now()}.png`);
    if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[diag] Screenshot: ${screenshotPath}`);

    const inputs = await page.$$eval('input', (els) =>
      els.map((e) => ({
        name: e.name,
        type: e.type,
        id: e.id,
        placeholder: e.placeholder,
        visible: e.offsetParent !== null,
      })),
    );
    console.log(`[diag] Inputs on page:`, inputs.filter((i) => i.visible));
  } catch (err) {
    console.log(`[diag] Diagnostics failed: ${err.message}`);
  }
}

async function runLoginFlow(page, context, account) {
  console.log('[auth] Running autofill...');
  try {
    await autofillLogin(page, account);
  } catch (err) {
    console.error('[auth] Autofill error (will fall back to manual):', err.message);
  }

  try {
    await page.waitForURL((url) => !isAuthUrl(url.toString()), { timeout: 30000 });
    console.log(`[auth] Auto-redirected to: ${page.url()}`);
  } catch {
    console.log('[auth] Did not auto-redirect — finish login in the browser.');
  }

  console.log('\n>>> Make sure you are fully logged into the RTS app (not on the login page).');
  await waitForEnter('>>> Press ENTER here to save the session...\n');

  await saveSession(context, 'after-login', account.authFile);
}

async function navigateAuthenticated(page, context, targetUrl, account) {
  console.log(`[nav] Navigating to ${targetUrl}...`);
  await page.goto(targetUrl, { waitUntil: 'load' });
  await page.waitForTimeout(4000);
  console.log(`[nav] Landed at: ${page.url()}`);

  await dumpPageDiagnostics(page, 'after-nav');

  if (await isLoginShown(page)) {
    console.log('[nav] Login required.');
    await runLoginFlow(page, context, account);

    console.log(`[nav] Re-navigating to ${targetUrl}...`);
    await page.goto(targetUrl, { waitUntil: 'load' });
    await page.waitForTimeout(2000);
    console.log(`[nav] Final URL: ${page.url()}`);

    if (await isLoginShown(page)) {
      await dumpPageDiagnostics(page, 'still-login');
      throw new Error(`[nav] Still on login page after login flow — aborting.`);
    }
  }
}

async function launchBrowser(authFile) {
  const hasAuth = fs.existsSync(authFile);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: CONFIG.viewport,
    storageState: hasAuth ? authFile : undefined,
    permissions: ['geolocation'],
    geolocation: { latitude: 39.0997, longitude: -94.5786 },
  });
  await context.grantPermissions(['geolocation'], { origin: 'https://rtspro.com' });
  const page = await context.newPage();
  return { browser, context, page };
}

function parseMoney(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const cleaned = String(v).replace(/[$,\s]/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function setIfPresent(target, key, value) {
  if (value !== null && value !== undefined && value !== '') {
    target[key] = value;
  }
}

const COMPANY_STOPWORDS = new Set(['inc', 'llc', 'dba', 'co', 'ltd', 'the', 'and', 'corp', 'company']);

function tokenizeCustomer(s) {
  return new Set(
    String(s ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !COMPANY_STOPWORDS.has(t))
  );
}

function customerFuzzyScore(a, b) {
  const ta = tokenizeCustomer(a);
  const tb = tokenizeCustomer(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  const intersection = [...ta].filter((t) => tb.has(t));
  return intersection.length / Math.min(ta.size, tb.size);
}

function amountsMatch(a, b) {
  const na = parseMoney(a);
  const nb = parseMoney(b);
  if (na === null || nb === null) return false;
  return Math.abs(na - nb) < 0.01;
}

async function pushPurchasesToAirtable(purchaseMap) {
  const {
    baseId,
    tableId,
    dispatchField,
    loadField,
    customerField,
    collectField,
    fieldMap: fm,
  } = CONFIG.airtable;
  const invoiceNos = Array.from(purchaseMap.keys());

  if (invoiceNos.length === 0) {
    console.log('[airtable] No purchases collected — nothing to push.');
    return;
  }

  console.log(`[airtable] Fetching candidates by ${dispatchField} OR ${loadField}...`);
  const [byDispatch, byLoad] = await Promise.all([
    getRecordsByField(baseId, tableId, dispatchField, invoiceNos),
    getRecordsByField(baseId, tableId, loadField, invoiceNos),
  ]);

  const candidatesById = new Map();
  for (const r of [...byDispatch, ...byLoad]) candidatesById.set(r.id, r);
  const candidates = Array.from(candidatesById.values());
  console.log(`[airtable] ${candidates.length} candidate record(s) (deduped).`);

  const updates = [];
  const matched = new Set();
  const ambiguous = [];

  for (const [invoiceNo, purchase] of purchaseMap) {
    // Find candidates whose Dispatch # OR Load # equals this invoice
    const numberMatches = candidates.filter((c) => {
      const d = String(c.fields[dispatchField] ?? '').trim();
      const l = String(c.fields[loadField] ?? '').trim();
      return d === invoiceNo || l === invoiceNo;
    });

    if (numberMatches.length === 0) continue;

    // Verify each candidate with fuzzy customer + collect amount
    let best = null;
    let bestScore = -Infinity;
    let bestDetail = null;

    for (const c of numberMatches) {
      const custSim = customerFuzzyScore(purchase.customer, c.fields[customerField]);
      const collectOk = amountsMatch(purchase.invoiceAmount, c.fields[collectField]);
      const score = custSim + (collectOk ? 1 : 0);

      if (score > bestScore) {
        best = c;
        bestScore = score;
        bestDetail = { custSim, collectOk };
      }
    }

    // Confidence threshold: customer fuzzy >= 0.5 OR collect amount matches
    if (!best || bestScore < 0.5) {
      ambiguous.push({ invoiceNo, candidates: numberMatches.length, score: bestScore });
      continue;
    }

    matched.add(invoiceNo);
    console.log(
      `[airtable] ${invoiceNo} → ${best.id} (custSim=${bestDetail.custSim.toFixed(2)}, collect=${bestDetail.collectOk})`
    );

    const fields = {};
    setIfPresent(fields, fm.heldAmount, parseMoney(purchase.heldAmount));
    setIfPresent(fields, fm.deniedAmount, parseMoney(purchase.deniedAmount));
    setIfPresent(fields, fm.daysDue, parseMoney(purchase.daysDue));
    setIfPresent(fields, fm.fee, parseMoney(purchase.fee));
    setIfPresent(fields, fm.reserveEscrow, parseMoney(purchase.reserveEscrow));
    setIfPresent(fields, fm.fundedAmount, parseMoney(purchase.fundedAmount));

    if (Object.keys(fields).length === 0) continue;
    updates.push({ id: best.id, fields });
  }

  const unmatched = invoiceNos.filter((d) => !matched.has(d));
  console.log(`[airtable] Matched: ${updates.length}, Unmatched: ${unmatched.length}, Ambiguous: ${ambiguous.length}`);
  if (unmatched.length) console.log(`[airtable] Unmatched invoices:`, unmatched);
  if (ambiguous.length) console.log(`[airtable] Ambiguous (number matched but customer/collect didn't verify):`, ambiguous);

  if (updates.length === 0) {
    console.log('[airtable] Nothing to update.');
    return;
  }

  console.log(`[airtable] Updating ${updates.length} record(s) with 6 RTS fields...`);
  await updateRecords(baseId, tableId, updates);
  console.log(`[airtable] Update complete.`);
}

function parsePaymentsExcel(filePath) {
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  return rows.map((r) => ({
    invoiceNo: String(r['Invoice Number'] ?? r['Invoice #'] ?? '').trim(),
    loadNumber: String(r['Load Number'] ?? '').trim(),
    purchaseDate: r['Purchase Date'],
    paymentDate: r['Payment Date'],
    checkNumber: r['Check Number'],
    debtorName: r['Debtor Name'],
    feeDays: r['Fee Days'],
    invoiceAmount: r['Invoice Amount'],
    activityType: r['Activity Type'],
    checkAmount: r['Check Amount'],
  }));
}

async function pushPaymentsToAirtable(paymentsMap) {
  const { baseId, tableId, dispatchField, loadField, fieldMap: fm } = CONFIG.airtable;

  if (paymentsMap.size === 0) {
    console.log('[airtable] No payments collected — nothing to push.');
    return;
  }

  // Collect every invoice + load number we might need to look up
  const lookupKeys = new Set();
  for (const r of paymentsMap.values()) {
    if (r.invoiceNo) lookupKeys.add(r.invoiceNo);
    if (r.loadNumber) lookupKeys.add(r.loadNumber);
  }
  const allKeys = Array.from(lookupKeys);

  console.log(`[airtable] Fetching candidates by ${dispatchField} OR ${loadField}...`);
  const [byDispatch, byLoad] = await Promise.all([
    getRecordsByField(baseId, tableId, dispatchField, allKeys),
    getRecordsByField(baseId, tableId, loadField, allKeys),
  ]);

  const candidatesById = new Map();
  for (const r of [...byDispatch, ...byLoad]) candidatesById.set(r.id, r);
  const candidates = Array.from(candidatesById.values());
  console.log(`[airtable] ${candidates.length} candidate record(s) (deduped).`);

  const updates = [];
  const updatedRecordIds = new Set();
  const unmatched = [];

  for (const payment of paymentsMap.values()) {
    const inv = payment.invoiceNo;
    const load = payment.loadNumber;

    const matches = candidates.filter((c) => {
      const d = String(c.fields[dispatchField] ?? '').trim();
      const l = String(c.fields[loadField] ?? '').trim();
      return (inv && d === inv) || (load && l === load);
    });

    if (matches.length === 0) {
      unmatched.push(inv || load);
      continue;
    }

    const best = matches[0];
    if (updatedRecordIds.has(best.id)) continue;
    updatedRecordIds.add(best.id);

    const fields = {};
    setIfPresent(fields, fm.paymentDate, payment.paymentDate);
    setIfPresent(fields, fm.checkNumber, payment.checkNumber);
    setIfPresent(fields, fm.activityType, payment.activityType);
    setIfPresent(fields, fm.checkAmount, parseMoney(payment.checkAmount));

    if (Object.keys(fields).length === 0) continue;
    updates.push({ id: best.id, fields });
  }

  console.log(`[airtable] Matched: ${updates.length}, Unmatched: ${unmatched.length}`);
  if (unmatched.length) console.log(`[airtable] Unmatched payments:`, unmatched);

  if (updates.length === 0) {
    console.log('[airtable] Nothing to update.');
    return;
  }

  console.log(`[airtable] Updating ${updates.length} record(s) with payment date, check #, activity type & check amount...`);
  await updateRecords(baseId, tableId, updates);
  console.log(`[airtable] Update complete.`);
}

async function processPaymentsReport(page, context, account, dateRange) {
  ensureDownloadsDir();

  await navigateAuthenticated(page, context, CONFIG.paymentsReportUrl, account);
  await setDateRangeAndView(page, dateRange);

  console.log('[payments] Waiting 8s for the report to render...');
  await page.waitForTimeout(8000);

  const downloadBtn = page.locator(CONFIG.selectors.downloadIcon).first();
  await downloadBtn.waitFor({ state: 'visible', timeout: 15000 });

  console.log('[payments] Clicking download button...');
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await downloadBtn.click();
  const download = await downloadPromise;

  const filePath = path.join(DOWNLOADS_DIR, `payments-${Date.now()}.xlsx`);
  await download.saveAs(filePath);
  console.log(`[payments] Saved: ${filePath}`);

  const rows = parsePaymentsExcel(filePath);
  console.log(`[payments] Parsed ${rows.length} payment row(s).`);

  const paymentsMap = new Map();
  for (const r of rows) {
    const key = r.invoiceNo || r.loadNumber;
    if (key) paymentsMap.set(key, r);
  }

  console.log(`[payments] Final Map (${paymentsMap.size} entries):`);
  console.log(Object.fromEntries(paymentsMap));

  return paymentsMap;
}

function ensureDownloadsDir() {
  if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

async function downloadExcelForRow(page, row, idx) {
  console.log(`[download] Row ${idx + 1}: clicking row...`);
  await row.click().catch(() => {});
  await page.waitForTimeout(400);

  let downloadBtn = row.locator(CONFIG.selectors.downloadIcon).first();
  if ((await downloadBtn.count()) === 0) {
    // Icon may have appeared outside the row after expansion (modal / detail panel)
    downloadBtn = page.locator(CONFIG.selectors.downloadIcon).first();
  }

  console.log(`[download] Row ${idx + 1}: clicking download icon...`);
  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
  await downloadBtn.click();
  const download = await downloadPromise;

  const filePath = path.join(DOWNLOADS_DIR, `purchase-${idx + 1}-${Date.now()}.xlsx`);
  await download.saveAs(filePath);
  console.log(`[download] Saved: ${filePath}`);
  return filePath;
}

async function clickView(page) {
  console.log(`[filter] Clicking View button...`);
  const btn = page.locator(CONFIG.selectors.viewButton).first();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await btn.click();
  await page.waitForTimeout(2500);
}

async function setDateRangeAndView(page, range) {
  console.log(`[filter] Setting date range: ${range}`);
  const dateInput = page.locator(CONFIG.selectors.dateRangeInput).first();
  await dateInput.waitFor({ state: 'visible', timeout: 20000 });

  console.log(`[filter] Focusing input...`);
  await dateInput.click();
  await page.waitForTimeout(400);

  console.log(`[filter] Filling value...`);
  await dateInput.fill('');
  await dateInput.fill(range);
  await page.waitForTimeout(300);

  console.log(`[filter] Dismissing any open picker...`);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);

  await clickView(page);
}

async function goToNextPageIfAvailable(page) {
  const next = page.locator(CONFIG.selectors.paginationNext).first();
  if ((await next.count()) === 0) return false;
  const disabled = await next.isDisabled().catch(() => true);
  if (disabled) return false;
  console.log(`[purchase] Advancing to next page...`);
  await next.click();
  await page.waitForTimeout(2000);
  return true;
}

function parsePurchaseExcel(filePath) {
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  return rows.map((r) => ({
    status: r['Status'],
    invoiceNo: String(r['Invoice #'] ?? r['Invoice No'] ?? r['InvoiceNo'] ?? '').trim(),
    customer: r['Customer'],
    date: r['Date'],
    heldAmount: r['Held Amount'],
    deniedAmount: r['Denied Amount'],
    daysDue: r['Days Due'],
    invoiceAmount: r['Invoice Amount'],
    fee: r['Fee'],
    reserveEscrow: r['Reserve Escrow'],
    fundedAmount: r['Funded Amount'],
  }));
}

async function setRowsPerPage(page, n) {
  console.log(`[filter] Setting rows per page to ${n}...`);
  try {
    const dropdown = page.locator(CONFIG.selectors.rowsPerPageDropdown).last();
    if ((await dropdown.count()) === 0) {
      console.log('[filter] Rows-per-page dropdown not found — leaving default.');
      return false;
    }
    await dropdown.click();
    await page.waitForTimeout(500);

    const option = page.locator(`li[data-value="${n}"], li[role="option"]:has-text("${n}")`).first();
    await option.waitFor({ state: 'visible', timeout: 5000 });
    await option.click();
    await page.waitForTimeout(2000);
    console.log(`[filter] Rows per page set to ${n}.`);
    return true;
  } catch (err) {
    console.log(`[filter] Could not set rows per page automatically: ${err.message}`);
    return false;
  }
}

async function ingestExcelIntoMap(filePath, purchaseMap) {
  const parsed = parsePurchaseExcel(filePath);
  for (const r of parsed) {
    const key = String(r.invoiceNo).trim();
    if (key) purchaseMap.set(key, r);
  }
}

async function readRowInvoiceNumber(row) {
  const cell = row.locator(CONFIG.selectors.rowInvoiceCell).first();
  const text = await cell.innerText().catch(() => '');
  return text.trim();
}

async function clickViewAndWait(page) {
  const btn = page.locator(CONFIG.selectors.viewButton).first();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await btn.click();
  // Wait for the table rows to actually render before continuing
  await page
    .locator(CONFIG.selectors.purchaseRow)
    .first()
    .waitFor({ state: 'visible', timeout: 15000 })
    .catch(() => {});
  await page.waitForTimeout(1500);
}

async function downloadOneRow(page, idx, purchaseMap) {
  const rows = page.locator(CONFIG.selectors.purchaseRow);
  const row = rows.nth(idx);

  const rowInvoice = await readRowInvoiceNumber(row);
  if (rowInvoice && purchaseMap.has(rowInvoice)) return;

  let downloadBtn = row.locator(CONFIG.selectors.downloadIcon).first();
  let expanded = false;

  if (!(await downloadBtn.isVisible().catch(() => false))) {
    await row.click();
    await page.waitForTimeout(300);
    expanded = true;
    downloadBtn = page.locator(CONFIG.selectors.downloadIcon).first();
    await downloadBtn.waitFor({ state: 'visible', timeout: 10000 });
  }

  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
  await downloadBtn.click();
  const download = await downloadPromise;

  const filePath = path.join(DOWNLOADS_DIR, `purchase-${idx + 1}-${Date.now()}.xlsx`);
  await download.saveAs(filePath);
  await ingestExcelIntoMap(filePath, purchaseMap);

  if (expanded) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
  }
}

async function downloadAllRowsSequential(page, purchaseMap) {
  const total = await page.locator(CONFIG.selectors.purchaseRow).count();

  for (let i = 0; i < total; i++) {
    // Re-check current row count — the list may have re-rendered with fewer rows after a View click
    const currentTotal = await page.locator(CONFIG.selectors.purchaseRow).count();
    if (i >= currentTotal) {
      console.log(`Row ${i + 1} not present (current count: ${currentTotal}) — stopping.`);
      break;
    }

    try {
      await downloadOneRow(page, i, purchaseMap);
      console.log(`[map]`, Object.fromEntries(purchaseMap));
    } catch (err) {
      console.error(`Row ${i + 1} failed:`, err.message);
    }

    if (i < total - 1) {
      await clickViewAndWait(page);
    }
  }
}

async function processPurchaseReport(page, context, account, dateRange) {
  ensureDownloadsDir();

  await navigateAuthenticated(page, context, CONFIG.purchaseReportUrl, account);
  await setDateRangeAndView(page, dateRange);
  await setRowsPerPage(page, CONFIG.rowsPerPage);

  const purchaseMap = new Map();
  await downloadAllRowsSequential(page, purchaseMap);

  console.log(`\n[map] Final purchase Map (${purchaseMap.size} entries):`);
  console.log(Object.fromEntries(purchaseMap));

  return purchaseMap;
}

async function runForAccount(account, dateRange) {
  console.log(`\n=== Starting run for ${account.name} | range: ${dateRange} ===`);

  if (!account.user || !account.pass) {
    throw new Error(`Missing env vars for ${account.name}. Set credentials in .env first.`);
  }

  const { browser, context, page } = await launchBrowser(account.authFile);

  try {
    await navigateAuthenticated(page, context, CONFIG.loginUrl, account);

    const purchaseMap = await processPurchaseReport(page, context, account, dateRange);
    console.log(`\n[summary] ${account.name}: ${purchaseMap.size} purchases collected.`);

    await pushPurchasesToAirtable(purchaseMap);

    await saveSession(context, 'end-of-run', account.authFile);
    await waitForEnter(`\n>>> ${account.name} done. Press ENTER to close the browser...\n`);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function runRTSDefault(dateRange) {
  await runForAccount(ACCOUNTS.default, dateRange);
}

async function runRTSChandi(dateRange) {
  await runForAccount(ACCOUNTS.chandi, dateRange);
}

async function runRTS313(dateRange) {
  await runForAccount(ACCOUNTS['313'], dateRange);
}

async function runPaymentsForAccount(account, dateRange) {
  console.log(`\n=== Payments run for ${account.name} | range: ${dateRange} ===`);

  if (!account.user || !account.pass) {
    throw new Error(`Missing env vars for ${account.name}. Set credentials in .env first.`);
  }

  const { browser, context, page } = await launchBrowser(account.authFile);

  try {
    await navigateAuthenticated(page, context, CONFIG.loginUrl, account);

    const paymentsMap = await processPaymentsReport(page, context, account, dateRange);
    console.log(`\n[summary] ${account.name}: ${paymentsMap.size} payments collected.`);

    await pushPaymentsToAirtable(paymentsMap);

    await saveSession(context, 'end-of-run', account.authFile);
    await waitForEnter(`\n>>> ${account.name} payments done. Press ENTER to close the browser...\n`);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function runPaymentsRTSDefault(dateRange) {
  await runPaymentsForAccount(ACCOUNTS.default, dateRange);
}

async function runPaymentsRTSChandi(dateRange) {
  await runPaymentsForAccount(ACCOUNTS.chandi, dateRange);
}

async function runPaymentsRTS313(dateRange) {
  await runPaymentsForAccount(ACCOUNTS['313'], dateRange);
}

const DATE_RANGE = '04/01/2026 – 04/30/2026';

// === PURCHASES (writes 6 RTS amount fields per matched row) ===
// runRTSDefault(DATE_RANGE).catch((err) => { console.error('Fatal error:', err); process.exit(1); });
// runRTSChandi(DATE_RANGE).catch((err) => { console.error('Fatal error:', err); process.exit(1); });
// runRTS313(DATE_RANGE).catch((err) => { console.error('Fatal error:', err); process.exit(1); });

// === PAYMENTS (writes RTS Payment Date + RTS Check Number) ===
runPaymentsRTSDefault(DATE_RANGE).catch((err) => { console.error('Fatal error:', err); process.exit(1); });
// runPaymentsRTSChandi(DATE_RANGE).catch((err) => { console.error('Fatal error:', err); process.exit(1); });
// runPaymentsRTS313(DATE_RANGE).catch((err) => { console.error('Fatal error:', err); process.exit(1); });
