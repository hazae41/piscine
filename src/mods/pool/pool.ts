import { Arrays } from "@hazae41/arrays";
import { Box, MaybeDisposable } from "@hazae41/box";
import { Disposable, Disposer } from "@hazae41/cleaner";
import { Future } from "@hazae41/future";
import { Mutex } from "@hazae41/mutex";
import { None } from "@hazae41/option";
import { Plume, SuperEventTarget } from "@hazae41/plume";
import { Err, Ok, Panic, Result } from "@hazae41/result";
import { AbortSignals } from "libs/signals/signals.js";

export interface PoolParams {
  readonly capacity?: number
}

export interface PoolCreatorParams<T extends MaybeDisposable> {
  readonly pool: Pool<T>
  readonly index: number
}

export type PoolCreator<T extends MaybeDisposable> =
  (params: PoolCreatorParams<T>) => Promise<Result<Disposer<Box<T>>, Error>>

export interface PoolEntry<T> {
  readonly index: number,
  readonly value: T
}

export namespace PoolEntry {

  export function mapSync<X, Y>(entry: PoolEntry<X>, f: (x: X) => Y): PoolEntry<Y> {
    return { index: entry.index, value: f(entry.value) }
  }

}

export type PoolResultEntry<T extends MaybeDisposable> =
  | PoolEntry<Result<Disposer<Box<T>>, Error>>

export type PoolOkEntry<T extends MaybeDisposable> =
  | PoolEntry<Ok<Disposer<Box<T>>>>


export namespace PoolOkEntry {

  export function is<T extends MaybeDisposable>(entry: PoolResultEntry<T>): entry is PoolOkEntry<T> {
    return entry.value.isOk()
  }

}

export type PoolEvents<T extends MaybeDisposable> = {
  started: (index: number) => void
  created: (entry: PoolEntry<Result<Box<T>, Error>>) => void
  deleted: (entry: PoolEntry<Result<Box<T>, Error>>) => void
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

  readonly mutex = new Mutex(undefined)

  /**
   * Entry by index, can be sparse
   */
  readonly #allEntries: PoolEntry<Result<Disposer<Box<T>>, Error>>[]

  /**
   * Promise by index, can be sparse
   */
  readonly #allPromises: Promise<PoolEntry<Ok<Disposer<Box<T>>>>>[]

  /**
   * Entries that are ok
   */
  readonly #okEntries = new Set<PoolEntry<Ok<Disposer<Box<T>>>>>()

  /**
   * Promises that are started (running or settled)
   */
  readonly #okPromises = new Set<Promise<PoolEntry<Ok<Disposer<Box<T>>>>>>()

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

    this.#allEntries = new Array(capacity)
    this.#allPromises = new Array(capacity)

    for (let index = 0; index < capacity; index++)
      this.#start(index).catch(console.warn)
  }

  /**
   * Whether all entries are errored
   */
  get stagnant() {
    return this.#allEntries.every(entry => entry.value.isErr())
  }

  async #start(index: number) {
    const promise = this.#createOrThrow(index)

    /**
     * Set promise as handled
     */
    promise.catch(() => { })

    this.#allPromises[index] = promise
    this.#okPromises.add(promise)

    await this.events.emit("started", [index])
  }

  async #createOrThrow(index: number): Promise<PoolEntry<Ok<Disposer<Box<T>>>>> {
    const value = await Result.runAndDoubleWrap(async () => {
      return await this.creator({ pool: this, index })
    }).then(r => r.flatten())

    if (value.isOk()) {
      const entry = { index, value }

      this.#allEntries[index] = entry
      this.#okEntries.add(entry)

      await this.events.emit("created", [PoolEntry.mapSync(entry, x => x.mapSync(x => x.inner))])

      return entry
    }

    const entry = { index, value }

    this.#allEntries[index] = entry

    await this.events.emit("created", [entry])

    throw value.inner
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
      await Disposable.dispose(entry.value.inner)
      await Disposable.dispose(entry.value.inner.inner)
      this.#okEntries.delete(entry)
    }

    delete this.#allEntries[index]

    await this.events.emit("deleted", [PoolEntry.mapSync(entry, x => x.mapSync(x => x.inner))])

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
  async tryGetOrWait(index: number, signal = AbortSignals.never()): Promise<Result<Box<T>, Error>> {
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
  async tryGet(index: number): Promise<Result<Result<Box<T>, Error>, EmptySlotError>> {
    await this.mutex.promise

    const slot = this.#allPromises.at(index)

    if (slot === undefined)
      return new Err(new EmptySlotError())

    try {
      return new Ok(new Ok(await slot.then(r => r.value.inner.inner)))
    } catch (e: unknown) {
      return new Ok(new Err(e as Error))
    }
  }

  /**
   * Get the element at index, err if empty
   * @param index 
   * @returns 
   */
  async tryGetSync(index: number): Promise<Result<Result<Box<T>, Error>, EmptySlotError>> {
    await this.mutex.promise

    const slot = this.#allEntries.at(index)

    if (slot === undefined)
      return new Err(new EmptySlotError())

    return new Ok(slot.value.mapSync(x => x.inner))
  }

  /**
   * Wait for any element to be created, then get a random one using Math's PRNG
   * @returns 
   */
  async tryGetRandom(): Promise<Result<PoolEntry<Box<T>>, AggregateError>> {
    return await Result.unthrow(async t => {
      await this.mutex.promise

      const first = await Result
        .runAndWrap(() => Promise.any(this.#okPromises))
        .then(r => r.throw(t as any))

      const random = await this.tryGetRandomSync()

      if (random.isOk())
        return random

      /**
       * The element has been deleted already?
       */
      console.error(`Could not get random element`, { first })
      throw Panic.from(new Error(`Could not get random element`))
    })
  }

  /**
   * Get a random element from the pool using Math's PRNG, throws if none available
   * @returns 
   */
  async tryGetRandomSync(): Promise<Result<PoolEntry<Box<T>>, EmptyPoolError>> {
    await this.mutex.promise

    if (this.#okEntries.size === 0)
      return new Err(new EmptyPoolError())

    const entries = [...this.#okEntries]
    const entry = Arrays.random(entries)!

    return new Ok(PoolEntry.mapSync(entry, x => x.inner.inner))
  }

  /**
   * Wait for any element to be created, then get a random one using WebCrypto's CSPRNG
   * @returns 
   */
  async tryGetCryptoRandom(): Promise<Result<PoolEntry<Box<T>>, AggregateError>> {
    return await Result.unthrow(async t => {
      await this.mutex.promise

      const first = await Result
        .runAndWrap(() => Promise.any(this.#okPromises))
        .then(r => r.throw(t as any))

      const random = await this.tryGetCryptoRandomSync()

      if (random.isOk())
        return random

      /**
       * The element has been deleted already?
       */
      console.error(`Could not get random element`, { first })
      throw Panic.from(new Error(`Could not get random element`))
    })
  }

  /**
   * Get a random element from the pool using WebCrypto's CSPRNG
   * @returns 
   */
  async tryGetCryptoRandomSync(): Promise<Result<PoolEntry<Box<T>>, EmptyPoolError>> {
    await this.mutex.promise

    if (this.#okEntries.size === 0)
      return new Err(new EmptyPoolError())

    const entries = [...this.#okEntries]
    const entry = Arrays.cryptoRandom(entries)!

    return new Ok(PoolEntry.mapSync(entry, x => x.inner.inner))
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
        const entry2 = PoolEntry.mapSync(entry, x => x.unwrapOrThrow())
        pool.restart(entry.index)
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
        const entry2 = PoolEntry.mapSync(entry, x => x.unwrapOrThrow())
        pool.restart(entry.index)
        return new Ok(entry2)
      })
    })
  }

  // static async takeRandom<PoolOutput extends SyncOrAsyncDisposable, PoolError>(pool: Mutex<Pool<PoolOutput, PoolError>>): Promise<Result<PoolOkEntry<PoolOutput>, AggregateError>> {
  //   return await pool.lock(async pool => {
  //     const result = await pool.tryGetRandom()

  //     if (result.isOk())
  //       pool.restart(result.inner.index)

  //     return result
  //   })
  // }

  // static async takeCryptoRandom<PoolOutput extends SyncOrAsyncDisposable, PoolError>(pool: Mutex<Pool<PoolOutput, PoolError>>): Promise<Result<PoolOkEntry<PoolOutput>, AggregateError>> {
  //   return await pool.lock(async pool => {
  //     const result = await pool.tryGetCryptoRandom()

  //     if (result.isOk())
  //       pool.restart(result.inner.index)

  //     return result
  //   })
  // }

}