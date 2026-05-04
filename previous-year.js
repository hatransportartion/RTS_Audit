import {
  CONFIG,
  runRecoursedRTSDefault,
  runRecoursedRTSChandi,
  runRecoursedRTS313,
  runRTSDefault,
  runRTSChandi,
  runRTS313,
  runPaymentsRTSDefault,
  runPaymentsRTSChandi,
  runPaymentsRTS313,
} from './index.js';

// Override the Airtable base for previous-year data (table id stays the same).
CONFIG.airtable.baseId = 'appmebvEHB4Mfvq0O';

// Skip the per-report "Press ENTER to close" prompts so chunks run unattended.
CONFIG.autoClose = true;

// --- Choose chunk size ---------------------------------------------------
// RTS can't return a full year in one query, so we iterate smaller windows.
// Use monthlyRanges(year) for 12 chunks/year, or fortnightlyRanges(year) for 24.
function pad(n) {
  return String(n).padStart(2, '0');
}

function monthlyRanges(year) {
  const ranges = [];
  for (let m = 1; m <= 9; m++) {
    const lastDay = new Date(year, m, 0).getDate();
    ranges.push(`${pad(m)}/01/${year} – ${pad(m)}/${pad(lastDay)}/${year}`);
  }
  return ranges;
}

function fortnightlyRanges(year) {
  const ranges = [];
  for (let m = 1; m <= 12; m++) {
    const lastDay = new Date(year, m, 0).getDate();
    ranges.push(`${pad(m)}/01/${year} – ${pad(m)}/15/${year}`);
    ranges.push(`${pad(m)}/16/${year} – ${pad(m)}/${pad(lastDay)}/${year}`);
  }
  return ranges;
}

// Edit this list (or replace with `fortnightlyRanges(2025)`) to control what gets processed.
// You can also slice it, e.g. `monthlyRanges(2025).slice(0, 3)` to only do Jan–Mar.
const DATE_RANGES = monthlyRanges(2025);

// --- Per-account orchestration ------------------------------------------
async function runAllForAccount(label, { recoursed, purchases, payments } = {}) {
  console.log(`\n========== ${label}: ${DATE_RANGES.length} chunk(s) ==========`);

  for (let i = 0; i < DATE_RANGES.length; i++) {
    const range = DATE_RANGES[i];
    console.log(`\n---------- ${label} | chunk ${i + 1}/${DATE_RANGES.length} | ${range} ----------`);

    if (typeof recoursed === 'function') {
      console.log(`\n[chunk ${i + 1}] RECOURSED`);
      await recoursed(range);
    }

    if (typeof purchases === 'function') {
      console.log(`\n[chunk ${i + 1}] PURCHASES`);
      await purchases(range);
    }

    if (typeof payments === 'function') {
      console.log(`\n[chunk ${i + 1}] PAYMENTS`);
      await payments(range);
    }
  }

  console.log(`\n========== ${label}: done ==========\n`);
}

async function main() {
  // Comment any of `recoursed` / `purchases` / `payments` to skip that report.
  // Switch which account block is uncommented below to change accounts.

  await runAllForAccount('RTS Default (prev year)', {
    // recoursed: runRecoursedRTSDefault,
    purchases: runRTSDefault,
    // payments: runPaymentsRTSDefault,
  });

  // await runAllForAccount('RTS Chandi (prev year)', {
  //   // recoursed: runRecoursedRTSChandi,
  //   purchases: runRTSChandi,
  //   // payments: runPaymentsRTSChandi,
  // });

  // await runAllForAccount('RTS 313 (prev year)', {
    // recoursed: runRecoursedRTS313,
    // purchases: runRTS313,
    // payments: runPaymentsRTS313,
  // });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
