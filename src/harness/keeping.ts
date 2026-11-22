/**
 * Where one agent's memory is, all of it, decided in one place.
 *
 * An agent that names a store remembers into that store: its record, its working notes,
 * what it carries, its pages. One that names none remembers into files under the state
 * directory. Nothing is split between the two, so what the runtime writes while it
 * answers and what the app reads back afterwards are the same things in the same place.
 */

import type { AgentPlan } from "../compile/plan.js";
import type { StateCipher } from "../private.js";
import type { Store } from "../stores/types.js";
import { NoteBook } from "./consolidate.js";
import type { Embedder } from "./embed.js";
import { Memory, StoredMemory, type Recollection } from "./memory.js";
import { Pages } from "./pages.js";
import { FileShelf, StoreShelf, type Shelf } from "./shelf.js";

/** Everything kept for one agent. */
export interface Holdings {
  /** The name it is all kept under. */
  as: string;
  /** The record of exchanges, and the working notes. */
  memory: Recollection;
  /** What it carries, and the proposal waiting on it. */
  notes: NoteBook;
  pages: Pages;
  shelf: Shelf;
}

export interface KeepingOptions {
  stateDir: string;
  /** Seals what is kept in files. A store is sealed, or not, by whoever runs it. */
  cipher?: StateCipher;
  stores?: { open(name: string): Promise<Store> };
  /** Turns text into a vector, where the app has an endpoint that does. */
  embedder?: Embedder;
}

type Place = Omit<Holdings, "as">;

export class Keeping {
  private readonly files: Place;
  private readonly stored = new Map<string, Place>();
  private readonly options: KeepingOptions;

  constructor(options: KeepingOptions) {
    this.options = options;
    this.files = placed(new Memory(options.stateDir, options.cipher), new FileShelf(options.stateDir, options.cipher));
  }

  of(plan: AgentPlan): Holdings {
    const as = plan.memoryAs ?? plan.name;
    const name = plan.memoryStore;
    const stores = this.options.stores;
    if (!name || !stores) return { as, ...this.files };
    let place = this.stored.get(name);
    if (!place) {
      const open = (): Promise<Store> => stores.open(name);
      place = placed(new StoredMemory(open, this.options.embedder), new StoreShelf(open));
      this.stored.set(name, place);
    }
    return { as, ...place };
  }

  /** Everything kept for this agent, gone. */
  async drop(plan: AgentPlan): Promise<void> {
    const held = this.of(plan);
    await held.memory.drop(held.as);
    await held.shelf.drop(held.as);
  }
}

function placed(memory: Recollection, shelf: Shelf): Place {
  return { memory, shelf, notes: new NoteBook(shelf), pages: new Pages(shelf) };
}
