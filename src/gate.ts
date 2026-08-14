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
 */
export class Gate {
  private free: number;
  private readonly waiting: (() => void)[] = [];

  constructor(permits: number) {
    this.free = Math.max(1, Math.floor(permits) || 1);
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
