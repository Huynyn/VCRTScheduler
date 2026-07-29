// Manual reproduction on a real exported roster (an .xlsx from the app's own
// "export roster" feature). Not part of the automated suite — it needs a file on
// disk — but handy for re-checking the "make a complete schedule possible" fix
// against a real team.
//
//   node test/full.mjs [path-to-roster.xlsx]
//
// Defaults to the sample team that first surfaced the bug. Prints how many
// unlockers the reach-out now finds for each short shift; before the exact-solver
// backstop, the greedy verification silently dropped several of them.
import { existsSync } from 'node:fs';
import { loadRoster, DEFAULT_FILE } from './_load.mjs';
import { generateSchedules } from '../src/lib/scheduler.js';

const file = process.argv[2] || DEFAULT_FILE;
if (!existsSync(file)) {
  console.log(`Roster file not found: ${file}`);
  console.log('Pass a path to a roster .xlsx exported by the app:  node test/full.mjs <file>');
  process.exit(0);
}

const responders = await loadRoster(file);
console.log(`Loaded ${responders.length} responders from ${file}`);

const t0 = Date.now();
const result = generateSchedules(responders, {
  timeBudgetMs: 4000,
  reachoutBudgetMs: 25000,
  reachoutCheckMs: 1500,
});
console.log(`Solved in ${((Date.now() - t0) / 1000).toFixed(1)}s — ok=${result.ok}, valid schedules found=${result.stats?.validFound}`);

const reach = result.reachout;
if (reach) {
  console.log(`Reach-out: ${reach.gapCount} gap(s), searched=${reach.searched}, exhausted=${reach.exhausted}`);
  for (const f of reach.singleFixes) {
    console.log(`  ${f.slotLabel} is short ${f.needLabel}. Any one of these completes the week:`);
    console.log(`    ${f.people.map((p) => p.name).join(', ')}`);
  }
  if (reach.multiFix) {
    console.log(`  Combined fix: ${reach.multiFix.asks.map((a) => `${a.person.name} -> ${a.slotLabel}`).join(' + ')}`);
  }
  if (!reach.singleFixes.length && !reach.multiFix && reach.capacity && !reach.capacity.feasible) {
    console.log(`  Roster too small: ${reach.capacity.reasons.join('; ')}`);
  }
}
