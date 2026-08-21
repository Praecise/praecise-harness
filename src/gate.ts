/**
 * A permit pool, for the places where "how many at once" is a property of the
 * whole process rather than of the list being walked.
 *
 * A bound that is re-created per list is not a bound. Four items each running a
 * four-wide body is sixteen in flight, and at three levels of nesting it is
 * sixty-four — every level honouring a limit of four, and nothing honouring it
 * overall. So the pool is made once, at the top, and handed down.
 *
 * Permits are held around the work that actually costs something and never
 * around the scheduling of more work. That ordering is what makes the pool
 * deadlock-free: nothing that holds a permit ever waits for one.
 *
 * That last part is a rule about CALLERS, and this class does not enforce it. A
 * caller that awaits a permit while holding one hangs forever, with no error and
 * no timeout. Detecting it needs the pool to know which logical task is asking,
 * which means `AsyncLocalStorage` on the hot path of every model call — a
 * per-call context switch, and a store to read and write, to catch a mistake
 * that has one shape and is made at authoring time rather than at run time.
 * Weighed and declined: the rule stays in prose here and in a test that holds
 * the deadlock still, and the cost stays off the call path. Revisit if a second
 * caller ever makes it.
 */
export class Gate {
  /**
   * The most permits a pool will hold, however many were asked for.
   *
   * The floor was enforced and the ceiling was not, so `limits.concurrency:
   * Infinity` — or `1e9`, which an author is likelier to write — produced a pool
   * that admitted everything and a run bounded by nothing but the event loop.
   * That is a pool that is not a pool, and the failure it produces is not a
   * refusal but a provider rate-limiting an app that thought it had a limit.
   *
   * A thousand and twenty-four is chosen to be far above any real answer and far
   * below "no bound": model calls are network-bound, so the honest ceiling is
   * sockets and provider quota long before it is this number, and an app that
   * genuinely wants more concurrency than this wants a second process.
   */
  static readonly MAX_PERMITS = 1024;

  private free: number;
  private readonly waiting: (() => void)[] = [];

  constructor(permits: number) {
    this.free = Math.min(Gate.MAX_PERMITS, Math.max(1, Math.floor(permits) || 1));
  }

  /** Permits nobody is holding. For tests and for reporting, not for deciding. */
  get available(): number {
    return this.free;
  }

  /** Run `work` holding one permit, queueing until one is free. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((go) => this.waiting.push(go));

    try {
      return await work();
    } finally {
      // Hand the permit straight to whoever is next rather than returning it to
      // the pool and re-acquiring: a round trip through `free` lets a caller that
      // arrives in between jump a queue that was already formed.
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    }
  }
}
