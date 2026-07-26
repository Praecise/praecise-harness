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
    const child = spawn(program, args, {
      cwd: options.cwd,
      timeout: options.timeout,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-8000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    child.on("error", (err) => settle({ ok: false, output: err.message }));
    child.on("close", (code) => settle({ ok: code === 0, output: output.trim() }));
  });
}
