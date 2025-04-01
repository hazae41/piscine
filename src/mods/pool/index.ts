import { Box, Stack } from "@hazae41/box";
import { Disposer } from "@hazae41/disposer";
import { SuperEventTarget } from "@hazae41/plume";
import { Catched, Err, Ok, Result } from "@hazae41/result";
import { Signals } from "@hazae41/signals";

export interface PoolCreatorParams {
  readonly index: number
  readonly signal: AbortSignal
}

export type PoolCreator<T> =
  (params: PoolCreatorParams) => Promise<Disposer<T>>

export type PoolEntry<T> =
  | PoolOkEntry<T>
  | PoolErrEntry<T>

/**
* - empty (undefined)
* - creating (promise)
* - created (ok)
* - errored (err)
* - borrowed
*/

export class PoolItem<T> extends Box<T> {

  constructor(
    readonly pool: Pool<T>,
    readonly index: number,
    readonly value: Disposer<T>
  ) {
    super(value.get())
  }

  // moveOrNull(): Nullable<Box<T>> {
  //   const box = this.moveOrNull()
  //   this.pool.restart(this.index)
  //   return box
  // }

  // moveOrThrow(): Box<T> {
  //   const box = this.moveOrThrow()
  //   this.pool.restart(this.index)
  //   return box
  // }

  // unwrapOrNull(): Nullable<T> {
  //   const value = this.unwrapOrNull()
  //   this.pool.restart(this.index)
  //   return value
  // }

  // unwrapOrThrow(): T {
  //   const value = this.unwrapOrThrow()
  //   this.pool.restart(this.index)
  //   return value
  // }

  // borrowOrNull(): Nullable<Borrow<T>> {
  //   const borrow = this.borrowOrNull()
  //   this.pool.pauseOrThrow(this.index)
  //   return borrow
  // }

  // borrowOrThrow(): Borrow<T> {
  //   const borrow = this.borrowOrThrow()
  //   this.pool.pauseOrThrow(this.index)
  //   return borrow
  // }

  // returnOrThrow(): void {
  //   this.returnOrThrow()

  //   this.pool.unpauseOrThrow(this.index)

  //   return
  // }

}

export class PoolOkEntry<T> extends Ok<PoolItem<T>> {

  constructor(
    readonly pool: Pool<T>,
    readonly index: number,
    readonly value: PoolItem<T>
  ) {
    super(value)
  }

}

export class PoolErrEntry<T> extends Err<Error> {

  constructor(
    readonly pool: Pool<T>,
    readonly index: number,
    readonly value: Error
  ) {
    super(value)
  }

}

export type PoolEvents<T> = {
  started: (index: number) => void
  created: (entry: PoolEntry<T>) => void
  deleted: (entry: PoolEntry<T>) => void
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

export class Pool<T> {

  readonly events = new SuperEventTarget<PoolEvents<T>>()

  /**
   * Sparse aborters by index
   */
  readonly #allAborters = new Array<AbortController>()

  /**
   * Sparse entry promises by index
   */
  readonly #allPromises = new Array<Promise<PoolEntry<T>>>()

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
    for (const aborter of this.#allAborters)
      aborter?.abort()

    for (const entry of this.#allEntries) {
      if (!entry.isOk())
        continue
      using stack = new Stack()

      stack.push(entry.get().value)
      stack.push(entry.get())
    }

    this.#allAborters.length = 0
    this.#allPromises.length = 0
    this.#allEntries.length = 0
  }

  async #createOrThrow(index: number, creator: PoolCreator<T>, signal: AbortSignal): Promise<PoolEntry<T>> {
    try {
      using stack = new Box(new Stack())

      const disposer = await creator({ index, signal })

      stack.getOrThrow().push(disposer)
      stack.getOrThrow().push(disposer.get())

      signal.throwIfAborted()

      stack.moveOrThrow()

      this.delete(index)

      const item = new PoolItem(this, index, disposer)
      const entry = new PoolOkEntry(this, index, item)

      this.#allEntries[index] = entry
      this.#allPromises[index] = Promise.resolve(entry)

      return entry
    } catch (e: unknown) {
      signal.throwIfAborted()

      this.delete(index)

      const value = Catched.wrap(e)
      const entry = new PoolErrEntry(this, index, value)

      this.#allEntries[index] = entry
      this.#allPromises[index] = Promise.resolve(entry)

      return entry
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

    const promise = this.#createOrThrow(index, creator, signal)

    this.#allPromises[index] = promise

    await this.events.emit("started", index)

    const entry = await promise

    await this.events.emit("created", entry)
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

    const promise = this.#allPromises.at(index)

    delete this.#allAborters[index]
    delete this.#allPromises[index]

    return promise
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

    stack.push(previous.get().value)
    stack.push(previous.get())

    return previous
  }

  async setOrThrow(index: number, result: Result<Disposer<T>, Error>) {
    if (result.isOk()) {
      const disposer = result.get()
      const item = new PoolItem(this, index, disposer)
      const entry = new PoolOkEntry(this, index, item)

      this.delete(index)

      this.#allEntries[index] = entry
      this.#allPromises[index] = Promise.resolve(entry)

      await this.events.emit("created", entry)

      return entry
    } else {
      const value = result.getErr()
      const entry = new PoolErrEntry(this, index, value)

      this.delete(index)

      this.#allEntries[index] = entry
      this.#allPromises[index] = Promise.resolve(entry)

      await this.events.emit("created", entry)

      return entry
    }
  }

  /**
   * Get the entry at index or throw if not available
   * @param index 
   * @returns the entry at index
   * @throws if empty
   */
  async getOrThrow(index: number, signal = new AbortController().signal): Promise<PoolEntry<T>> {
    const resolveOnEntry = this.#allPromises.at(index)

    if (resolveOnEntry == null)
      throw new EmptySlotError()

    using rejectOnAbort = Signals.rejectOnAbort(signal)

    return await Promise.race([resolveOnEntry, rejectOnAbort.get()])
  }

  /**
   * Get the entry at index or throw if not available
   * @param index 
   * @returns the entry at index
   * @throws if empty
   */
  getSyncOrThrow(index: number): PoolEntry<T> {
    const entry = this.#allEntries.at(index)

    if (entry == null)
      throw new EmptySlotError()

    return entry
  }

  // /**
  //  * Get a random entry from the pool using Math's PRNG or throw if none available
  //  * @returns 
  //  */
  // async getRandomOrThrow(signal = new AbortController().signal): Promise<PoolItem<T>> {
  //   while (true) {
  //     using rejectOnAbort = Signals.rejectOnAbort(signal)
  //     const resolveOnFirst = Promise.any(this.#okPromises)

  //     await Promise.race([resolveOnFirst, rejectOnAbort.get()])

  //     try {
  //       return this.getRandomSyncOrThrow()
  //     } catch (e: unknown) {
  //       console.error(e)
  //       continue
  //     }
  //   }
  // }

  // /**
  //  * Get a random entry from the pool using Math's PRNG or throw if none available
  //  * @returns 
  //  */
  // getRandomSyncOrThrow(): PoolItem<T> {
  //   const entry = Arrays.random([...this.#allEntries.filter(x => x.isOk() && !x.get().borrowed) as PoolOkEntry<T>[]])

  //   if (entry == null)
  //     throw new EmptyPoolError()

  //   return entry.get()
  // }

  // /**
  //  * Get a random entry from the pool using WebCrypto's CSPRNG or throw if none available
  //  * @returns 
  //  */
  // async getCryptoRandomOrThrow(signal = new AbortController().signal): Promise<PoolItem<T>> {
  //   while (true) {
  //     await Plume.waitOrThrow(this.events, "created", (x, y) => x.resolve(y), signal)

  //     try {
  //       return this.getCryptoRandomSyncOrThrow()
  //     } catch (e: unknown) {
  //       continue
  //     }
  //   }
  // }

  // /**
  //  * Get a random entry from the pool using WebCrypto's CSPRNG or throw if none available
  //  * @returns 
  //  */
  // getCryptoRandomSyncOrThrow(): PoolItem<T> {
  //   const entry = Arrays.cryptoRandom([...this.#okEntries])

  //   if (entry == null)
  //     throw new EmptyPoolError()

  //   return entry.get()
  // }

}