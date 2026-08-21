/**
 * `npm run auth:status` — say what the WhatsApp connection was last OBSERVED to be, and when.
 *
 * This is the READ half of the fix in src/auth-status.ts. A file cannot mark itself stale — nothing
 * re-writes it as time passes — so the file records `observed_at` and this computes staleness at
 * read time. That split is deliberate: the writer records only what it saw, and the reader is the
 * only thing allowed to draw a conclusion from how old that is.
 *
 * Exit codes are meant to be usable from a script:
 *   0  CONNECTED        — a dated, fresh observation of an open connection
 *   6  STALE            — the last observation is older than one scheduled run
 *   7  NOT-ESTABLISHED  — no file, an undated legacy token, or an unparseable file
 *   8  observed down    — a fresh observation that the connection is NOT up
 *
 * 6, 7 and 8 are three different things and are deliberately not collapsed: "nobody looked",
 * "somebody looked a long time ago", and "somebody just looked and it is down" call for different
 * actions, and only the third one means the transport is known-broken.
 */
import { STORE_DIR } from './config.js';
import { assess, readObservation, renderReport } from './auth-status.js';

const observation = readObservation(STORE_DIR);
const verdict = assess(observation, Date.now());

console.log(renderReport(observation, verdict));

if (verdict.trustedConnected) process.exitCode = 0;
else if (verdict.verdict === 'STALE') process.exitCode = 6;
else if (verdict.verdict === 'NOT-ESTABLISHED') process.exitCode = 7;
else process.exitCode = 8;
