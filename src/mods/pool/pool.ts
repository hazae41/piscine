import { Arrays } from "@hazae41/arrays";
import { Box } from "@hazae41/box";
import { Disposer } from "@hazae41/disposer";
import { Mutex } from "@hazae41/mutex";
import { SuperEventTarget } from "@hazae41/plume";
import { Catched, Err, Ok, Result } from "@hazae41/result";
import { Signals } from "@hazae41/signals";

export interface PoolParams {
  readonly capacity?: number
}

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

  #capacity: number

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
    const resolveOnEntry = this.#createOrThrow(index)

    resolveOnEntry.catch(() => { })

    this.#allPromises[index] = resolveOnEntry

    const resolveOnOk = resolveOnEntry.then(entry => entry.check())

    resolveOnOk.catch(() => { })

    this.#allOkPromises[index] = resolveOnOk
    this.#okPromises.add(resolveOnOk)

    this.events.emit("started", index).catch(console.error)
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

  #delete(index: number) {
    const aborter = this.#allAborters.at(index)

    if (aborter != null) {
      aborter.abort()
      delete this.#allAborters[index]
    }

    const resolveOnOk = this.#allOkPromises.at(index)

    if (resolveOnOk != null)
      this.#okPromises.delete(resolveOnOk)

    delete this.#allOkPromises[index]
    delete this.#allPromises[index]

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

      this.events.emit("deleted", entry).catch(console.error)

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

  /**
   * Get the entry at index or throw if not available
   * @param index 
   * @returns the entry at index
   * @throws if empty
   */
  async tryGetRaw(index: number, signal?: AbortSignal): Promise<Result<PoolEntry<T>, Error>> {
    return await Result.runAndDoubleWrap(() => this.getRawOrThrow(index, signal))
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
  async tryGet(index: number, signal?: AbortSignal): Promise<Result<T, Error>> {
    return await Result.runAndDoubleWrap(() => this.getOrThrow(index, signal))
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
  tryGetRawSync(index: number): Result<PoolEntry<T>, Error> {
    return Result.runAndDoubleWrapSync(() => this.getRawSyncOrThrow(index))
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
  tryGetSync(index: number): Result<T, Error> {
    return Result.runAndDoubleWrapSync(() => this.getSyncOrThrow(index))
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
   * Get a random entry using Math's PRNG
   * @returns 
   */
  async tryGetRawRandom(signal?: AbortSignal): Promise<Result<PoolEntry<T>, Error>> {
    return await Result.runAndDoubleWrap(() => this.getRawRandomOrThrow(signal))
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
  async tryGetRandom(signal?: AbortSignal): Promise<Result<T, Error>> {
    return await Result.runAndDoubleWrap(() => this.getRandomOrThrow(signal))
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
  tryGetRawRandomSync(): Result<PoolEntry<T>, Error> {
    return Result.runAndDoubleWrapSync(() => this.getRawRandomSyncOrThrow())
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
  tryGetRandomSync(): Result<T, Error> {
    return Result.runAndDoubleWrapSync(() => this.getRandomSyncOrThrow())
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
  async tryGetRawCryptoRandom(signal?: AbortSignal): Promise<Result<PoolEntry<T>, Error>> {
    return await Result.runAndDoubleWrap(() => this.getRawCryptoRandomOrThrow(signal))
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
   * Get a random entry from the pool using WebCrypto's CSPRNG or throw if none available
   * @returns 
   */
  async tryGetCryptoRandom(signal?: AbortSignal): Promise<Result<T, Error>> {
    return await Result.runAndDoubleWrap(() => this.getCryptoRandomOrThrow(signal))
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
  tryGetRawCryptoRandomSync(): Result<PoolEntry<T>, Error> {
    return Result.runAndDoubleWrapSync(() => this.getRawCryptoRandomSyncOrThrow())
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
   * Get a random entry from the pool using WebCrypto's CSPRNG or throw if none available
   * @returns 
   */
  tryGetCryptoRandomSync(): Result<T, Error> {
    return Result.runAndDoubleWrapSync(() => this.getCryptoRandomSyncOrThrow())
  }

  /**
   * Get a random element from the pool using WebCrypto's CSPRNG or throw if none available
   * @returns 
   */
  getCryptoRandomSyncOrThrow(): T {
    return this.getRawCryptoRandomSyncOrThrow().unwrap().get().getOrThrow()
  }

  /**
   * Take a random element from the pool using Math's PRNG or throw if none available
   * @returns 
   */
  tryTakeRawRandomSync(): Result<PoolEntry<T>, Error> {
    return Result.runAndDoubleWrapSync(() => this.takeRawRandomSyncOrThrow())
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
    return this.takeRawRandomSyncOrThrow().unwrap().get().getOrThrow()
  }

  /**
   * Take a random entry from the pool using Math's PRNG or throw if none available
   * @returns 
   */
  static async takeRandomOrThrow<T>(pool: Mutex<Pool<T>>, signal = Signals.never()) {
    return await pool.lock(async pool => {
      const entry = await pool.getRawRandomOrThrow(signal)

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
  static async tryTakeRandom<T>(pool: Mutex<Pool<T>>, signal?: AbortSignal): Promise<Result<PoolEntry<T>, Error>> {
    return await Result.runAndDoubleWrap(() => this.takeRandomOrThrow(pool, signal))
  }

  /**
   * Take a random element from the pool using WebCrypto's CSPRNG
   * @param pool 
   * @returns 
   */
  static takeCryptoRandomSyncOrThrow<T>(pool: Pool<T>) {
    const entry = pool.getRawCryptoRandomSyncOrThrow()

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
  static async takeCryptoRandomOrThrow<T>(pool: Mutex<Pool<T>>, signal = Signals.never()) {
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
   * Take a random element from the pool using WebCrypto's CSPRNG
   * @param pool 
   * @returns 
   */
  static async tryTakeCryptoRandom<T>(pool: Mutex<Pool<T>>, signal?: AbortSignal): Promise<Result<PoolEntry<T>, Error>> {
    return await Result.runAndDoubleWrap(() => this.takeCryptoRandomOrThrow(pool, signal))
  }

}