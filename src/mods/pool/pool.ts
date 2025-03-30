import { Arrays } from "@hazae41/arrays";
import { Borrow, Box, Stack } from "@hazae41/box";
import { Disposer } from "@hazae41/disposer";
import { Nullable } from "@hazae41/option";
import { SuperEventTarget } from "@hazae41/plume";
import { Catched, Err, Ok } from "@hazae41/result";
import { Signals } from "@hazae41/signals";

export interface PoolCreatorParams {
  readonly index: number
  readonly signal: AbortSignal
}

export type PoolCreator<T> =
  (params: PoolCreatorParams) => Promise<Disposer<Box<T>>>

export type PoolEntry<T> =
  | PoolOkEntry<T>
  | PoolErrEntry<T>

export class PoolItem<T> extends Box<T> {

  constructor(
    readonly pool: Pool<T>,
    readonly index: number,
    readonly value: T
  ) {
    super(value)
  }

  moveOrNull(): Nullable<Box<T>> {
    const box = super.moveOrNull()
    this.pool.restart(this.index)
    return box
  }

  moveOrThrow(): Box<T> {
    const box = super.moveOrThrow()
    this.pool.restart(this.index)
    return box
  }

  unwrapOrNull(): Nullable<T> {
    const value = super.unwrapOrNull()
    this.pool.restart(this.index)
    return value
  }

  unwrapOrThrow(): T {
    const value = super.unwrapOrThrow()
    this.pool.restart(this.index)
    return value
  }

  borrowOrNull(): Nullable<Borrow<T>> {
    const borrow = super.borrowOrNull()
    this.pool.pauseOrThrow(this.index)
    return borrow
  }

  borrowOrThrow(): Borrow<T> {
    const borrow = super.borrowOrThrow()
    this.pool.pauseOrThrow(this.index)
    return borrow
  }

  returnOrThrow(): void {
    super.returnOrThrow()

    this.pool.unpauseOrThrow(this.index)

    return
  }

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

  readonly #allDisposers = new Array<() => void>()

  /**
   * Sparse entry promises by index
   */
  readonly #allPromises = new Array<Promise<PoolEntry<T>>>()

  /**
   * Any promises ordered by time
   */
  readonly #anyPromises = new Set<Promise<PoolEntry<T>>>()

  /**
   * Sparse ok promises by index
   */
  readonly #allOkPromises = new Array<Promise<PoolOkEntry<T>>>()

  /**
   * Ok promises ordered by time
   */
  readonly #okPromises = new Set<Promise<PoolOkEntry<T>>>()

  /**
   * Sparse entries by index
   */
  readonly #allEntries = new Array<PoolEntry<T>>()

  /**
   * Any entries ordered by time
   */
  readonly #anyEntries = new Set<PoolEntry<T>>()

  /**
   * Ok entries ordered by time
   */
  readonly #okEntries = new Set<PoolOkEntry<T>>()

  /**
   * Err entries ordered by time
   */
  readonly #errEntries = new Set<PoolErrEntry<T>>()

  /**
   * All values by index
   */
  readonly #allValues = new Array<T>()

  /**
   * Values ordered by time
   */
  readonly #values = new Set<T>()

  /**
   * A pool of circuits
   * @param tor 
   * @param params 
   */
  constructor(
    readonly creator: PoolCreator<T>
  ) { }

  /**
   * Any entries
   */
  get anyEntries() {
    return this.#anyEntries.values()
  }

  /**
   * Ok entries
   */
  get okEntries() {
    return this.#okEntries.values()
  }

  /**
   * Err entries
   */
  get errEntries() {
    return this.#errEntries.values()
  }

  /**
   * Any promises
   */
  get anyPromises() {
    return this.#anyPromises.values()
  }

  /**
   * Ok promises
   */
  get okPromises() {
    return this.#okPromises.values()
  }

  /**
   * Values
   */
  get values() {
    return this.#values.values()
  }

  /**
   * Number of values
   */
  get size() {
    return this.#values.size
  }

  /**
   * Iterate on values
   */
  [Symbol.iterator]() {
    return this.#values.values()
  }

  async #createOrThrow(index: number, signal: AbortSignal): Promise<PoolEntry<T>> {
    try {
      using stack = new Box(new Stack())

      const created = await this.creator({ index, signal })
      stack.getOrThrow().push(created)

      signal.throwIfAborted()

      const value = created.get().getOrThrow()
      const item = new PoolItem(this, index, value)
      const entry = new PoolOkEntry(this, index, item)

      this.#allEntries[index] = entry
      this.#anyEntries.add(entry)
      this.#okEntries.add(entry)

      this.#allValues[index] = value
      this.#values.add(value)

      this.#allDisposers[index] = () => created.dispose()

      this.events.emit("created", entry).catch(console.error)

      stack.unwrapOrThrow()

      return entry
    } catch (e: unknown) {
      signal.throwIfAborted()

      const value = Catched.wrap(e)
      const entry = new PoolErrEntry(this, index, value)

      this.#allEntries[index] = entry
      this.#anyEntries.add(entry)
      this.#errEntries.add(entry)

      this.events.emit("created", entry).catch(console.error)

      return entry
    }
  }

  /**
   * Start the index
   * @param index 
   * @returns 
   */
  start(index: number) {
    if (this.#allPromises.at(index) != null)
      return

    const aborter = new AbortController()
    this.#allAborters[index] = aborter
    const { signal } = aborter

    const resolveOnEntry = this.#createOrThrow(index, signal)

    resolveOnEntry.catch(() => { })

    this.#allPromises[index] = resolveOnEntry
    this.#anyPromises.add(resolveOnEntry)

    const resolveOnOk = resolveOnEntry.then(entry => entry.checkOrThrow())

    resolveOnOk.catch(() => { })

    this.#allOkPromises[index] = resolveOnOk
    this.#okPromises.add(resolveOnOk)

    this.events.emit("started", index).catch(console.error)
  }

  /**
   * Stop the index and return the previous entry
   * @param index 
   * @returns 
   */
  stop(index: number) {
    const aborter = this.#allAborters.at(index)

    if (aborter != null)
      aborter.abort()

    delete this.#allAborters[index]

    const disposer = this.#allDisposers.at(index)

    if (disposer != null)
      this.#allDisposers[index]()

    delete this.#allDisposers[index]

    const resolveOnEntry = this.#allPromises.at(index)

    if (resolveOnEntry != null)
      this.#anyPromises.delete(resolveOnEntry)

    delete this.#allPromises[index]

    const resolveOnOk = this.#allOkPromises.at(index)

    if (resolveOnOk != null)
      this.#okPromises.delete(resolveOnOk)

    delete this.#allOkPromises[index]

    const value = this.#allValues.at(index)

    if (value != null)
      this.#values.delete(value)

    delete this.#allValues[index]

    const entry = this.#allEntries.at(index)

    if (entry == null)
      return

    using _ = entry.getOr(null)

    if (entry.isOk())
      this.#okEntries.delete(entry)

    if (entry.isErr())
      this.#errEntries.delete(entry)

    this.#anyEntries.delete(entry)

    delete this.#allEntries[index]

    this.events.emit("deleted", entry).catch(console.error)

    return entry
  }

  pauseOrThrow(index: number) {
    const entry = this.#allEntries.at(index)

    if (entry == null)
      throw new EmptySlotError()

    this.#okEntries.delete(entry.checkOrThrow())

    const resolveOnOk = this.#allOkPromises.at(index)

    if (resolveOnOk == null)
      throw new Error()

    this.#okPromises.delete(resolveOnOk)
    delete this.#allOkPromises[index]

    const resolveOnReturn = resolveOnEntry.then(() => entry.checkOrThrow())

    resolveOnOk.catch(() => { })

    this.#allOkPromises[index] = resolveOnOk
    this.#okPromises.add(resolveOnOk)
  }

  unpauseOrThrow(index: number) {
    const entry = this.#allEntries.at(index)

    if (entry == null)
      throw new EmptySlotError()

    this.#okEntries.add(entry.checkOrThrow())

    const resolveOnOk = this.#allOkPromises.at(index)

    if (resolveOnOk == null)
      throw new Error()

    this.#okPromises.add(resolveOnOk)
  }

  /**
   * Restart the index and return the previous entry
   * @returns 
   */
  restart(index: number) {
    const entry = this.stop(index)
    this.start(index)
    return entry
  }

  /**
   * Get the entry at index or throw if not available
   * @param index 
   * @returns the entry at index
   * @throws if empty
   */
  async getOrThrow(index: number, signal = new AbortController().signal): Promise<PoolEntry<T>> {
    const resolveOnEntry = this.#allPromises.at(index)

    if (resolveOnEntry === undefined)
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

    if (entry === undefined)
      throw new EmptySlotError()

    return entry
  }

  /**
   * Get a random entry from the pool using Math's PRNG or throw if none available
   * @returns 
   */
  async getRandomOrThrow(signal = new AbortController().signal): Promise<PoolItem<T>> {
    while (true) {
      using rejectOnAbort = Signals.rejectOnAbort(signal)
      const resolveOnFirst = Promise.any(this.#okPromises)

      await Promise.race([resolveOnFirst, rejectOnAbort.get()])

      try {
        return this.getRandomSyncOrThrow()
      } catch (e: unknown) {
        console.error(e)
        continue
      }
    }
  }

  /**
   * Get a random entry from the pool using Math's PRNG or throw if none available
   * @returns 
   */
  getRandomSyncOrThrow(): PoolItem<T> {
    const entry = Arrays.random([...this.#okEntries])

    if (entry == null)
      throw new EmptyPoolError()

    return entry.get()
  }

  /**
   * Get a random entry from the pool using WebCrypto's CSPRNG or throw if none available
   * @returns 
   */
  async getCryptoRandomOrThrow(signal = new AbortController().signal): Promise<PoolItem<T>> {
    while (true) {
      using rejectOnAbort = Signals.rejectOnAbort(signal)
      const resolveOnFirst = Promise.any(this.#okPromises)

      await Promise.race([resolveOnFirst, rejectOnAbort.get()])

      try {
        return this.getCryptoRandomSyncOrThrow()
      } catch (e: unknown) {
        console.error(e)
        continue
      }
    }
  }

  /**
   * Get a random entry from the pool using WebCrypto's CSPRNG or throw if none available
   * @returns 
   */
  getCryptoRandomSyncOrThrow(): PoolItem<T> {
    const entry = Arrays.cryptoRandom([...this.#okEntries])

    if (entry == null)
      throw new EmptyPoolError()

    return entry.get()
  }

}