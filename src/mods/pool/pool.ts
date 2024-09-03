import { Arrays } from "@hazae41/arrays";
import { Box } from "@hazae41/box";
import { Disposer } from "@hazae41/disposer";
import { Mutex } from "@hazae41/mutex";
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

export class PoolOkEntry<T> extends Ok<Disposer<Box<T>>> {

  constructor(
    readonly pool: Pool<T>,
    readonly index: number,
    readonly value: Disposer<Box<T>>
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
   * Mutex
   */
  readonly #mutex = new Mutex<void>(undefined)

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
      using box = new Box(await this.creator({ index, signal }))

      signal.throwIfAborted()

      const boxed = box.getOrThrow()
      const value = boxed.get().getOrThrow()
      const entry = new PoolOkEntry(this, index, boxed)

      this.#allEntries[index] = entry
      this.#anyEntries.add(entry)
      this.#okEntries.add(entry)

      this.#allValues[index] = value
      this.#values.add(value)

      this.events.emit("created", entry).catch(console.error)

      box.unwrapOrThrow()

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

    if (entry.isOk())
      entry.get().dispose()

    if (entry.isOk())
      this.#okEntries.delete(entry)

    if (entry.isErr())
      this.#errEntries.delete(entry)

    this.#anyEntries.delete(entry)

    delete this.#allEntries[index]

    this.events.emit("deleted", entry).catch(console.error)

    return entry
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
  async getRawOrThrow(index: number, signal = new AbortController().signal): Promise<PoolEntry<T>> {
    const resolveOnEntry = this.#allPromises.at(index)

    if (resolveOnEntry === undefined)
      throw new EmptySlotError()

    using rejectOnAbort = Signals.rejectOnAbort(signal)

    return await Promise.race([resolveOnEntry, rejectOnAbort.get()])
  }

  /**
   * Get the value at index or throw if not available
   * @param index 
   * @returns the value at index
   * @throws if empty
   */
  async getOrThrow(index: number, signal = new AbortController().signal): Promise<T> {
    return await this.getRawOrThrow(index, signal).then(r => r.getOrThrow().get().getOrThrow())
  }

  /**
   * Get the entry at index or throw if not available
   * @param index 
   * @returns the entry at index
   * @throws if empty
   */
  getRawSyncOrThrow(index: number): PoolEntry<T> {
    const entry = this.#allEntries.at(index)

    if (entry === undefined)
      throw new EmptySlotError()

    return entry
  }

  /**
   * Get the value at index or throw if not available
   * @param index 
   * @returns the value at index
   * @throws if empty
   */
  getSyncOrThrow(index: number): T {
    return this.getRawSyncOrThrow(index).getOrThrow().get().getOrThrow()
  }

  /**
   * Get a random entry from the pool using Math's PRNG or throw if none available
   * @returns 
   */
  async getRawRandomOrThrow(signal = new AbortController().signal): Promise<PoolEntry<T>> {
    while (true) {
      using rejectOnAbort = Signals.rejectOnAbort(signal)
      const resolveOnFirst = Promise.any(this.#okPromises)

      await Promise.race([resolveOnFirst, rejectOnAbort.get()])

      try {
        return this.getRawRandomSyncOrThrow()
      } catch (e: unknown) {
        console.error(e)
        continue
      }
    }
  }

  /**
   * Get a random value from the pool using Math's PRNG or throw if none available
   * @returns 
   */
  async getRandomOrThrow(signal = new AbortController().signal): Promise<T> {
    return await this.getRawRandomOrThrow(signal).then(r => r.getOrThrow().get().getOrThrow())
  }

  /**
   * Get a random entry from the pool using Math's PRNG or throw if none available
   * @returns 
   */
  getRawRandomSyncOrThrow(): PoolEntry<T> {
    const entry = Arrays.random([...this.#okEntries])

    if (entry == null)
      throw new EmptyPoolError()

    return entry
  }

  /**
   * Get a random value from the pool using Math's PRNG or throw if none available
   * @returns 
   */
  getRandomSyncOrThrow(): T {
    return this.getRawRandomSyncOrThrow().getOrThrow().get().getOrThrow()
  }

  /**
   * Get a random entry from the pool using WebCrypto's CSPRNG or throw if none available
   * @returns 
   */
  async getRawCryptoRandomOrThrow(signal = new AbortController().signal): Promise<PoolEntry<T>> {
    while (true) {
      using rejectOnAbort = Signals.rejectOnAbort(signal)
      const resolveOnFirst = Promise.any(this.#okPromises)

      await Promise.race([resolveOnFirst, rejectOnAbort.get()])

      try {
        return this.getRawCryptoRandomSyncOrThrow()
      } catch (e: unknown) {
        console.error(e)
        continue
      }
    }
  }

  /**
   * Get a random value from the pool using WebCrypto's CSPRNG or throw if none available
   * @returns 
   */
  async getCryptoRandomOrThrow(signal = new AbortController().signal): Promise<T> {
    return await this.getRawCryptoRandomOrThrow(signal).then(r => r.getOrThrow().get().getOrThrow())
  }

  /**
   * Get a random entry from the pool using WebCrypto's CSPRNG or throw if none available
   * @returns 
   */
  getRawCryptoRandomSyncOrThrow(): PoolEntry<T> {
    const entry = Arrays.cryptoRandom([...this.#okEntries])

    if (entry == null)
      throw new EmptyPoolError()

    return entry
  }

  /**
   * Get a random value from the pool using WebCrypto's CSPRNG or throw if none available
   * @returns 
   */
  getCryptoRandomSyncOrThrow(): T {
    return this.getRawCryptoRandomSyncOrThrow().getOrThrow().get().getOrThrow()
  }

  /**
   * Take a random entry from the pool using Math's PRNG or throw if none available
   * @returns 
   */
  takeRawRandomSyncOrThrow(): PoolEntry<T> {
    const entry = this.getRawRandomSyncOrThrow()

    if (entry.isErr())
      return entry

    const { index, value } = entry

    const value2 = new Disposer(value.get().moveOrThrow(), () => value.dispose())
    const entry2 = new PoolOkEntry(this, index, value2)

    this.restart(index)

    return entry2
  }

  /**
   * Take a random value from the pool using Math's PRNG or throw if none available
   * @returns 
   */
  takeRandomSyncOrThrow(): T {
    return this.takeRawRandomSyncOrThrow().getOrThrow().get().unwrapOrThrow()
  }

  /**
   * Take a random entry from the pool using Math's PRNG or throw if none available
   * @returns 
   */
  async takeRawRandomOrThrow(signal = new AbortController().signal) {
    return await this.#mutex.lockOrWait(async () => {
      const entry = await this.getRawRandomOrThrow(signal)

      if (entry.isErr())
        return entry

      const { index, value } = entry

      const value2 = new Disposer(value.inner.moveOrThrow(), () => value.dispose())
      const entry2 = new PoolOkEntry(this, index, value2)

      this.restart(index)

      return entry2
    })
  }

  /**
   * Take a random value from the pool using Math's PRNG or throw if none available
   * @returns 
   */
  async takeRandomOrThrow(signal = new AbortController().signal) {
    return await this.takeRawRandomOrThrow(signal).then(r => r.getOrThrow().get().unwrapOrThrow())
  }

  /**
   * Take a random entry from the pool using WebCrypto's CSPRNG or throw if none available
   * @returns 
   */
  takeRawCryptoRandomSyncOrThrow(): PoolEntry<T> {
    const entry = this.getRawCryptoRandomSyncOrThrow()

    if (entry.isErr())
      return entry

    const { index, value } = entry

    const value2 = new Disposer(value.get().moveOrThrow(), () => value.dispose())
    const entry2 = new PoolOkEntry(this, index, value2)

    this.restart(index)

    return entry2
  }

  /**
   * Take a random value from the pool using WebCrypto's CSPRNG or throw if none available
   * @returns 
   */
  takeCryptoRandomSyncOrThrow(): T {
    return this.takeRawCryptoRandomSyncOrThrow().getOrThrow().get().unwrapOrThrow()
  }

  /**
   * Take a random entry from the pool using WebCrypto's CSPRNG or throw if none available
   * @returns 
   */
  async takeRawCryptoRandomOrThrow(signal = new AbortController().signal) {
    return await this.#mutex.lockOrWait(async () => {
      const entry = await this.getRawCryptoRandomOrThrow(signal)

      if (entry.isErr())
        return entry

      const { index, value } = entry

      const value2 = new Disposer(value.inner.moveOrThrow(), value.dispose)
      const entry2 = new PoolOkEntry(this, index, value2)

      this.restart(index)

      return entry2
    })
  }

  /**
   * Take a random value from the pool using WebCrypto's CSPRNG or throw if none available
   * @returns 
   */
  async takeCryptoRandomOrThrow(signal = new AbortController().signal) {
    return await this.takeRawCryptoRandomOrThrow(signal).then(r => r.getOrThrow().get().unwrapOrThrow())
  }

}