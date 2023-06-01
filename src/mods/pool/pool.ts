import { Arrays } from "@hazae41/arrays";
import { Mutex } from "@hazae41/mutex";
import { AbortError, SuperEventTarget } from "@hazae41/plume";
import { Catched, Err, Ok, Result } from "@hazae41/result";
import { AbortSignals } from "libs/signals/signals.js";

export interface PoolParams {
  readonly capacity?: number
  readonly signal?: AbortSignal
}

export interface PoolCreatorParams<T> {
  readonly pool: Pool<T>
  readonly index: number
  readonly signal?: AbortSignal
}

export type PoolCreator<T> =
  (params: PoolCreatorParams<T>) => Promise<Result<T, unknown>>

export interface PoolEntry<T = unknown> {
  readonly index: number,
  readonly result: Result<T, unknown>
}

export interface PoolOkEntry<T = unknown> {
  readonly index: number,
  readonly result: Ok<T>
}

export namespace PoolOkEntry {
  export function is<T>(x: PoolEntry<T>): x is PoolOkEntry<T> {
    return x.result.isOk()
  }
}

export type PoolEvents<T> = {
  created: PoolEntry<T>
  deleted: PoolEntry<T>
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

  readonly capacity: number

  readonly signal: AbortSignal

  readonly #controller: AbortController

  readonly #allEntries: PoolEntry<T>[]
  readonly #allPromises: Promise<T>[]

  readonly #okEntries = new Set<PoolOkEntry<T>>()

  /**
   * A pool of circuits
   * @param tor 
   * @param params 
   */
  constructor(
    readonly create: PoolCreator<T>,
    readonly params: PoolParams = {}
  ) {
    const { capacity = 3 } = params

    this.capacity = capacity

    this.#controller = new AbortController()

    this.signal = AbortSignals.merge(this.#controller.signal, params.signal)

    this.#allPromises = new Array(capacity)
    this.#allEntries = new Array(capacity)

    for (let index = 0; index < capacity; index++)
      this.#start(index)
  }

  abort(reason?: unknown) {
    this.#controller.abort(reason)
  }

  #start(index: number) {
    const promise = this.#createAndUnwrap(index)
    this.#allPromises[index] = promise
    promise.catch(e => console.debug({ e }))
  }

  async #tryCreate(index: number): Promise<Result<T, unknown>> {
    const { signal } = this

    if (signal.aborted)
      return new Err(AbortError.from(signal.reason))

    return await this.create({ pool: this, index, signal })
  }

  async #createAndUnwrap(index: number): Promise<T> {
    const result = await Result.recatch(() => this.#tryCreate(index))

    const entry = { index, result }

    this.#allEntries[index] = entry

    if (PoolOkEntry.is(entry))
      this.#okEntries.add(entry)

    this.events.tryEmit("created", entry)
      .catch(Catched.fromAndThrow)
      .then(r => r.unwrap())
      .catch(e => console.error({ e }))

    return result.unwrap()
  }

  /**
   * Delete the index at the given element, restart the index, and return the index
   * @param element 
   * @returns 
   */
  delete(entry: PoolEntry<T>) {
    const { index } = entry

    if (entry !== this.#allEntries[index])
      return

    this.events.tryEmit("deleted", entry)
      .catch(Catched.fromAndThrow)
      .then(r => r.unwrap())
      .catch(e => console.error({ e }))

    if (PoolOkEntry.is(entry))
      this.#okEntries.delete(entry)

    delete this.#allEntries[index]

    this.#start(index)
  }

  /**
   * Number of open elements
   */
  get size() {
    return this.#okEntries.size
  }

  /**
   * Iterator on open elements
   * @returns 
   */
  [Symbol.iterator]() {
    return this.#okEntries.values()
  }

  /**
   * Get the element promise at index
   * @param index 
   * @returns 
   */
  async tryGet(index: number): Promise<PoolEntry<T>> {
    try {
      await this.#allPromises[index]
    } catch (e: unknown) { }

    return this.tryGetSync(index).unwrap()
  }

  /**
   * Get the element (or undefined) at index
   * @param index 
   * @returns 
   */
  tryGetSync(index: number): Result<PoolEntry<T>, EmptySlotError> {
    const entry = this.#allEntries.at(index)

    if (entry === undefined)
      return new Err(new EmptySlotError())

    return new Ok(entry)
  }

  /**
   * Wait for any element to be created, then get a random one using Math's PRNG
   * @returns 
   */
  async tryGetRandom(): Promise<Result<PoolOkEntry<T>, AggregateError>> {
    return await Result
      .catchAndWrap<T>(() => Promise.any(this.#allPromises))
      .then(r => r.mapErrSync(e => e.cause as AggregateError))
      .then(r => r.mapSync(() => this.tryGetRandomSync().unwrap()))
  }

  /**
   * Get a random element from the pool using Math's PRNG, throws if none available
   * @returns 
   */
  tryGetRandomSync(): Result<PoolOkEntry<T>, EmptyPoolError> {
    if (!this.#okEntries.size)
      return new Err(new EmptyPoolError())

    const entries = [...this.#okEntries]
    const entry = Arrays.random(entries)

    return new Ok(entry)
  }

  /**
   * Wait for any circuit to be created, then get a random one using WebCrypto's CSPRNG
   * @returns 
   */
  async tryGetCryptoRandom(): Promise<Result<PoolOkEntry<T>, AggregateError>> {
    return await Result
      .catchAndWrap<T>(() => Promise.any(this.#allPromises))
      .then(r => r.mapErrSync(e => e.cause as AggregateError))
      .then(r => r.mapSync(() => this.tryGetCryptoRandomSync().unwrap()))
  }

  /**
   * Get a random circuit from the pool using WebCrypto's CSPRNG, throws if none available
   * @returns 
   */
  tryGetCryptoRandomSync(): Result<PoolOkEntry<T>, EmptyPoolError> {
    if (!this.#okEntries.size)
      return new Err(new EmptyPoolError())

    const entries = [...this.#okEntries]
    const entry = Arrays.cryptoRandom(entries)

    return new Ok(entry)
  }

  static async takeRandom<T>(pool: Mutex<Pool<T>>) {
    return await pool.lock(async pool => {
      const result = await pool.tryGetRandom()

      if (result.isOk())
        pool.delete(result.inner)

      return result
    })
  }

  static async takeCryptoRandom<T>(pool: Mutex<Pool<T>>) {
    return await pool.lock(async pool => {
      const result = await pool.tryGetCryptoRandom()

      if (result.isOk())
        pool.delete(result.inner)

      return result
    })
  }

}