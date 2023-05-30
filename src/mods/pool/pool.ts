import { Arrays } from "@hazae41/arrays";
import { SuperEventTarget } from "@hazae41/plume";
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

export interface PoolEntry<T> {
  readonly index: number,
  readonly element: T
}

export type PoolEvents<T> = {
  created: PoolEntry<T>
  deleted: PoolEntry<T>
  errored: unknown
}

export class EmptyPoolError extends Error {
  readonly #class = EmptyPoolError
  readonly name = this.#class.name

  constructor() {
    super(`Empty pool`)
  }
}

export class Pool<T> {

  readonly events = new SuperEventTarget<PoolEvents<T>>()

  readonly capacity: number

  readonly signal: AbortSignal

  readonly #controller: AbortController

  readonly #allElements: T[]
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

    for (let index = 0; index < capacity; index++)
      this.#start(index)

    this.signal.addEventListener("abort", this.#onClose.bind(this))
  }

  #start(index: number) {
    const promise = this.#createOrThrow(index)
    this.#allPromises[index] = promise
    promise.catch(e => this.close(e))
  }

  close(reason?: unknown) {
    this.#controller.abort(reason)
  }

  get closed() {
    if (!this.signal.aborted)
      return undefined
    return { reason: this.signal.reason }
  }

  async #onClose() {
    const reason = this.signal.reason

    await this.events.tryEmit("errored", reason)
      .catch(Catched.fromAndThrow)
      .then(r => r.unwrap())
      .catch(e => console.error({ e }))

    console.error("Pool", { reason })
  }

  async #createOrThrow(index: number) {
    const { signal } = this

    const element = await this.create({ pool: this, index, signal })
      .catch(Catched.fromAndThrow)
      .then(r => r.unwrap())

    await this.events.tryEmit("created", { index, element })
      .catch(Catched.fromAndThrow)
      .then(r => r.unwrap())
      .catch(e => console.error({ e }))

    this.#allElements[index] = element
    this.#openElements.add(element)

    return element
  }

  /**
   * Delete the index at the given element, restart the index, and return the index
   * @param element 
   * @returns 
   */
  async delete(element: T) {
    const index = this.#allElements.indexOf(element)

    if (index === -1)
      return

    delete this.#allElements[index]
    this.#openElements.delete(element)

    await this.events.tryEmit("deleted", { index, element })
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
  async get(index: number) {
    return this.#allPromises[index]
  }

  /**
   * Get the element (or undefined) at index
   * @param index 
   * @returns 
   */
  getSync(index: number) {
    return this.#allElements.at(index)
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

}