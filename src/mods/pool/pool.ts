import { Arrays } from "@hazae41/arrays";
import { Box } from "@hazae41/box";
import { Disposer } from "@hazae41/disposer";
import { Mutex } from "@hazae41/mutex";
import { AbortedError, SuperEventTarget } from "@hazae41/plume";
import { Err, Ok, Result } from "@hazae41/result";
import { AbortSignals } from "libs/signals/signals.js";

export interface PoolParams {
  readonly capacity?: number
}

export interface PoolCreatorParams<T> {
  readonly pool: Pool<T>
  readonly index: number
  readonly signal: AbortSignal
}

export type PoolCreator<T> =
  (params: PoolCreatorParams<T>) => Promise<Result<Disposer<Box<T>>, Error>>

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

  #capacity: number

  readonly events = new SuperEventTarget<PoolEvents<T>>()

  readonly #allAborters = new Array<AbortController>()

  /**
   * Entry by index, can be sparse
   */
  readonly #allEntries = new Array<PoolEntry<T>>()

  /**
   * Promise by index, can be sparse
   */
  readonly #allPromises = new Array<Promise<PoolOkEntry<T>>>()

  /**
   * Entries that are ok
   */
  readonly #okEntries = new Set<PoolOkEntry<T>>()

  /**
   * Entries that are err
   */
  readonly #errEntries = new Set<PoolErrEntry<T>>()

  /**
   * Promises that are started (running or settled)
   */
  readonly #startedPromises = new Set<Promise<PoolOkEntry<T>>>()

  /**
   * A pool of circuits
   * @param tor 
   * @param params 
   */
  constructor(
    readonly creator: PoolCreator<T>,
    readonly params: PoolParams = {}
  ) {
    const { capacity = 3 } = params

    this.#capacity = capacity

    for (let index = 0; index < capacity; index++)
      this.#start(index)

    return
  }

  /**
   * Number of ok elements
   */
  get size() {
    return this.#okEntries.size
  }

  /**
   * Number of slots
   */
  get capacity() {
    return this.#capacity
  }

  /**
   * Iterator on ok elements
   * @returns 
   */
  [Symbol.iterator]() {
    return this.#okEntries.values()
  }

  /**
   * Whether all entries are err
   */
  get stagnant() {
    return this.#errEntries.size === this.#capacity
  }

  #start(index: number) {
    const promise = this.#createOrThrow(index)

    /**
     * Set promise as handled
     */
    promise.catch(() => { })

    this.#allPromises[index] = promise
    this.#startedPromises.add(promise)

    this.events.emit("started", [index]).catch(console.error)
  }

  async #createOrThrow(index: number): Promise<PoolOkEntry<T>> {
    const aborter = new AbortController()
    this.#allAborters[index] = aborter
    const { signal } = aborter

    const result = await Result.runAndDoubleWrap(async () => {
      return await this.creator({ pool: this, index, signal })
    }).then(r => r.flatten())

    if (result.isOk()) {
      using inner = new Box(result.inner)

      signal.throwIfAborted()

      const entry = new PoolOkEntry(this, index, inner.unwrapOrThrow())

      this.#allEntries[index] = entry
      this.#okEntries.add(entry)

      this.events.emit("created", [entry]).catch(console.error)

      return entry
    }

    signal.throwIfAborted()

    const entry = new PoolErrEntry(this, index, result.inner)

    this.#allEntries[index] = entry
    this.#errEntries.add(entry)

    this.events.emit("created", [entry]).catch(console.error)

    throw result.inner
  }

  #delete(index: number) {
    const aborter = this.#allAborters.at(index)

    if (aborter != null) {
      aborter.abort()
      delete this.#allAborters[index]
    }

    const promise = this.#allPromises.at(index)

    if (promise != null) {
      this.#startedPromises.delete(promise)
      delete this.#allPromises[index]
    }

    const entry = this.#allEntries.at(index)

    if (entry != null) {
      if (entry.isOk()) {
        entry.inner[Symbol.dispose]()
        this.#okEntries.delete(entry)
      }

      if (entry.isErr()) {
        this.#errEntries.delete(entry)
      }

      delete this.#allEntries[index]

      this.events.emit("deleted", [entry]).catch(console.error)

      return entry
    }

    return undefined
  }

  /**
   * Restart the index and return the previous entry
   * @param element 
   * @returns 
   */
  restart(index: number) {
    const entry = this.#delete(index)
    this.#start(index)
    return entry
  }

  /**
   * Modify capacity
   * @param capacity 
   * @returns 
   */
  growOrShrink(capacity: number) {
    if (capacity > this.#capacity) {
      const previous = this.#capacity
      this.#capacity = capacity

      for (let i = previous; i < capacity; i++)
        this.#start(i)

      return previous
    } else if (capacity < this.#capacity) {
      const previous = this.#capacity
      this.#capacity = capacity

      for (let i = capacity; i < previous; i++)
        this.#delete(i)

      return previous
    }

    return this.#capacity
  }

  async getOrThrow(index: number, signal = AbortSignals.never()): Promise<PoolEntry<T>> {
    const promise = this.#allPromises.at(index)

    if (promise === undefined)
      throw new EmptySlotError()

    using abort = AbortedError.waitOrThrow(signal)
    return await Promise.race([abort.get(), promise])
  }

  /**
   * Get the element at index, if still loading, wait for it, err if not started
   * @param index 
   * @returns 
   */
  async tryGet(index: number, signal = AbortSignals.never()): Promise<Result<PoolEntry<T>, Error>> {
    return await Result.runAndDoubleWrap(() => this.getOrThrow(index, signal))
  }

  /**
   * Get the element at index, throw if empty
   * @param index 
   * @returns the element at index
   * @throws if empty
   */
  getSyncOrThrow(index: number): PoolEntry<T> {
    const entry = this.#allEntries.at(index)

    if (entry === undefined)
      throw new EmptySlotError()

    return entry
  }

  /**
   * Get the element at index, err if empty
   * @param index 
   * @returns 
   */
  tryGetSync(index: number): Result<PoolEntry<T>, Error> {
    return Result.runAndDoubleWrapSync(() => this.getSyncOrThrow(index))
  }

  /**
   * Wait for any element to be created, then get a random one using Math's PRNG
   * @returns 
   */
  async getRandomOrThrow(signal = AbortSignals.never()): Promise<PoolEntry<T>> {
    while (true) {
      using abort = AbortedError.waitOrThrow(signal)
      const first = Promise.any(this.#startedPromises)
      await Promise.race([first, abort.get()])

      try {
        return this.getRandomSyncOrThrow()
      } catch (e: unknown) {
        /**
         * The element has been deleted already?
         */
      }
    }
  }

  /**
   * Wait for any element to be created, then get a random one using Math's PRNG
   * @returns 
   */
  async tryGetRandom(signal = AbortSignals.never()): Promise<Result<PoolEntry<T>, Error>> {
    return await Result.runAndDoubleWrap(() => this.getRandomOrThrow(signal))
  }

  /**
   * Get a random element from the pool using Math's PRNG, throws if none available
   * @returns 
   */
  getRandomSyncOrThrow(): PoolEntry<T> {
    if (this.#okEntries.size === 0)
      throw new EmptyPoolError()

    const entries = [...this.#okEntries]
    return Arrays.random(entries)!
  }

  /**
   * Get a random element from the pool using Math's PRNG, throws if none available
   * @returns 
   */
  tryGetRandomSync(): Result<PoolEntry<T>, Error> {
    return Result.runAndDoubleWrapSync(() => this.getRandomSyncOrThrow())
  }

  /**
   * Wait for any element to be created, then get a random one using WebCrypto's CSPRNG
   * @returns 
   */
  async getCryptoRandomOrThrow(signal = AbortSignals.never()): Promise<PoolEntry<T>> {
    while (true) {
      using abort = AbortedError.waitOrThrow(signal)
      const first = Promise.any(this.#startedPromises)
      await Promise.race([first, abort.get()])

      try {
        return this.getCryptoRandomSyncOrThrow()
      } catch (e: unknown) {
        /**
         * The element has been deleted already?
         */
      }
    }
  }

  /**
   * Wait for any element to be created, then get a random one using WebCrypto's CSPRNG
   * @returns 
   */
  async tryGetCryptoRandom(signal = AbortSignals.never()): Promise<Result<PoolEntry<T>, Error>> {
    return await Result.runAndDoubleWrap(() => this.getCryptoRandomOrThrow(signal))
  }

  /**
   * Get a random element from the pool using WebCrypto's CSPRNG
   * @returns 
   */
  getCryptoRandomSyncOrThrow(): PoolEntry<T> {
    if (this.#okEntries.size === 0)
      throw new EmptyPoolError()

    const entries = [...this.#okEntries]
    return Arrays.cryptoRandom(entries)!
  }

  /**
   * Get a random element from the pool using WebCrypto's CSPRNG
   * @returns 
   */
  tryGetCryptoRandomSync(): Result<PoolEntry<T>, Error> {
    return Result.runAndDoubleWrapSync(() => this.getCryptoRandomSyncOrThrow())
  }

  /**
   * Take a random element from the pool using Math's PRNG
   * @param pool 
   * @returns 
   */
  static takeRandomSyncOrThrow<T>(pool: Pool<T>) {
    const entry = pool.getRandomSyncOrThrow()

    if (entry.isErr())
      return entry

    const { index, value } = entry

    const value2 = new Disposer(value.inner.moveOrThrow(), value.dispose)
    const entry2 = new PoolOkEntry(pool, index, value2)

    pool.restart(index)

    return entry2
  }

  /**
   * Take a random element from the pool using Math's PRNG
   * @param pool 
   * @returns 
   */
  static tryTakeRandomSync<T>(pool: Pool<T>): Result<PoolEntry<T>, Error> {
    return Result.runAndDoubleWrapSync(() => this.takeRandomSyncOrThrow(pool))
  }

  /**
   * Take a random element from the pool using Math's PRNG
   * @param pool 
   * @returns 
   */
  static async takeRandomOrThrow<T>(pool: Mutex<Pool<T>>, signal = AbortSignals.never()) {
    return await pool.lock(async pool => {
      const entry = await pool.getRandomOrThrow(signal)

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
   * Take a random element from the pool using Math's PRNG
   * @param pool 
   * @returns 
   */
  static async tryTakeRandom<T>(pool: Mutex<Pool<T>>, signal = AbortSignals.never()): Promise<Result<PoolEntry<T>, Error>> {
    return await Result.runAndDoubleWrap(() => this.takeRandomOrThrow(pool, signal))
  }

  /**
   * Take a random element from the pool using WebCrypto's CSPRNG
   * @param pool 
   * @returns 
   */
  static takeCryptoRandomSyncOrThrow<T>(pool: Pool<T>) {
    const entry = pool.getCryptoRandomSyncOrThrow()

    if (entry.isErr())
      return entry

    const { index, value } = entry

    const value2 = new Disposer(value.inner.moveOrThrow(), value.dispose)
    const entry2 = new PoolOkEntry(pool, index, value2)

    pool.restart(index)

    return entry2
  }

  /**
   * Take a random element from the pool using WebCrypto's CSPRNG
   * @param pool 
   * @returns 
   */
  static tryTakeCryptoRandomSync<T>(pool: Pool<T>): Result<PoolEntry<T>, Error> {
    return Result.runAndDoubleWrapSync(() => this.takeCryptoRandomSyncOrThrow(pool))
  }

  /**
   * Take a random element from the pool using WebCrypto's CSPRNG
   * @param pool 
   * @returns 
   */
  static async takeCryptoRandomOrThrow<T>(pool: Mutex<Pool<T>>, signal = AbortSignals.never()) {
    return await pool.lock(async pool => {
      const entry = await pool.getCryptoRandomOrThrow(signal)

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
   * Take a random element from the pool using WebCrypto's CSPRNG
   * @param pool 
   * @returns 
   */
  static async tryTakeCryptoRandom<T>(pool: Mutex<Pool<T>>, signal = AbortSignals.never()): Promise<Result<PoolEntry<T>, Error>> {
    return await Result.runAndDoubleWrap(() => this.takeCryptoRandomOrThrow(pool, signal))
  }

}