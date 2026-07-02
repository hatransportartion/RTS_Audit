import cron from 'node-cron';
import { format, subDays, startOfMonth, startOfYear } from 'date-fns';
import pEachSeries from 'p-each-series';
import {
  runRTSDefault, runPaymentsRTSDefault, runRecoursedRTSDefault,
  runRTSChandi,  runPaymentsRTSChandi,  runRecoursedRTSChandi,
  runRTS313,     runPaymentsRTS313,     runRecoursedRTS313,
} from './index.js';

const MONTHLY_UPDATE = [
  ['runPaymentsRTSDefault',   runPaymentsRTSDefault],
  ['runPaymentsRTSChandi',   runPaymentsRTSChandi],
  ['runPaymentsRTS313',      runPaymentsRTS313],

];


const YEARLY_UPDATE = [
  ['runRTSDefault',           runRTSDefault],
  ['runRTSChandi',           runRTSChandi],
  ['runPaymentsRTSChandi',   runPaymentsRTSChandi],
  ['runRecoursedRTSChandi',  runRecoursedRTSChandi],
  ['runRTS313',              runRTS313],
  ['runRecoursedRTS313',     runRecoursedRTS313],
];

let isRunning = false;

// Build a "MM/dd/yyyy – MM/dd/yyyy" range string.
function buildRange(fromDate, toDate) {
  const from = format(fromDate, 'MM/dd/yyyy');
  const to = format(toDate, 'MM/dd/yyyy');
  return `${from} – ${to}`;
}

// Run a given set of tasks over a given range.
async function runTasks(tasks, range, label) {
  console.log(`\n========== ${label}: ${range} ==========`);

  await pEachSeries(tasks, async ([name, fn]) => {
    try {
      console.log(`   → ${name}`);
      await fn(range);
    } catch (err) {
      console.error(`   ✖ ${name} failed:`, err?.message || err);
    }
  });

  console.log(`✅ Done ${label} for ${range}`);
}

// Monthly update: only the current month's data (1st of month → yesterday).
async function runMonthlyUpdate() {
  const yesterday = subDays(new Date(), 1);
  const range = buildRange(startOfMonth(yesterday), yesterday);
  await runTasks(MONTHLY_UPDATE, range, 'MONTHLY_UPDATE');
}

// Yearly update: from Jan 1 of the current year → yesterday.
async function runYearlyUpdate() {
  const yesterday = subDays(new Date(), 1);
  const range = buildRange(startOfYear(yesterday), yesterday);
  await runTasks(YEARLY_UPDATE, range, 'YEARLY_UPDATE');
}

// Wrap an update so only one run happens at a time.
async function guardedRun(fn) {
  if (isRunning) {
    return;
  }
  isRunning = true;
  try {
    await fn();
  } catch (err) {
    console.error('Fatal cron error:', err);
  } finally {
    isRunning = false;
  }
}

// Run monthly update first, then yearly update — one after the other.
async function runAllUpdates() {
  await runMonthlyUpdate();
  await runYearlyUpdate();
}

// Every day at 2:00 AM PST: monthly update, then yearly update.
cron.schedule('0 2 * * *', () => guardedRun(runAllUpdates), {
  timezone: 'America/Los_Angeles'
});

if (process.argv.includes('--now')) {
  guardedRun(runAllUpdates);
}

console.log('🕐 Cron scheduler started.');
console.log('Daily 2:00 AM PST: monthly update, then yearly update.');
console.log('Manual: --now (runs monthly then yearly immediately).');
