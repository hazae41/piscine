import { Arrays } from "@hazae41/arrays";
import { Box, MaybeDisposable } from "@hazae41/box";
import { Disposer } from "@hazae41/cleaner";
import { Future } from "@hazae41/future";
import { Mutex } from "@hazae41/mutex";
import { None } from "@hazae41/option";
import { Plume, SuperEventTarget } from "@hazae41/plume";
import { Err, Ok, Result } from "@hazae41/result";
import { AbortSignals } from "libs/signals/signals.js";

export interface PoolParams {
  readonly capacity?: number
}

export interface PoolCreatorParams<T extends MaybeDisposable> {
  readonly pool: Pool<T>
  readonly index: number
  readonly signal: AbortSignal
}

export type PoolCreator<T extends MaybeDisposable> =
  (params: PoolCreatorParams<T>) => Promise<Result<Disposer<Box<T>>, Error>>

export type PoolEntry<T extends MaybeDisposable> =
  | PoolOkEntry<T>
  | PoolErrEntry<T>

export class PoolOkEntry<T extends MaybeDisposable> extends Ok<Disposer<Box<T>>> {

  constructor(
    readonly pool: Pool<T>,
    readonly index: number,
    readonly value: Disposer<Box<T>>
  ) {
    super(value)
  }

}

export class PoolErrEntry<T extends MaybeDisposable> extends Err<Error> {

  constructor(
    readonly pool: Pool<T>,
    readonly index: number,
    readonly value: Error
  ) {
    super(value)
  }

}

export type PoolEvents<T extends MaybeDisposable> = {
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

export class Pool<T extends MaybeDisposable> {

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
      const entry = new PoolOkEntry(this, index, result.inner)

      this.#allEntries[index] = entry
      this.#okEntries.add(entry)

      await this.events.emit("created", [entry])

      return entry
    }

    const entry = new PoolErrEntry(this, index, result.inner)

    this.#allEntries[index] = entry
    this.#errEntries.add(entry)

    await this.events.emit("created", [entry])

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
        entry.inner.inner[Symbol.dispose]()
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

  /**
   * Get the entry at index, restart the subpool when the element is restarted
   * @param params 
   * @param signal 
   * @returns 
   */
  async trySync<U extends MaybeDisposable>(params: PoolCreatorParams<U>) {
    const { index, pool, signal } = params

    const result = await this.tryGetOrWait(index % this.capacity, signal)

    if (result.isErr())
      return result

    this.events.on("started", async i => {
      if (i !== (index % this.capacity))
        return new None()
      pool.restart(index)
      return new None()
    }, { passive: true, once: true })

    return new Ok(result.inner)
  }

  /**
   * Get the entry at index, if still loading, wait for it, if not started, wait for started until signal, and wait for it
   * @param index 
   * @param signal 
   * @returns 
   */
  async tryGetOrWait(index: number, signal = AbortSignals.never()): Promise<Result<PoolEntry<T>, Error>> {
    while (true) {
      const current = await this.tryGet(index)

      if (current.isOk())
        return new Ok(current.inner)

      const aborted = await Plume.tryWaitOrSignal(this.events, "started", (future: Future<Ok<void>>, i) => {
        if (i !== index)
          return new None()
        future.resolve(Ok.void())
        return new None()
      }, signal)

      if (aborted.isErr())
        return aborted

      continue
    }
  }

  /**
   * Get the element at index, if still loading, wait for it, err if not started
   * @param index 
   * @returns 
   */
  async tryGet(index: number): Promise<Result<PoolEntry<T>, EmptySlotError>> {
    const entry = this.#allPromises.at(index)

    if (entry === undefined)
      return new Err(new EmptySlotError())

    try {
      await entry
    } finally {
      return new Ok(this.#allEntries[index])
    }
  }

  /**
   * Get the element at index, err if empty
   * @param index 
   * @returns 
   */
  async tryGetSync(index: number): Promise<Result<PoolEntry<T>, EmptySlotError>> {
    const entry = this.#allEntries.at(index)

    if (entry === undefined)
      return new Err(new EmptySlotError())

    return new Ok(entry)
  }

  /**
   * Wait for any element to be created, then get a random one using Math's PRNG
   * @returns 
   */
  async tryGetRandom(): Promise<Result<PoolEntry<T>, AggregateError>> {
    return await Result.unthrow(async t => {
      while (true) {
        const first = await Result
          .runAndWrap(() => Promise.any(this.#startedPromises))
          .then(r => r.throw(t as any))

        const random = this.tryGetRandomSync()

        if (random.isOk())
          return random

        /**
         * The element has been deleted already?
         */
        console.error(`Could not get random element`, { first })
        continue
      }
    })
  }

  /**
   * Get a random element from the pool using Math's PRNG, throws if none available
   * @returns 
   */
  tryGetRandomSync(): Result<PoolEntry<T>, EmptyPoolError> {
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
  async tryGetCryptoRandom(): Promise<Result<PoolEntry<T>, AggregateError>> {
    return await Result.unthrow(async t => {
      while (true) {
        const first = await Result
          .runAndWrap(() => Promise.any(this.#startedPromises))
          .then(r => r.throw(t as any))

        const random = this.tryGetCryptoRandomSync()

        if (random.isOk())
          return random

        /**
         * The element has been deleted already?
         */
        console.error(`Could not get random element`, { first })
        continue
      }
    })
  }

  /**
   * Get a random element from the pool using WebCrypto's CSPRNG
   * @returns 
   */
  tryGetCryptoRandomSync(): Result<PoolEntry<T>, EmptyPoolError> {
    if (this.#okEntries.size === 0)
      return new Err(new EmptyPoolError())

    const entries = [...this.#okEntries]
    const entry = Arrays.cryptoRandom(entries)!

    return new Ok(entry)
  }

  /**
   * Take a random element from the pool using Math's PRNG
   * @param pool 
   * @returns 
   */
  static async tryTakeRandom<T extends MaybeDisposable>(pool: Mutex<Pool<T>>) {
    return await pool.lock(async pool => {
      return await Result.unthrow<Result<PoolEntry<T>, AggregateError>>(async t => {
        const entry = await pool.tryGetRandom().then(r => r.throw(t))

        if (entry.isErr())
          return new Ok(entry)

        const { index, value } = entry

        const value2 = value.mapSync(x => x.moveOrThrow())
        const entry2 = new PoolOkEntry(pool, index, value2)

        pool.restart(index)

        return new Ok(entry2)
      })
    })
  }

  /**
   * Take a random element from the pool using WebCrypto's CSPRNG
   * @param pool 
   * @returns 
   */
  static async tryTakeCryptoRandom<T extends MaybeDisposable>(pool: Mutex<Pool<T>>) {
    return await pool.lock(async pool => {
      return await Result.unthrow<Result<PoolEntry<T>, AggregateError>>(async t => {
        const entry = await pool.tryGetCryptoRandom().then(r => r.throw(t))

        if (entry.isErr())
          return new Ok(entry)

        const { index, value } = entry

        const value2 = value.mapSync(x => x.moveOrThrow())
        const entry2 = new PoolOkEntry(pool, index, value2)

        pool.restart(index)

        return new Ok(entry2)
      })
    })
  }

}