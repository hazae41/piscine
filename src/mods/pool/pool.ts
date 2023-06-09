import { Arrays } from "@hazae41/arrays";
import { Cleaner } from "@hazae41/cleaner";
import { Mutex } from "@hazae41/mutex";
import { AbortedError, SuperEventTarget } from "@hazae41/plume";
import { Catched, Err, Ok, Result } from "@hazae41/result";
import { AbortSignals } from "libs/signals/signals.js";

export interface PoolParams {
  readonly capacity?: number
  readonly signal?: AbortSignal
}

export interface PoolCreatorParams<PoolOutput = unknown, PoolError = unknown> {
  readonly pool: Pool<PoolOutput, PoolError>
  readonly index: number
  readonly signal?: AbortSignal
}

export type PoolCreator<PoolOutput = unknown, PoolError = unknown> =
  (params: PoolCreatorParams<PoolOutput, PoolError>) => Promise<Result<Cleaner<PoolOutput>, PoolError>>

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

export class Pool<PoolOutput = unknown, PoolError = unknown> {

  readonly events = new SuperEventTarget<PoolEvents<PoolOutput, PoolError>>()

  readonly capacity: number

  readonly signal: AbortSignal

  readonly #controller: AbortController

  readonly #allEntries: PoolEntry<PoolOutput, PoolError>[]
  readonly #allCleanups: (() => void)[]
  readonly #allPromises: Promise<void>[]

  readonly #okEntries = new Set<PoolOkEntry<PoolOutput>>()

  /**
   * A pool of circuits
   * @param tor 
   * @param params 
   */
  constructor(
    readonly create: PoolCreator<PoolOutput, PoolError>,
    readonly params: PoolParams = {}
  ) {
    const { capacity = 3 } = params

    this.capacity = capacity

    this.#controller = new AbortController()

    this.signal = AbortSignals.merge(this.#controller.signal, params.signal)

    this.#allEntries = new Array(capacity)
    this.#allCleanups = new Array(capacity)
    this.#allPromises = new Array(capacity)

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

  async #tryCreate(index: number): Promise<Result<Cleaner<PoolOutput>, PoolError | AbortedError>> {
    const { signal } = this

    if (signal.aborted)
      return new Err(AbortedError.from(signal.reason))

    return await this.create({ pool: this, index, signal })
  }

  async #createAndUnwrap(index: number): Promise<void> {
    const result = await Result.recatch(() => this.#tryCreate(index))

    if (result.isOk()) {
      const ok = new Ok(result.inner.inner)
      const clean = () => result.inner.clean()

      const entry = { index, result: ok }

      this.#allEntries[index] = entry
      this.#allCleanups[index] = clean

      this.#okEntries.add(entry)

      this.events.emit("created", [entry]).catch(e => console.error({ e }))
    } else {
      const entry = { index, result }

      this.#allEntries[index] = entry

      this.events.emit("created", [entry]).catch(e => console.error({ e }))
    }

    return result.clear().unwrap()
  }

  /**
   * Delete the index, restart the index, and return the entry
   * @param element 
   * @returns 
   */
  delete(index: number) {
    const entry = this.#allEntries.at(index)

    if (entry === undefined)
      return undefined

    if (PoolOkEntry.is(entry)) {
      this.#okEntries.delete(entry)
      this.#allCleanups[index]()
      delete this.#allCleanups[index]
    }

    delete this.#allEntries[index]

    this.#start(index)

    this.events.emit("deleted", [entry]).catch(e => console.error({ e }))

    return entry
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
   * Get the element at index
   * @param index 
   * @returns 
   */
  async tryGet(index: number): Promise<Result<PoolOutput, PoolError | AbortedError | Catched>> {
    try {
      await this.#allPromises[index]
    } catch (e: unknown) { }

    return this.tryGetSync(index).unwrap()
  }

  /**
   * Get the element at index
   * @param index 
   * @returns 
   */
  tryGetSync(index: number): Result<Result<PoolOutput, PoolError | AbortedError | Catched>, EmptySlotError> {
    const entry = this.#allEntries.at(index)

    if (entry === undefined)
      return new Err(new EmptySlotError())

    return new Ok(entry.result)
  }

  /**
   * Wait for any element to be created, then get a random one using Math's PRNG
   * @returns 
   */
  async tryGetRandom(): Promise<Result<PoolOkEntry<PoolOutput>, AggregateError>> {
    return await Result
      .catchAndWrap(() => Promise.any(this.#allPromises))
      .then(r => r.mapErrSync(e => e.cause as AggregateError))
      .then(r => r.mapSync(() => this.tryGetRandomSync().unwrap()))
  }

  /**
   * Get a random element from the pool using Math's PRNG, throws if none available
   * @returns 
   */
  tryGetRandomSync(): Result<PoolOkEntry<PoolOutput>, EmptyPoolError> {
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
  async tryGetCryptoRandom(): Promise<Result<PoolOkEntry<PoolOutput>, AggregateError>> {
    return await Result
      .catchAndWrap(() => Promise.any(this.#allPromises))
      .then(r => r.mapErrSync(e => e.cause as AggregateError))
      .then(r => r.mapSync(() => this.tryGetCryptoRandomSync().unwrap()))
  }

  /**
   * Get a random circuit from the pool using WebCrypto's CSPRNG, throws if none available
   * @returns 
   */
  tryGetCryptoRandomSync(): Result<PoolOkEntry<PoolOutput>, EmptyPoolError> {
    if (!this.#okEntries.size)
      return new Err(new EmptyPoolError())

    const entries = [...this.#okEntries]
    const entry = Arrays.cryptoRandom(entries)

    return new Ok(entry)
  }

  static async takeRandom<PoolOutput, PoolError>(pool: Mutex<Pool<PoolOutput, PoolError>>): Promise<Result<PoolOkEntry<PoolOutput>, AggregateError>> {
    return await pool.lock(async pool => {
      const result = await pool.tryGetRandom()

      if (result.isOk())
        pool.delete(result.inner.index)

      return result
    })
  }

  static async takeCryptoRandom<PoolOutput, PoolError>(pool: Mutex<Pool<PoolOutput, PoolError>>): Promise<Result<PoolOkEntry<PoolOutput>, AggregateError>> {
    return await pool.lock(async pool => {
      const result = await pool.tryGetCryptoRandom()

      if (result.isOk())
        pool.delete(result.inner.index)

      return result
    })
  }

}