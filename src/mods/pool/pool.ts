import { Arrays } from "@hazae41/arrays";
import { Disposable, MaybeAsyncDisposable } from "@hazae41/cleaner";
import { Future } from "@hazae41/future";
import { Mutex } from "@hazae41/mutex";
import { None } from "@hazae41/option";
import { AbortedError, Plume, SuperEventTarget } from "@hazae41/plume";
import { Catched, Err, Ok, Panic, Result } from "@hazae41/result";
import { AbortSignals } from "libs/signals/signals.js";

export interface PoolParams {
  readonly capacity?: number
  readonly signal?: AbortSignal
}

export interface PoolCreatorParams<PoolOutput extends MaybeAsyncDisposable = MaybeAsyncDisposable, PoolError = unknown> {
  readonly pool: Pool<PoolOutput, PoolError>
  readonly index: number
  readonly signal?: AbortSignal
}

export type PoolCreator<PoolOutput extends MaybeAsyncDisposable = MaybeAsyncDisposable, PoolError = unknown> =
  (params: PoolCreatorParams<PoolOutput, PoolError>) => Promise<Result<PoolOutput, PoolError>>

export interface PoolEntry<PoolOutput = unknown, PoolError = unknown> {
  readonly index: number,
  readonly result: Result<PoolOutput, PoolError | AbortedError | Catched>
}

export interface PoolOkEntry<PoolOutput = unknown> {
  readonly index: number,
  readonly result: Ok<PoolOutput>
}

export namespace PoolOkEntry {
  export function is<T, E>(x: PoolEntry<T, E>): x is PoolOkEntry<T> {
    return x.result.isOk()
  }
}

export type PoolEvents<PoolOutput = unknown, PoolError = unknown> = {
  started: (index: number) => void
  created: (entry: PoolEntry<PoolOutput, PoolError>) => void
  deleted: (entry: PoolEntry<PoolOutput, PoolError>) => void
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

export class Pool<PoolOutput extends MaybeAsyncDisposable = MaybeAsyncDisposable, PoolError = unknown> {

  #capacity: number

  readonly events = new SuperEventTarget<PoolEvents<PoolOutput, PoolError>>()

  readonly signal: AbortSignal

  readonly #controller: AbortController

  readonly mutex = new Mutex(undefined)

  /**
   * Entry by index, can be sparse
   */
  readonly #allEntries: PoolEntry<PoolOutput, PoolError>[]

  /**
   * Promise by index, can be sparse
   */
  readonly #allPromises: Promise<PoolOkEntry<PoolOutput>>[]

  /**
   * Entries that are ok
   */
  readonly #okEntries = new Set<PoolOkEntry<PoolOutput>>()

  /**
   * Promises that are started (running or settled)
   */
  readonly #okPromises = new Set<Promise<PoolOkEntry<PoolOutput>>>()

  /**
   * A pool of circuits
   * @param tor 
   * @param params 
   */
  constructor(
    readonly creator: PoolCreator<PoolOutput, PoolError>,
    readonly params: PoolParams = {}
  ) {
    const { capacity = 3 } = params

    this.#capacity = capacity

    this.#controller = new AbortController()

    this.signal = AbortSignals.merge(this.#controller.signal, params.signal)

    this.#allEntries = new Array(capacity)
    this.#allPromises = new Array(capacity)

    for (let index = 0; index < capacity; index++)
      this.#start(index).catch(console.warn)
  }

  /**
   * Whether all entries are errored
   */
  get stagnant() {
    return this.#allEntries.every(entry => entry.result.isErr())
  }

  abort(reason?: unknown) {
    this.#controller.abort(reason)
  }

  async #start(index: number) {
    const promise = this.#createAndUnwrap(index)
    this.#allPromises[index] = promise
    this.#okPromises.add(promise)

    /**
     * Set promise as handled
     */
    promise.catch(() => { })

    await this.events.emit("started", [index])
  }

  async #tryCreate(index: number): Promise<Result<PoolOutput, PoolError | AbortedError>> {
    const { signal } = this

    if (signal.aborted)
      return new Err(AbortedError.from(signal.reason))

    return await this.creator({ pool: this, index, signal })
  }

  async #createAndUnwrap(index: number): Promise<PoolOkEntry<PoolOutput>> {
    const result = await Result.runAndDoubleWrap(() => {
      return this.#tryCreate(index)
    }).then(Result.flatten)

    if (result.isOk()) {
      const entry = { index, result }

      this.#allEntries[index] = entry
      this.#okEntries.add(entry)

      await this.events.emit("created", [entry])

      return entry
    } else {
      const entry = { index, result }

      this.#allEntries[index] = entry

      await this.events.emit("created", [entry])

      throw result.inner
    }
  }

  async #delete(index: number) {
    const entry = this.#allEntries.at(index)

    if (entry == null)
      return undefined

    const promise = this.#allPromises.at(index)

    if (promise == null)
      throw Panic.from(new Error(`Promise is null`))

    this.#okPromises.delete(promise)
    delete this.#allPromises[index]

    if (PoolOkEntry.is(entry)) {
      await Disposable.dispose(entry.result.inner)
      this.#okEntries.delete(entry)
    }

    delete this.#allEntries[index]

    await this.events.emit("deleted", [entry])

    return entry
  }

  /**
   * Restart the index and return the previous entry
   * @param element 
   * @returns 
   */
  async restart(index: number) {
    return await this.mutex.lock(async () => {
      const entry = await this.#delete(index)
      await this.#start(index)
      return entry
    })
  }

  /**
   * Modify capacity
   * @param capacity 
   * @returns 
   */
  async growOrShrink(capacity: number) {
    return await this.mutex.lock(async () => {
      if (capacity > this.#capacity) {
        const previous = this.#capacity
        this.#capacity = capacity

        for (let i = previous; i < capacity; i++)
          await this.#start(i)

        return previous
      } else if (capacity < this.#capacity) {
        const previous = this.#capacity
        this.#capacity = capacity

        for (let i = capacity; i < previous; i++)
          await this.#delete(i)

        return previous
      }

      return this.#capacity
    })
  }

  /**
   * Number of open elements
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
   * Iterator on open elements
   * @returns 
   */
  [Symbol.iterator]() {
    return this.#okEntries.values()
  }

  /**
   * Get the element at index, if still loading, wait for it, if not started, wait for started until signal, and wait for it
   * @param index 
   * @param signal 
   * @returns 
   */
  async tryGetOrWait(index: number, signal = AbortSignals.never()): Promise<Result<PoolOutput, PoolError | AbortedError | Catched>> {
    const current = await this.tryGet(index)

    if (current.isOk())
      return current.inner

    const aborted = await Plume.tryWaitOrSignal(this.events, "started", (future: Future<Ok<void>>, i) => {
      if (i !== index)
        return new None()
      future.resolve(Ok.void())
      return new None()
    }, signal)

    if (aborted.isErr())
      return aborted

    return await this.tryGet(index).then(r => r.unwrap())
  }

  /**
   * Get the element at index, if still loading, wait for it, err if not started
   * @param index 
   * @returns 
   */
  async tryGet(index: number): Promise<Result<Result<PoolOutput, PoolError | AbortedError | Catched>, EmptySlotError>> {
    await this.mutex.promise

    const slot = this.#allPromises.at(index)

    if (slot === undefined)
      return new Err(new EmptySlotError())

    try {
      return new Ok(await slot.then(r => r.result))
    } catch (e: unknown) {
      return new Ok(new Err(e as PoolError))
    }
  }

  /**
   * Get the element at index, err if empty
   * @param index 
   * @returns 
   */
  async tryGetSync(index: number): Promise<Result<Result<PoolOutput, PoolError | AbortedError | Catched>, EmptySlotError>> {
    await this.mutex.promise

    const slot = this.#allEntries.at(index)

    if (slot === undefined)
      return new Err(new EmptySlotError())

    return new Ok(slot.result)
  }

  /**
   * Wait for any element to be created, then get a random one using Math's PRNG
   * @returns 
   */
  async tryGetRandom(): Promise<Result<PoolOkEntry<PoolOutput>, AggregateError>> {
    await this.mutex.promise

    const first = await Result
      .runAndWrap(() => Promise.any(this.#okPromises))
      .then(r => r.mapErrSync(e => e as AggregateError))

    if (first.isErr())
      return first

    const random = await this.tryGetRandomSync()

    if (random.isOk())
      return random
    /**
     * The element has been deleted already?
     */
    console.error(`Could not get random element`, { first })
    throw Panic.from(new Error(`Could not get random element`))
  }

  /**
   * Get a random element from the pool using Math's PRNG, throws if none available
   * @returns 
   */
  async tryGetRandomSync(): Promise<Result<PoolOkEntry<PoolOutput>, EmptyPoolError>> {
    await this.mutex.promise

    if (this.#okEntries.size === 0)
      return new Err(new EmptyPoolError())

    const entries = [...this.#okEntries]
    const entry = Arrays.random(entries)!

    return new Ok(entry)
  }

  /**
   * Wait for any element to be created, then get a random one using WebCrypto's CSPRNG
   * @returns 
   */
  async tryGetCryptoRandom(): Promise<Result<PoolOkEntry<PoolOutput>, AggregateError>> {
    await this.mutex.promise

    const first = await Result
      .runAndWrap(() => Promise.any(this.#okPromises))
      .then(r => r.mapErrSync(e => e as AggregateError))

    if (first.isErr())
      return first

    const random = await this.tryGetCryptoRandomSync()

    if (random.isOk())
      return random
    /**
     * The element has been deleted already?
     */
    console.error(`Could not get random element`, { first })
    throw Panic.from(new Error(`Could not get random element`))
  }

  /**
   * Get a random element from the pool using WebCrypto's CSPRNG, throws if none available
   * @returns 
   */
  async tryGetCryptoRandomSync(): Promise<Result<PoolOkEntry<PoolOutput>, EmptyPoolError>> {
    await this.mutex.promise

    if (this.#okEntries.size === 0)
      return new Err(new EmptyPoolError())

    const entries = [...this.#okEntries]
    const entry = Arrays.cryptoRandom(entries)!

    return new Ok(entry)
  }

  static async takeRandom<PoolOutput extends MaybeAsyncDisposable, PoolError>(pool: Mutex<Pool<PoolOutput, PoolError>>): Promise<Result<PoolOkEntry<PoolOutput>, AggregateError>> {
    return await pool.lock(async pool => {
      const result = await pool.tryGetRandom()

      if (result.isOk())
        pool.restart(result.inner.index)

      return result
    })
  }

  static async takeCryptoRandom<PoolOutput extends MaybeAsyncDisposable, PoolError>(pool: Mutex<Pool<PoolOutput, PoolError>>): Promise<Result<PoolOkEntry<PoolOutput>, AggregateError>> {
    return await pool.lock(async pool => {
      const result = await pool.tryGetCryptoRandom()

      if (result.isOk())
        pool.restart(result.inner.index)

      return result
    })
  }

}