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
   * Sparse aborters by index
   */
  readonly #allAborters = new Array<AbortController>()

  /**
   * Sparse entries by index
   */
  readonly #allEntries = new Array<PoolEntry<T>>()

  /**
   * A pool of circuits
   * @param tor 
   * @param params 
   */
  constructor(
    readonly creator: PoolCreator<T>
  ) { }

  [Symbol.dispose]() {
    for (const aborter of this.#allAborters) {
      if (aborter == null)
        continue
      aborter.abort()
    }

    for (const entry of this.#allEntries) {
      if (entry == null)
        continue
      if (!entry.isOk())
        continue
      using stack = new Stack()

      stack.push(entry.value)
      stack.push(entry.clean)
    }

    this.#allAborters.length = 0
    this.#allEntries.length = 0
  }

  /**
   * Delete and cancel entry
   * @param index 
   */
  clean(index: number) {
    this.cancel(index)
    this.delete(index)
  }

  /**
   * Cancel pending entry
   * @param index 
   * @returns 
   */
  cancel(index: number) {
    this.#allAborters.at(index)?.abort()

    delete this.#allAborters[index]
  }

  /**
   * Delete stale entry
   * @param index 
   * @returns 
   */
  delete(index: number) {
    const previous = this.#allEntries.at(index)

    delete this.#allEntries[index]

    if (previous == null)
      return
    if (!previous.isOk())
      return previous

    using stack = new Stack()

    stack.push(previous.value)
    stack.push(previous.clean)

    return previous
  }

  async #createOrThrow(index: number, creator: PoolCreator<T>, signal: AbortSignal): Promise<Result<Disposer<T>, Error>> {
    try {
      const disposer = await creator({ index, signal })

      using stack = new Stack()

      stack.push(disposer)
      stack.push(disposer.get())

      signal.throwIfAborted()

      stack.array.length = 0

      return new Ok(disposer)
    } catch (e: unknown) {
      signal.throwIfAborted()

      const value = Catched.wrap(e)

      return new Err(value)
    }
  }

  /**
   * Start the index
   * @param index 
   * @returns 
   */
  async startOrThrow(index: number, creator: PoolCreator<T> = this.creator) {
    this.cancel(index)

    const aborter = new AbortController()
    this.#allAborters[index] = aborter
    const { signal } = aborter

    const result = await this.#createOrThrow(index, creator, signal)

    return this.setOrThrow(index, result)
  }

  setOrThrow(index: number, result: Result<Disposer<T>, Error>) {
    if (result.isOk()) {
      const value = result.get().get()
      const clean = new Deferred(() => result.get()[Symbol.dispose]())

      const item = new PoolItem(this, index, value)
      const entry = new PoolOkEntry(this, index, item, clean)

      this.delete(index)

      this.#allEntries[index] = entry

      this.events.emit("ok", entry).catch(console.error)

      return entry
    } else {
      const value = result.getErr()
      const entry = new PoolErrEntry(this, index, value)

      this.delete(index)

      this.#allEntries[index] = entry

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
    return this.#allEntries.at(index)
  }

  /**
   * Get the entry at index or throw if nothing in there
   * @param index 
   * @returns 
   */
  getAnyOrThrow(index: number): PoolEntry<T> {
    const entry = this.#allEntries.at(index)

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
    const entry = this.#allEntries.at(index)

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
    const entry = this.#allEntries.at(index)

    if (entry == null)
      throw new EmptySlotError()
    if (entry.isErr())
      throw entry.getErr()

    return entry.get().checkOrThrow()
  }

  getRandomOrThrow(): PoolItem<T> {
    const entry = Arrays.random([...this.#allEntries.filter(x => x != null && x.isOk() && x.get().owned) as PoolOkEntry<T>[]])

    if (entry == null)
      throw new EmptyPoolError()

    return entry.get()
  }

  getCryptoRandomOrThrow(): PoolItem<T> {
    const entry = Arrays.cryptoRandom([...this.#allEntries.filter(x => x != null && x.isOk() && x.get().owned) as PoolOkEntry<T>[]])

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
      const entry = this.#allEntries.at(index)

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
      const entry = Arrays.random([...this.#allEntries.filter(x => x != null && x.isOk() && x.get().owned) as PoolOkEntry<T>[]])

      if (entry != null)
        return entry

      await Plume.waitOrThrow(this.events, "ok", (f: Future<void>) => {
        f.resolve()
      }, signal)
    }
  }

  async getCryptoRandomOrWaitOrThrow(signal = new AbortController().signal): Promise<PoolOkEntry<T>> {
    while (true) {
      const entry = Arrays.cryptoRandom([...this.#allEntries.filter(x => x != null && x.isOk() && x.get().owned) as PoolOkEntry<T>[]])

      if (entry != null)
        return entry

      await Plume.waitOrThrow(this.events, "ok", (f: Future<void>) => {
        f.resolve()
      }, signal)
    }
  }

}