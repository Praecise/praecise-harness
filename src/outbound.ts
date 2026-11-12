/**
 * Whether a URL somebody else supplied is one this process should call.
 *
 * Most addresses an app requests were typed by its author: a model endpoint, a tool's
 * server, the webhook in its own config. A few arrive from a caller, and those are a
 * different thing: a callback URL registered over the network is an instruction to make
 * this machine send a request, from inside whatever network it sits in, to wherever the
 * caller likes. Pointed at `169.254.169.254` or at a database's admin port, that is a
 * way to read or poke things only this machine can reach (server-side request forgery).
 *
 * So a caller-supplied address is held to more than "it parses": `https`, no credentials
 * in it, and a host that is neither a private, loopback or link-local address nor a name
 * that resolves to one. Redirects are the other half and are the sender's to refuse
 * (`redirect: "manual"`, as `deliverWebhook` does), because a public host can answer
 * with a `Location` that is not.
 *
 * What this does not close: a name can resolve to a public address when it is checked
 * and to a private one when the request is made a moment later. Closing that needs the
 * connection pinned to the address that was checked, which `fetch` has no way to ask
 * for. An app exposed to callers it does not trust should also be on a network where
 * the addresses that matter are not reachable from it.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface OutboundOptions {
  /**
   * Hosts allowed whatever they resolve to, and over `http` as well: `localhost:9000`,
   * `hooks.internal`. For development, and for a receiver on a private network the
   * operator chose. Compared with the URL's host, port included where one is given.
   */
  allowHosts?: string[];
  /** Resolves a name to its addresses. Defaults to the system resolver; a test brings its own. */
  resolve?: (host: string) => Promise<string[]>;
}

/** An IPv4 address as four numbers, or nothing. */
function quad(address: string): number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return undefined;
  const numbers = parts.map(Number);
  return numbers.every((n) => n <= 255) ? numbers : undefined;
}

/**
 * Whether an IP address is one only this machine or its own network can reach.
 *
 * Deliberately broad. Besides the private, loopback and link-local ranges this counts
 * carrier-grade NAT, the benchmarking and documentation ranges, multicast and anything
 * reserved: none of them is a place a stranger's webhook lives.
 */
export function privateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = quad(bare);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(bare) !== 6) return false;
  if (bare === "::" || bare === "::1") return true;
  // An IPv4 address written as IPv6 is the IPv4 address: `::ffff:10.0.0.1`, or the same
  // thing as the URL parser prints it, `::ffff:a00:1`.
  const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (mapped) return privateAddress(mapped[1]!);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (hex) {
    const high = parseInt(hex[1]!, 16);
    const low = parseInt(hex[2]!, 16);
    return privateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  const first = parseInt(bare.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local, fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local, fe80::/10
    (first & 0xff00) === 0xff00 || // multicast
    first === 0x64 // 64:ff9b::/96 and its neighbours: translated IPv4
  );
}

/** Names that never leave the machine or the network it is on. */
function localName(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    !hostname.includes(".")
  );
}

/**
 * Why a caller-supplied URL must not be requested, or nothing when it may be.
 *
 * A sentence and not a boolean, because the caller who registered the address is owed
 * the reason: "that host resolves to a private address" is something they can fix.
 */
export async function outboundFault(url: string, options: OutboundOptions = {}): Promise<string | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "it is not a URL";
  }
  if (parsed.username || parsed.password) return "it carries credentials in the URL itself";

  const allowed = options.allowHosts ?? [];
  if (allowed.includes(parsed.host) || allowed.includes(parsed.hostname)) {
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? undefined : "it is not an http(s) URL";
  }
  if (parsed.protocol !== "https:") return "it must be an https URL";

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (isIP(hostname)) {
    return privateAddress(hostname) ? "it points at a private, loopback or link-local address" : undefined;
  }
  if (localName(hostname)) return "it names a host on this machine or its own network";

  let addresses: string[];
  try {
    addresses = options.resolve
      ? await options.resolve(hostname)
      : (await lookup(hostname, { all: true })).map((found) => found.address);
  } catch {
    return "its host does not resolve";
  }
  if (!addresses.length) return "its host does not resolve";
  // Every address, not the first: a name with one public and one private record is
  // a name that will sometimes be the private one.
  if (addresses.some(privateAddress)) return "its host resolves to a private, loopback or link-local address";
  return undefined;
}
