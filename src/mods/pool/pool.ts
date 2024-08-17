import { Arrays } from "@hazae41/arrays";
import { Box } from "@hazae41/box";
import { Disposer } from "@hazae41/disposer";
import { Mutex } from "@hazae41/mutex";
import { SuperEventTarget } from "@hazae41/plume";
import { Catched, Err, Ok } from "@hazae41/result";
import { Signals } from "@hazae41/signals";

export interface PoolCreatorParams<T> {
  readonly pool: Pool<T>
  readonly index: number
  readonly signal: AbortSignal
}

export type PoolCreator<T> =
  (params: PoolCreatorParams<T>) => Promise<Disposer<Box<T>>>

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
    super(`Empty pool slot`)
  }

}

export class Pool<T> {

  readonly events = new SuperEventTarget<PoolEvents<T>>()

  /**
   * Sparse entries by index
   */
  readonly #allEntries = new Array<PoolEntry<T>>()

  /**
   * Sparse entry promises by index
   */
  readonly #allPromises = new Array<Promise<PoolEntry<T>>>()

  /**
   * Sparse aborters by index
   */
  readonly #allAborters = new Array<AbortController>()

  /**
   * Ok entries ordered by time
   */
  readonly #okEntries = new Set<PoolOkEntry<T>>()

  /**
   * Err entries ordered by time
   */
  readonly #errEntries = new Set<PoolErrEntry<T>>()

  /**
   * Sparse ok promises by index
   */
  readonly #allOkPromises = new Array<Promise<PoolOkEntry<T>>>()

  /**
   * Ok promises ordered by time
   */
  readonly #okPromises = new Set<Promise<PoolOkEntry<T>>>()

  /**
   * A pool of circuits
   * @param tor 
   * @param params 
   */
  constructor(
    readonly creator: PoolCreator<T>
  ) { }

  /**
   * Elements
   */
  get elements() {
    return this.#okEntries
  }

  /**
   * Errors
   */
  get errors() {
    return this.#errEntries
  }

  /**
   * Promises
   */
  get promises() {
    return this.#okPromises
  }

  /**
   * Number of slots
   */
  get capacity() {
    return this.#allPromises.length
  }

  /**
   * Iterate on elements
   * @returns 
   */
  [Symbol.iterator]() {
    return this.elements.values()
  }

  async #createOrThrow(index: number): Promise<PoolEntry<T>> {
    try {
      const aborter = new AbortController()
      this.#allAborters[index] = aborter
      const { signal } = aborter

      using box = new Box(await this.creator({ pool: this, index, signal }))

      signal.throwIfAborted()

      const entry = new PoolOkEntry(this, index, box.unwrapOrThrow())

      this.#allEntries[index] = entry
      this.#okEntries.add(entry)

      this.events.emit("created", entry).catch(console.error)

      return entry
    } catch (e: unknown) {
      const entry = new PoolErrEntry(this, index, Catched.wrap(e))

      this.#allEntries[index] = entry
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

    const resolveOnEntry = this.#createOrThrow(index)

    resolveOnEntry.catch(() => { })

    this.#allPromises[index] = resolveOnEntry

    const resolveOnOk = resolveOnEntry.then(entry => entry.check())

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

    const resolveOnOk = this.#allOkPromises.at(index)

    if (resolveOnOk != null)
      this.#okPromises.delete(resolveOnOk)

    delete this.#allOkPromises[index]
    delete this.#allPromises[index]

    const entry = this.#allEntries.at(index)

    if (entry == null)
      return

    if (entry.isOk())
      entry.get().dispose()

    if (entry.isOk())
      this.#okEntries.delete(entry)

    if (entry.isErr())
      this.#errEntries.delete(entry)

    delete this.#allEntries[index]

    this.events.emit("deleted", entry).catch(console.error)

    return entry
  }

  /**
   * Restart the index and return the previous entry
   * @param element 
   * @returns 
   */
  restart(index: number) {
    const entry = this.stop(index)
    this.start(index)
    return entry
  }

  /**
   * Start all slots until index
   * @param size 
   */
  grow(index: number) {
    for (let i = 0; i < index; i++)
      this.start(i)

    return
  }

  /**
   * Stop all slots after index
   * @param size 
   * @returns 
   */
  shrink(index: number) {
    const minimum = index + 1
    const maximum = this.#allPromises.length

    for (let i = minimum; i < maximum; i++)
      this.stop(i)

    this.#allPromises.length = minimum
    this.#allEntries.length = minimum
    this.#allAborters.length = minimum
    this.#allOkPromises.length = minimum

    return
  }

  /**
   * Get the entry at index or throw if not available
   * @param index 
   * @returns the entry at index
   * @throws if empty
   */
  async getRawOrThrow(index: number, signal = Signals.never()): Promise<PoolEntry<T>> {
    const resolveOnEntry = this.#allPromises.at(index)

    if (resolveOnEntry === undefined)
      throw new EmptySlotError()

    using rejectOnAbort = Signals.rejectOnAbort(signal)

    return await Promise.race([resolveOnEntry, rejectOnAbort.get()])
  }

  /**
   * Get the element at index or throw if not available
   * @param index 
   * @returns the element at index
   * @throws if empty
   */
  async getOrThrow(index: number, signal = Signals.never()): Promise<T> {
    return await this.getRawOrThrow(index, signal).then(r => r.unwrap().get().getOrThrow())
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
   * Get the element at index or throw if not available
   * @param index 
   * @returns the element at index
   * @throws if empty
   */
  getSyncOrThrow(index: number): T {
    return this.getRawSyncOrThrow(index).unwrap().get().getOrThrow()
  }

  /**
   * Get a random entry from the pool using Math's PRNG or throw if none available
   * @returns 
   */
  async getRawRandomOrThrow(signal = Signals.never()): Promise<PoolEntry<T>> {
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
   * Get a random element from the pool using Math's PRNG or throw if none available
   * @returns 
   */
  async getRandomOrThrow(signal = Signals.never()): Promise<T> {
    return await this.getRawRandomOrThrow(signal).then(r => r.unwrap().get().getOrThrow())
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
   * Get a random element from the pool using Math's PRNG or throw if none available
   * @returns 
   */
  getRandomSyncOrThrow(): T {
    return this.getRawRandomSyncOrThrow().unwrap().get().getOrThrow()
  }

  /**
   * Get a random entry from the pool using WebCrypto's CSPRNG or throw if none available
   * @returns 
   */
  async getRawCryptoRandomOrThrow(signal = Signals.never()): Promise<PoolEntry<T>> {
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
   * Get a random element from the pool using WebCrypto's CSPRNG or throw if none available
   * @returns 
   */
  async getCryptoRandomOrThrow(signal = Signals.never()): Promise<T> {
    return await this.getRawCryptoRandomOrThrow(signal).then(r => r.unwrap().get().getOrThrow())
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
   * Get a random element from the pool using WebCrypto's CSPRNG or throw if none available
   * @returns 
   */
  getCryptoRandomSyncOrThrow(): T {
    return this.getRawCryptoRandomSyncOrThrow().unwrap().get().getOrThrow()
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
   * Take a random element from the pool using Math's PRNG or throw if none available
   * @returns 
   */
  takeRandomSyncOrThrow(): T {
    return this.takeRawRandomSyncOrThrow().unwrap().get().unwrapOrThrow()
  }

  /**
   * Take a random entry from the pool using Math's PRNG or throw if none available
   * @returns 
   */
  static async takeRawRandomOrThrow<T>(pool: Mutex<Pool<T>>, signal = Signals.never()) {
    return await pool.lock(async pool => {
      const entry = await pool.getRawRandomOrThrow(signal)

      if (entry.isErr())
        return entry

      const { index, value } = entry

      const value2 = new Disposer(value.inner.moveOrThrow(), () => value.dispose())
      const entry2 = new PoolOkEntry(pool, index, value2)

      pool.restart(index)

      return entry2
    })
  }

  /**
   * Take a random element from the pool using Math's PRNG or throw if none available
   * @returns 
   */
  static async takeRandomOrThrow<T>(pool: Mutex<Pool<T>>, signal = Signals.never()) {
    return await this.takeRawRandomOrThrow(pool, signal).then(r => r.unwrap().get().unwrapOrThrow())
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
   * Take a random element from the pool using WebCrypto's CSPRNG or throw if none available
   * @returns 
   */
  takeCryptoRandomSyncOrThrow(): T {
    return this.takeRawCryptoRandomSyncOrThrow().unwrap().get().unwrapOrThrow()
  }

  /**
   * Take a random entry from the pool using WebCrypto's CSPRNG or throw if none available
   * @returns 
   */
  static async takeRawCryptoRandomOrThrow<T>(pool: Mutex<Pool<T>>, signal = Signals.never()) {
    return await pool.lock(async pool => {
      const entry = await pool.getRawCryptoRandomOrThrow(signal)

      if (entry.isErr())
        return entry

      const { index, value } = entry

      const value2 = new Disposer(value.inner.moveOrThrow(), value.dispose)
      const entry2 = new PoolOkEntry(pool, index, value2)

      pool.restart(index)

      return entry2
    })
  }

  /**
   * Take a random element from the pool using WebCrypto's CSPRNG or throw if none available
   * @returns 
   */
  static async takeCryptoRandomOrThrow<T>(pool: Mutex<Pool<T>>, signal = Signals.never()) {
    return await this.takeRawCryptoRandomOrThrow(pool, signal).then(r => r.unwrap().get().unwrapOrThrow())
  }

}