import cron from 'node-cron';
import { format, subDays } from 'date-fns';
import pEachSeries from 'p-each-series';
import {
  runRTSDefault, runPaymentsRTSDefault, runRecoursedRTSDefault,
  runRTSChandi,  runPaymentsRTSChandi,  runRecoursedRTSChandi,
  runRTS313,     runPaymentsRTS313,     runRecoursedRTS313,
} from './index.js';

const TASKS = [
  ['runRTSDefault',          runRTSDefault],
  ['runPaymentsRTSDefault',  runPaymentsRTSDefault],
  ['runRecoursedRTSDefault', runRecoursedRTSDefault],
  ['runRTSChandi',           runRTSChandi],
  ['runPaymentsRTSChandi',   runPaymentsRTSChandi],
  ['runRecoursedRTSChandi',  runRecoursedRTSChandi],
  ['runRTS313',              runRTS313],
  ['runPaymentsRTS313',      runPaymentsRTS313],
  ['runRecoursedRTS313',     runRecoursedRTS313],
];

let isRunning = false;

async function runForDate(targetDate) {
  const s = format(targetDate, 'MM/dd/yyyy');
  const range = `${s} – ${s}`;
  console.log(`\n========== ${range} ==========`);

  await pEachSeries(TASKS, async ([name, fn]) => {
    try {
      console.log(`   → ${name}`);
      await fn(range);
    } catch (err) {
      console.error(`   ✖ ${name} failed:`, err?.message || err);
    }
  });

  console.log(`✅ Done for ${range}`);
}

// CHANGE THIS LINE when you decide the time
cron.schedule('0 2 * * *', async () => {
  if (isRunning) {
    console.log(`[${new Date().toISOString()}] ⏭️  Previous run active, skipping.`);
    return;
  }
  isRunning = true;
  console.log(`[${new Date().toISOString()}] 🕑 Cron triggered`);
  try {
    await runForDate(subDays(new Date(), 1));
  } catch (err) {
    console.error('Fatal cron error:', err);
  } finally {
    isRunning = false;
  }
}, {
  timezone: 'America/Los_Angeles'
});

if (process.argv.includes('--now')) {
  console.log('🚀 Running immediately (test mode)...');
  isRunning = true;
  runForDate(subDays(new Date(), 1)).finally(() => {
    isRunning = false;
    console.log('Test run complete. Cron still scheduled — Ctrl+C to stop.');
  });
}

console.log('🕐 Cron scheduler started.');
console.log('Waiting for the next scheduled run (2:00 AM PST) or use --now to run immediately.');