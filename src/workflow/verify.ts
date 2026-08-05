/**
 * Running something to find out whether it worked.
 *
 * A check that asks a model whether the work is good is the weakest signal
 * there is, and it is worst exactly where it matters — judging output the same
 * model produced. A check that runs a command is not open to persuasion, so
 * `passes` runs one and reads the exit status.
 *
 * The command is split into arguments here and spawned without a shell. That
 * matters because parts of it may have been interpolated from model output, and
 * a shell would treat `; rm -rf ~` in a filename as instructions.
 */

import { spawn } from "node:child_process";

/** Split a command line into argv, honouring single and double quotes. */
export function splitCommand(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;

  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) argv.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) argv.push(current);
  return argv;
}

export interface VerifyResult {
  ok: boolean;
  /** Combined output, trimmed — shown when the check fails. */
  output: string;
}

/** Run a command and report whether it exited cleanly. Never throws. */
export function runCommand(
  command: string,
  options: { cwd?: string; timeout?: number } = {},
): Promise<VerifyResult> {
  const [program, ...args] = splitCommand(command);
  if (!program) return Promise.resolve({ ok: false, output: "no command to run" });

  return new Promise((settle) => {
    let output = "";
    // The timeout is held here rather than handed to `spawn`. Its own `timeout`
    // option arms a timer that is not cleared when the spawn itself fails, so a
    // verify command that does not exist leaves one pending timer per attempt
    // and the process never exits — a loop that retries three times ends with
    // three live timers and a run that has already finished.
    const child = spawn(program, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const done = (result: VerifyResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      settle(result);
    };

    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        done({ ok: false, output: `timed out after ${options.timeout}ms` });
      }, options.timeout);
      // A pending kill-timer is not a reason to keep the process alive; it only
      // matters while something else is still waiting on this command.
      timer.unref?.();
    }

    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-8000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    child.on("error", (err) => done({ ok: false, output: err.message }));
    child.on("close", (code) => done({ ok: code === 0, output: output.trim() }));
  });
}
