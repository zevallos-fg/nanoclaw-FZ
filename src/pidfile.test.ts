// BankForge HQ3.H.45: NanoClaw writes its own pid, so a liveness check reads the real process.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { pidFilePath, removePidFileIfOwned, writePidFile } from './pidfile.js';

const tmpFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pid-')), 'nanoclaw.pid');

describe('pid file', () => {
  it('lives at <root>/nanoclaw.pid, the path setup/verify.ts reads', () => {
    expect(pidFilePath('/x/y')).toBe(path.join('/x/y', 'nanoclaw.pid'));
  });

  it('writes the real process id, which process.kill(pid, 0) finds alive (positive control)', () => {
    const f = tmpFile();
    expect(writePidFile(f)).toBe(true);
    const pid = Number(fs.readFileSync(f, 'utf-8').trim());
    expect(pid).toBe(process.pid);
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  it('a pid that is not running is reported dead (negative control)', () => {
    const f = tmpFile();
    writePidFile(f, 999_999_9);
    const pid = Number(fs.readFileSync(f, 'utf-8').trim());
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('removes the file only when it still names this process', () => {
    const f = tmpFile();
    writePidFile(f, 12345);
    expect(removePidFileIfOwned(f, process.pid)).toBe(false);
    expect(fs.existsSync(f)).toBe(true);
    writePidFile(f);
    expect(removePidFileIfOwned(f)).toBe(true);
    expect(fs.existsSync(f)).toBe(false);
  });

  it('never throws on an unwritable path', () => {
    expect(
      writePidFile(path.join(tmpFile(), 'no', 'such', 'dir', 'nanoclaw.pid')),
    ).toBe(false);
  });
});
