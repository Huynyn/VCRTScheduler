import { SAMPLE_RESPONDERS } from '../src/data/sampleData.js';
import { buildPatterns } from '../src/lib/patterns.js';
// Re-implement the attempt loop counting successes vs failures.
import { ALL_SLOTS, MIN_PER_SHIFT, MAX_PER_SHIFT } from '../src/constants/schedule.js';
const responders = SAMPLE_RESPONDERS();
const patternMap = {}; for (const r of responders) patternMap[r.id]=buildPatterns(r).patterns;
const minP = Math.min(...responders.map(r=>patternMap[r.id].length));
const avgP = responders.reduce((s,r)=>s+patternMap[r.id].length,0)/responders.length;
console.log('min patterns/person:', minP, 'avg:', avgP.toFixed(1));
