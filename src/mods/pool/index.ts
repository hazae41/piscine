import { Arrays } from "@hazae41/arrays";
import { Box, Deferred, Stack } from "@hazae41/box";
import { Disposer } from "@hazae41/disposer";
import { Future } from "@hazae41/future";
import { Nullable } from "@hazae41/option";
import { Plume, SuperEventTarget } from "@hazae41/plume";
import { Catched, Err, Ok, Result } from "@hazae41/result";

export interface PoolCreatorParams {
  readonly index: number
  readonly signal: AbortSignal
}

export type PoolCreator<T> =
  (params: PoolCreatorParams) => Promise<Disposer<T>>

export type PoolEntry<T extends Disposable> =
  | PoolOkEntry<T>
  | PoolErrEntry<T>

/**
* - empty (undefined)
* - creating (promise)
* - created (ok)
* - errored (err)
* - borrowed
*/

export class PoolItem<T extends Disposable> extends Box<T> {

  constructor(
    readonly pool: Pool<T>,
    readonly index: number,
    readonly value: T
  ) {
    super(value)
  }

  moveOrNull() {
    const box = super.moveOrNull()

    if (box == null)
      return
    this.pool.delete(this.index)

    return box
  }

  moveOrThrow(): Box<T> {
    const box = super.moveOrThrow()

    this.pool.delete(this.index)

    return box
  }

  returnOrThrow(): void {
    super.returnOrThrow()

    if (!this.owned)
      return

    const entry = this.pool.getAnyOrNull(this.index)

    if (entry == null)
      return
    if (!entry.isOk())
      return
    if (entry.value !== this)
      return

    this.pool.events.emit("ok", entry).catch(console.error)
  }

}

export class PoolOkEntry<T extends Disposable> extends Ok<PoolItem<T>> {

  constructor(
    readonly pool: Pool<T>,
    readonly index: number,
    readonly value: PoolItem<T>,
    readonly clean: Deferred
  ) {
    super(value)
  }

}

export class PoolErrEntry<T extends Disposable> extends Err<Error> {

  constructor(
    readonly pool: Pool<T>,
    readonly index: number,
    readonly value: Error
  ) {
    super(value)
  }

}

export type PoolEvents<T extends Disposable> = {
  ok: (entry: PoolOkEntry<T>) => void
  err: (entry: PoolErrEntry<T>) => void
}

export class EmptyPoolError extends Error {
  readonly #class = EmptyPoolError
  readonly name = this.#class.name

  constructor() {
    super(`Empty pool`)
  }

}

export class EmptySlotError extends Error {
  readonly #class = EmptySlotError
  readonly name = this.#class.name

  constructor() {
    super(`Empty slot`)
  }

}

export class Pool<T extends Disposable> {

  readonly events = new SuperEventTarget<PoolEvents<T>>()

  /**
   * Sparse entries by index
   */
  readonly #entries = new Array<PoolEntry<T>>()

  /**
   * A pool
   */
  constructor() { }

  [Symbol.dispose]() {
    for (const entry of this.#entries) {
      if (entry == null)
        continue
      if (!entry.isOk())
        continue
      using stack = new Stack()

      stack.push(entry.value)
      stack.push(entry.clean)
    }

    this.#entries.length = 0
  }

  /**
   * Delete stale entry
   * @param index 
   * @returns 
   */
  delete(index: number) {
    const previous = this.#entries.at(index)

    delete this.#entries[index]

    if (previous == null)
      return
    if (!previous.isOk())
      return previous

    using stack = new Stack()

    stack.push(previous.value)
    stack.push(previous.clean)

    return previous
  }

  set(index: number, result: Result<Disposer<T>, Error>) {
    if (result.isOk()) {
      const value = result.get().get()
      const clean = new Deferred(() => result.get()[Symbol.dispose]())

      const item = new PoolItem(this, index, value)
      const entry = new PoolOkEntry(this, index, item, clean)

      this.delete(index)

      this.#entries[index] = entry

      this.events.emit("ok", entry).catch(console.error)

      return entry
    } else {
      const value = result.getErr()
      const entry = new PoolErrEntry(this, index, value)

      this.delete(index)

      this.#entries[index] = entry

      this.events.emit("err", entry).catch(console.error)

      return entry
    }
  }

  /**
   * Get the entry at index or null if nothing in there
   * @param index 
   * @returns 
   */
  getAnyOrNull(index: number): Nullable<PoolEntry<T>> {
    return this.#entries.at(index)
  }

  /**
   * Get the entry at index or throw if nothing in there
   * @param index 
   * @returns 
   */
  getAnyOrThrow(index: number): PoolEntry<T> {
    const entry = this.#entries.at(index)

    if (entry == null)
      throw new EmptySlotError()

    return entry
  }

  /**
   * Get the item at index or null if errored or nothing in there
   * @param index 
   * @returns 
   */
  getOrNull(index: number): Nullable<PoolItem<T>> {
    const entry = this.#entries.at(index)

    if (entry == null)
      return
    if (entry.isErr())
      return

    return entry.get().checkOrNull()
  }

  /**
   * Get the item at index or throw if errored or nothing in there
   * @param index 
   * @returns 
   */
  getOrThrow(index: number): PoolItem<T> {
    const entry = this.#entries.at(index)

    if (entry == null)
      throw new EmptySlotError()
    if (entry.isErr())
      throw entry.getErr()

    return entry.get().checkOrThrow()
  }

  getRandomOrThrow(): PoolItem<T> {
    const entry = Arrays.random([...this.#entries.filter(x => x != null && x.isOk() && x.get().owned) as PoolOkEntry<T>[]])

    if (entry == null)
      throw new EmptyPoolError()

    return entry.get()
  }

  getCryptoRandomOrThrow(): PoolItem<T> {
    const entry = Arrays.cryptoRandom([...this.#entries.filter(x => x != null && x.isOk() && x.get().owned) as PoolOkEntry<T>[]])

    if (entry == null)
      throw new EmptyPoolError()

    return entry.get()
  }

  /**
   * Get the owned item at index or wait for it
   * @param index 
   * @returns the entry at index
   * @throws if empty
   */
  async getOrWaitOrThrow(index: number, signal = new AbortController().signal): Promise<PoolOkEntry<T>> {
    while (true) {
      const entry = this.#entries.at(index)

      if (entry != null && entry.isOk() && entry.value.owned)
        return entry

      await Plume.waitOrThrow(this.events, "ok", (f: Future<void>, x) => {
        if (x.index !== index)
          return
        f.resolve()
      }, signal)
    }
  }

  async getRandomOrWaitOrThrow(signal = new AbortController().signal): Promise<PoolOkEntry<T>> {
    while (true) {
      const entry = Arrays.random([...this.#entries.filter(x => x != null && x.isOk() && x.get().owned) as PoolOkEntry<T>[]])

      if (entry != null)
        return entry

      await Plume.waitOrThrow(this.events, "ok", (f: Future<void>) => {
        f.resolve()
      }, signal)
    }
  }

  async getCryptoRandomOrWaitOrThrow(signal = new AbortController().signal): Promise<PoolOkEntry<T>> {
    while (true) {
      const entry = Arrays.cryptoRandom([...this.#entries.filter(x => x != null && x.isOk() && x.get().owned) as PoolOkEntry<T>[]])

      if (entry != null)
        return entry

      await Plume.waitOrThrow(this.events, "ok", (f: Future<void>) => {
        f.resolve()
      }, signal)
    }
  }

}

export class Starter<T extends Disposable> extends Pool<T> {

  readonly events = new SuperEventTarget<PoolEvents<T>>()

  /**
   * Sparse aborters by index
   */
  readonly #aborters = new Array<AbortController>()

  /**
   * A pool of circuits
   * @param tor 
   * @param params 
   */
  constructor(
    readonly creator: PoolCreator<T>
  ) {
    super()
  }

  [Symbol.dispose]() {
    for (const aborter of this.#aborters) {
      if (aborter == null)
        continue
      aborter.abort()
    }

    this.#aborters.length = 0
  }

  async #create(index: number, creator: PoolCreator<T>, signal: AbortSignal) {
    try {
      const disposer = await creator({ index, signal })

      using stack = new Stack()

      stack.push(disposer)
      stack.push(disposer.get())

      if (signal.aborted)
        return

      stack.array.length = 0

      this.set(index, new Ok(disposer))
    } catch (e: unknown) {
      if (signal.aborted)
        return

      const value = Catched.wrap(e)

      this.set(index, new Err(value))
    }
  }

  /**
   * Start the index
   * @param index 
   * @returns 
   */
  async start(index: number, creator: PoolCreator<T> = this.creator) {
    this.cancel(index)

    const aborter = new AbortController()
    this.#aborters[index] = aborter
    const { signal } = aborter

    this.#create(index, creator, signal)
  }

  /**
   * Cancel the index
   * @param index 
   * @returns 
   */
  cancel(index: number) {
    this.#aborters.at(index)?.abort()

    delete this.#aborters[index]
  }

}