import { Arrays } from "@hazae41/arrays";
import { SuperEventTarget } from "@hazae41/plume";

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
  (params: PoolCreatorParams<T>) => Promise<T>

export interface PoolEntry<T> {
  readonly index: number,
  readonly element: T
}

export type PoolEvents<T> = {
  created: PoolEntry<T>
  deleted: PoolEntry<T>
}

export class Pool<T> {

  readonly events = new SuperEventTarget<PoolEvents<T>>()

  readonly capacity: number

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

    this.#allElements = new Array(capacity)
    this.#allPromises = new Array(capacity)

    for (let index = 0; index < capacity; index++)
      this.#start(index)
  }

  #start(index: number) {
    const promise = this.#create(index)
    this.#allPromises[index] = promise
    promise.catch(e => console.warn({ e }))
  }

  async #create(index: number) {
    const { signal } = this.params

    const element = await this.create({ pool: this, index, signal })

    this.#allElements[index] = element
    this.#openElements.add(element)

    await this.events.tryEmit("created", { index, element }).then(r => r.unwrap())

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

    await this.events.tryEmit("deleted", { index, element }).then(r => r.unwrap())

    this.#start(index)
    return index
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
  async random() {
    await Promise.any(this.#allPromises)

    return this.randomSync()
  }

  /**
   * Get a random element from the pool using Math's PRNG, throws if none available
   * @returns 
   */
  randomSync() {
    if (!this.#openElements.size)
      throw new Error(`Empty pool`)

    const elements = [...this.#openElements]
    const element = Arrays.random(elements)

    return element!
  }

  /**
   * Wait for any circuit to be created, then get a random one using WebCrypto's CSPRNG
   * @returns 
   */
  async cryptoRandom() {
    await Promise.any(this.#allPromises)

    return this.cryptoRandomSync()
  }

  /**
   * Get a random circuit from the pool using WebCrypto's CSPRNG, throws if none available
   * @returns 
   */
  cryptoRandomSync() {
    if (!this.#openElements.size)
      throw new Error(`Empty pool`)

    const elements = [...this.#openElements]
    const element = Arrays.cryptoRandom(elements)

    return element!
  }

}