// One-way notification outbox (BankForge HQ3.H.32, ruling D-HQ3-52).
//
// WHAT: polls data/outbox/ for *.json files of exactly this shape
//   { "type": "notify", "text": string, "dedupe_key": string, "source": string, "created_at": ISO string }
// and posts `text` to the single registered MAIN group. After a successful send it writes a receipt to
// sent/<dedupe_key>.json (no text, only metadata) and deletes the original.
//
// WHY: BankForge's hold-escalation job needs to reach Fernando's phone through this existing WhatsApp
// channel (ruling D-HQ3-50) without a new credential, grant or migration. The existing file IPC path
// (data/ipc/<group>/messages) lets the main folder message ANY jid and its tasks/ folder can schedule
// agent runs, which is far more than a notifier needs. Here the recipient is resolved internally and any
// file that tries to name one is refused, so the producer can do one thing: post text to the main chat.
//
// Durability: a file is only removed after the send resolves. If WhatsApp is disconnected, or the main
// group is ambiguous, the file stays for the next poll. Producers write <name>.json.tmp and rename, so a
// half-written file is never read (only *.json is picked up).

import fs from 'fs';
import path from 'path';

import {
  OUTBOX_DIR,
  OUTBOX_MAX_CHARS,
  OUTBOX_MIN_SEND_GAP_MS,
  OUTBOX_POLL_INTERVAL,
} from './config.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface OutboxDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  isConnected: (jid: string) => boolean;
}

export interface OutboxNotice {
  type: 'notify';
  text: string;
  dedupe_key: string;
  source: string;
  created_at: string;
}

const ALLOWED_KEYS = new Set([
  'type',
  'text',
  'dedupe_key',
  'source',
  'created_at',
]);
const DEDUPE_KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;
export const TRUNCATION_NOTE = '\n(truncated; full digest in HQ-3 inbox)';

/** PURE. Returns the notice, or a reason it is refused. Extra keys (e.g. a jid) are a refusal, not ignored. */
export function parseNotice(
  raw: unknown,
): { ok: true; notice: OutboxNotice } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, reason: 'not a JSON object' };
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !ALLOWED_KEYS.has(k));
  if (extra.length)
    return {
      ok: false,
      reason: `unexpected field(s): ${extra.join(', ')} (the outbox never takes a recipient)`,
    };
  if (o.type !== 'notify')
    return { ok: false, reason: 'type must be "notify"' };
  if (typeof o.text !== 'string' || !o.text.trim())
    return { ok: false, reason: 'text must be a non-empty string' };
  if (typeof o.dedupe_key !== 'string' || !DEDUPE_KEY_RE.test(o.dedupe_key))
    return { ok: false, reason: 'dedupe_key must match [A-Za-z0-9._-]{1,128}' };
  if (typeof o.source !== 'string' || !o.source.trim())
    return { ok: false, reason: 'source must be a non-empty string' };
  if (
    typeof o.created_at !== 'string' ||
    Number.isNaN(Date.parse(o.created_at))
  )
    return { ok: false, reason: 'created_at must be an ISO timestamp' };
  return { ok: true, notice: o as unknown as OutboxNotice };
}

/** PURE. The single main group's jid, or a reason there is not exactly one. */
export function resolveMainJid(
  groups: Record<string, RegisteredGroup>,
): { ok: true; jid: string } | { ok: false; reason: string } {
  const mains = Object.entries(groups).filter(([, g]) => g.isMain);
  if (mains.length !== 1)
    return {
      ok: false,
      reason: `expected exactly one main group, found ${mains.length}`,
    };
  return { ok: true, jid: mains[0][0] };
}

/** PURE. Caps the text so a runaway producer cannot post a wall of text. */
export function capText(text: string, max = OUTBOX_MAX_CHARS): string {
  if (text.length <= max) return text;
  return (
    text.slice(0, Math.max(0, max - TRUNCATION_NOTE.length)) + TRUNCATION_NOTE
  );
}

function moveWithReason(
  dir: string,
  sub: string,
  file: string,
  reason: string,
): void {
  const dest = path.join(dir, sub);
  fs.mkdirSync(dest, { recursive: true });
  fs.renameSync(path.join(dir, file), path.join(dest, file));
  fs.writeFileSync(path.join(dest, `${file}.reason.txt`), reason + '\n');
}

/**
 * One pass over the outbox. Exported for tests; the watcher calls it on a timer. Sends at most one file
 * per pass (the min-gap floor), oldest name first, and returns what it did.
 */
export async function processOutboxOnce(
  deps: OutboxDeps,
  opts: { dir?: string; now?: () => number; lastSentAt?: number } = {},
): Promise<{
  sent: string[];
  held: string[];
  refused: string[];
  duplicates: string[];
  lastSentAt: number;
}> {
  const dir = opts.dir ?? OUTBOX_DIR;
  const now = opts.now ?? Date.now;
  const result = {
    sent: [] as string[],
    held: [] as string[],
    refused: [] as string[],
    duplicates: [] as string[],
    lastSentAt: opts.lastSentAt ?? 0,
  };
  if (!fs.existsSync(dir)) return result;
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.json'))
    .map((d) => d.name)
    .sort();

  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (err) {
      moveWithReason(
        dir,
        'errors',
        file,
        `unreadable JSON: ${(err as Error).message}`,
      );
      result.refused.push(file);
      continue;
    }
    const parsed = parseNotice(raw);
    if (!parsed.ok) {
      moveWithReason(dir, 'errors', file, parsed.reason);
      result.refused.push(file);
      logger.warn({ file, reason: parsed.reason }, 'Outbox file refused');
      continue;
    }
    const { notice } = parsed;
    const receipt = path.join(dir, 'sent', `${notice.dedupe_key}.json`);
    if (fs.existsSync(receipt)) {
      moveWithReason(
        dir,
        'duplicates',
        file,
        `already sent under dedupe_key ${notice.dedupe_key}`,
      );
      result.duplicates.push(file);
      continue;
    }
    const target = resolveMainJid(deps.registeredGroups());
    if (!target.ok) {
      // Ambiguous or missing main chat: keep the file and say so, never guess a recipient.
      logger.warn(
        { file, reason: target.reason },
        'Outbox file held: no single main group',
      );
      result.held.push(file);
      continue;
    }
    if (!deps.isConnected(target.jid)) {
      result.held.push(file);
      continue;
    }
    if (
      result.sent.length > 0 ||
      now() - result.lastSentAt < OUTBOX_MIN_SEND_GAP_MS
    ) {
      result.held.push(file);
      continue;
    }
    const text = capText(notice.text);
    try {
      await deps.sendMessage(target.jid, text);
    } catch (err) {
      logger.warn(
        { file, err },
        'Outbox send failed; file kept for the next poll',
      );
      result.held.push(file);
      continue;
    }
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(
      receipt,
      JSON.stringify(
        {
          source: notice.source,
          created_at: notice.created_at,
          sent_at: new Date(now()).toISOString(),
          length: text.length,
        },
        null,
        2,
      ),
    );
    fs.unlinkSync(path.join(dir, file));
    result.sent.push(file);
    result.lastSentAt = now();
    logger.info(
      { file, source: notice.source, length: text.length },
      'Outbox notice sent to main chat',
    );
  }
  return result;
}

let outboxWatcherRunning = false;

export function startOutboxWatcher(deps: OutboxDeps): void {
  if (outboxWatcherRunning) {
    logger.debug('Outbox watcher already running, skipping duplicate start');
    return;
  }
  outboxWatcherRunning = true;
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  let lastSentAt = 0;
  const tick = async () => {
    try {
      const r = await processOutboxOnce(deps, { lastSentAt });
      lastSentAt = r.lastSentAt;
    } catch (err) {
      logger.error({ err }, 'Outbox pass failed');
    }
    setTimeout(tick, OUTBOX_POLL_INTERVAL);
  };
  tick();
  logger.info({ dir: OUTBOX_DIR }, 'Outbox watcher started');
}
