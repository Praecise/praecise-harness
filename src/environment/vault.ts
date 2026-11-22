/**
 * Where an environment keeps what a sign-in returned.
 *
 * A vault holds one secret per connection and nothing else. What it holds is never
 * written to a trace, a recording, a prompt or a tool result: the only readers are the
 * environment's own calls to the platform.
 *
 * Three are provided. The keychain is the default on a Mac. A sealed file is the one for
 * a server, and it needs a key. Memory is for tests. There is no unsealed file: a vault
 * that cannot protect what it holds refuses to hold it.
 */

import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { join } from "node:path";

import { readState, updateState, type StateCipher } from "../private.js";

export interface Vault {
  /** What this vault is, for `doctor` and for error messages. */
  readonly kind: string;
  get(id: string): Promise<string | undefined>;
  put(id: string, secret: string): Promise<void>;
  delete(id: string): Promise<void>;
}

/** A vault that forgets when the process ends. */
export function memoryVault(): Vault {
  const held = new Map<string, string>();
  return {
    kind: "memory",
    get: async (id) => held.get(id),
    put: async (id, secret) => void held.set(id, secret),
    delete: async (id) => void held.delete(id),
  };
}

/**
 * A cipher from a secret the app holds: AES-256-GCM under a key derived with scrypt.
 * Each sealing has its own salt and nonce, so two sealings of the same text differ.
 */
export function secretCipher(secret: string): StateCipher {
  if (secret.length < 16) throw new Error("a vault key must be at least 16 characters");
  const keyFor = (salt: Uint8Array): Buffer => scryptSync(secret, salt, 32);
  return {
    async seal(plain) {
      const salt = randomBytes(16);
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", keyFor(salt), nonce);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([salt, nonce, cipher.getAuthTag(), body]);
    },
    async open(sealed) {
      const bytes = Buffer.from(sealed);
      if (bytes.length < 44) throw new Error("this was not sealed by this vault");
      const decipher = createDecipheriv("aes-256-gcm", keyFor(bytes.subarray(0, 16)), bytes.subarray(16, 28));
      decipher.setAuthTag(bytes.subarray(28, 44));
      return Buffer.concat([decipher.update(bytes.subarray(44)), decipher.final()]);
    },
  };
}

/** A vault in one sealed file. */
export function fileVault(dir: string, cipher: StateCipher): Vault {
  const path = join(dir, "vault.sealed");
  type Held = Record<string, string>;
  return {
    kind: "sealed file",
    get: async (id) => (await readState<Held>(path, cipher))?.[id],
    put: async (id, secret) => {
      await updateState<Held>(path, cipher, () => ({}), (held) => ({ ...held, [id]: secret }));
    },
    delete: async (id) => {
      await updateState<Held>(path, cipher, () => ({}), (held) => {
        if (!(id in held)) return undefined;
        const { [id]: _gone, ...rest } = held;
        return rest;
      });
    },
  };
}

/** Run a program with text on its standard input, and give back what it printed. */
function pipe(command: string, args: string[], input?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
    child.stdin.end(input ?? "");
  });
}

/**
 * A vault in the macOS login keychain.
 *
 * A secret is handed to `security` on its standard input and never as an argument, so it
 * does not appear in the process list. It is stored as hex, which keeps any character it
 * contains from being read as part of the command.
 */
export function keychainVault(service: string): Vault {
  if (!/^[A-Za-z0-9._-]+$/.test(service)) throw new Error("a keychain service name is letters, digits, dots and dashes");
  const account = (id: string): string => {
    if (!/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error(`"${id}" cannot name a keychain item`);
    return id;
  };
  return {
    kind: "keychain",
    async get(id) {
      const found = await pipe("security", ["find-generic-password", "-s", service, "-a", account(id), "-w"]);
      if (found.code !== 0) return undefined;
      return Buffer.from(found.out.trim(), "hex").toString("utf8");
    },
    async put(id, secret) {
      const hex = Buffer.from(secret, "utf8").toString("hex");
      const done = await pipe("security", ["-i"], `add-generic-password -U -s ${service} -a ${account(id)} -w ${hex}\n`);
      if (done.code !== 0) throw new Error("the keychain did not accept the connection");
    },
    async delete(id) {
      await pipe("security", ["delete-generic-password", "-s", service, "-a", account(id)]);
    },
  };
}

/**
 * The vault an environment uses when the app names none: the keychain on a Mac, else a
 * sealed file under the key in `PRAECISE_VAULT_KEY`. With neither, there is nowhere safe
 * to keep a sign-in and this says so.
 */
export function defaultVault(input: { name: string; dir: string; env: Record<string, string | undefined> }): Vault {
  const key = input.env.PRAECISE_VAULT_KEY;
  if (key) return fileVault(input.dir, secretCipher(key));
  if (process.platform === "darwin") return keychainVault(`praecise.${input.name}`);
  throw new Error(
    `the ${input.name} environment has nowhere safe to keep a sign-in: set PRAECISE_VAULT_KEY, or give the environment a vault`,
  );
}
