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
  readonly element: T
}

export type PoolEvents<T> = {
  created: PoolEntry<T>
  errored: PoolEntry<unknown>
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

  readonly #allElements: T[]
  readonly #allResults: Result<T>[]
  readonly #allPromises: Promise<T>[]

  readonly #openElements = new Set<T>()

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

    this.#allElements = new Array(capacity)
    this.#allPromises = new Array(capacity)
    this.#allResults = new Array(capacity)

    for (let index = 0; index < capacity; index++)
      this.#start(index)
  }

  abort(reason?: unknown) {
    this.#controller.abort(reason)
  }

  #start(index: number) {
    const promise = this.#tryCreateAndDoStuff(index)
      .catch(Catched.fromAndThrow)
      .then(r => r.unwrap())
    this.#allPromises[index] = promise
    promise.catch(e => console.debug({ e }))
  }

  async #tryCreate(index: number): Promise<Result<T, unknown>> {
    const { signal } = this

    if (signal.aborted)
      return new Err(AbortError.from(signal.reason))

    return await this.create({ pool: this, index, signal })
  }

  async #tryCreateAndDoStuff(index: number): Promise<Result<T, unknown>> {
    const result = await this.#tryCreate(index)

    if (result.isOk()) {
      const element = result.inner

      this.#allElements[index] = element
      this.#openElements.add(element)

      this.events.tryEmit("created", { index, element })
        .catch(Catched.fromAndThrow)
        .then(r => r.unwrap())
        .catch(e => console.error({ e }))
    } else {
      const element = result.inner

      this.events.tryEmit("errored", { index, element })
        .catch(Catched.fromAndThrow)
        .then(r => r.unwrap())
        .catch(e => console.error({ e }))
    }

    this.#allResults[index] = result

    return result
  }

  /**
   * Delete the index at the given element, restart the index, and return the index
   * @param element 
   * @returns 
   */
  delete(element: T) {
    const index = this.#allElements.indexOf(element)

    if (index === -1)
      return

    delete this.#allElements[index]
    delete this.#allResults[index]
    this.#openElements.delete(element)

    this.events.tryEmit("deleted", { index, element })
      .catch(Catched.fromAndThrow)
      .then(r => r.unwrap())
      .catch(e => console.error({ e }))

    this.#start(index)
  }

  /**
   * Number of open elements
   */
  get size() {
    return this.#openElements.size
  }

  /**
   * Iterator on open elements
   * @returns 
   */
  [Symbol.iterator]() {
    return this.#openElements.values()
  }

  /**
   * Get the index of the given element
   * @param element 
   * @returns 
   */
  indexOf(element: T) {
    return this.#allElements.indexOf(element)
  }

  /**
   * Get the element promise at index
   * @param index 
   * @returns 
   */
  async tryGet(index: number): Promise<Result<T, unknown>> {
    try {
      return new Ok(await this.#allPromises[index])
    } catch (e: unknown) {
      return Result.rethrow(e)
    }
  }

  /**
   * Get the element (or undefined) at index
   * @param index 
   * @returns 
   */
  tryGetSync(index: number): Result<T, unknown> {
    const result = this.#allResults.at(index)

    if (result === undefined)
      return new Err(new EmptySlotError())

    return result
  }

  /**
   * Wait for any element to be created, then get a random one using Math's PRNG
   * @returns 
   */
  async tryGetRandom(): Promise<Result<T, AggregateError>> {
    return await Result
      .catchAndWrap<T, AggregateError>(() => Promise.any(this.#allPromises))
      .then(r => r.mapSync(() => this.tryGetRandomSync().unwrap()))
  }

  /**
   * Get a random element from the pool using Math's PRNG, throws if none available
   * @returns 
   */
  tryGetRandomSync(): Result<T, EmptyPoolError> {
    if (!this.#openElements.size)
      return new Err(new EmptyPoolError())

    const elements = [...this.#openElements]
    const element = Arrays.random(elements)

    return new Ok(element)
  }

  /**
   * Wait for any circuit to be created, then get a random one using WebCrypto's CSPRNG
   * @returns 
   */
  async tryGetCryptoRandom(): Promise<Result<T, AggregateError>> {
    return await Result
      .catchAndWrap<T, AggregateError>(() => Promise.any(this.#allPromises))
      .then(r => r.mapSync(() => this.tryGetCryptoRandomSync().unwrap()))
  }

  /**
   * Get a random circuit from the pool using WebCrypto's CSPRNG, throws if none available
   * @returns 
   */
  tryGetCryptoRandomSync(): Result<T, EmptyPoolError> {
    if (!this.#openElements.size)
      return new Err(new EmptyPoolError())

    const elements = [...this.#openElements]
    const element = Arrays.cryptoRandom(elements)

    return new Ok(element)
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