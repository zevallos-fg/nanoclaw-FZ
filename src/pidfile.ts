// BankForge HQ3.H.45 (GO b929b6a8, ruling D-HQ3-73), for TD-NANOCLAW-LAUNCHER-WRITES-BASH-PID-WINDOWS-TOOLING-READS.
//
// WHY: a launcher that writes `echo $! > nanoclaw.pid` under Git Bash records an MSYS process id, not the
// Windows one. setup/verify.ts then calls process.kill(pid, 0) on a pid that does not exist and reports a
// running daemon as STOPPED (calibration entry 615: the instrument was wrong, not the daemon).
// The fix is that NanoClaw writes its OWN pid. process.pid is the real id on every platform, whatever started it.
// The file is removed only if it still holds this process's pid, so a second instance's file is never deleted.
import fs from 'fs';
import path from 'path';

export const PID_FILE_NAME = 'nanoclaw.pid';

export function pidFilePath(projectRoot: string): string {
  return path.join(projectRoot, PID_FILE_NAME);
}

/** Write this process's pid. Never throws: a pid file is telemetry, not a reason to stop the daemon. */
export function writePidFile(file: string, pid: number = process.pid): boolean {
  try {
    fs.writeFileSync(file, `${pid}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Remove the pid file only when it still names `pid`. Never throws. */
export function removePidFileIfOwned(
  file: string,
  pid: number = process.pid,
): boolean {
  try {
    const raw = fs.readFileSync(file, 'utf-8').trim();
    if (Number(raw) !== pid) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
