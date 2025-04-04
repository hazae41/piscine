import { Arrays } from "@hazae41/arrays";
import { Box, Deferred, Disposer, Stack } from "@hazae41/box";
import { Future } from "@hazae41/future";
import { Nullable } from "@hazae41/option";
import { Plume, SuperEventTarget } from "@hazae41/plume";
import { Catched, Err, Ok, Result } from "@hazae41/result";

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
    super(`Empty slot`)
  }

}

export interface Indexed<T> {
  readonly index: number
  readonly value: T
}

export class PoolItem<T extends Disposable> extends Box<T> {

  constructor(
    readonly pool: Pool<T>,
    readonly index: number,
    readonly value: T,
    readonly clean: Deferred,
  ) {
    super(value)
  }

  [Symbol.dispose]() {
    const owned = this.owned

    if (owned)
      this.clean[Symbol.dispose]()

    super[Symbol.dispose]()

    if (owned)
      this.pool.delete(this.index)

    return
  }

  moveOrNull() {
    const box = super.moveOrNull()

    if (box == null)
      return
    this.clean[Symbol.dispose]()
    this.pool.delete(this.index)

    return box
  }

  moveOrThrow(): Box<T> {
    const box = super.moveOrThrow()

    this.clean[Symbol.dispose]()
    this.pool.delete(this.index)

    return box
  }

  unwrapOrNull(): Nullable<T> {
    const value = super.unwrapOrNull()

    if (value == null)
      return
    this.clean[Symbol.dispose]()
    this.pool.delete(this.index)

    return value
  }

  unwrapOrThrow(): T {
    const value = super.unwrapOrThrow()

    this.clean[Symbol.dispose]()
    this.pool.delete(this.index)

    return value
  }

  returnOrThrow(): void {
    super.returnOrThrow()

    if (!this.owned)
      return

    this.pool.update(this.index)
  }

}

export type PoolEvents = {
  update: (index: number) => void
}

export class Pool<T extends Disposable> {

  readonly events = new SuperEventTarget<PoolEvents>()

  /**
   * Sparse entries by index
   */
  readonly #entries = new Array<Result<PoolItem<T>>>()

  /**
   * A pool of disposable items
   */
  constructor() { }

  [Symbol.iterator]() {
    return this.#entries.values()
  }

  [Symbol.dispose]() {
    for (const entry of this.#entries) {
      if (entry == null)
        continue
      if (entry.isErr())
        continue
      using _ = entry.get()
    }

    this.#entries.length = 0
  }

  /**
   * Delete the entry at the given index and return it
   * @param index 
   * @returns 
   */
  delete(index: number) {
    const previous = this.#entries.at(index)

    if (previous == null)
      return

    delete this.#entries[index]

    if (previous.isErr())
      return previous

    using _ = previous.get()

    return previous
  }

  /**
   * Set the entry at the given index and return it
   * @param index 
   * @param result 
   * @returns 
   */
  set(index: number, result: Result<Disposer<T>, Error>) {
    if (result.isOk()) {
      const disposer = result.get()

      const item = new PoolItem(this, index, disposer.value, disposer.clean)
      const entry = new Ok(item)

      this.delete(index)

      this.#entries[index] = entry

      this.events.emit("update", index).catch(console.error)

      return entry
    } else {
      const value = result.getErr()
      const entry = new Err(value)

      this.delete(index)

      this.#entries[index] = entry

      this.events.emit("update", index).catch(console.error)

      return entry
    }
  }

  update(index: number) {
    const entry = this.#entries.at(index)

    if (entry == null)
      return

    this.events.emit("update", index).catch(console.error)
  }

  /**
   * Get the entry at the given index or null if empty
   * @param index 
   * @returns 
   */
  getAnyOrNull(index: number): Nullable<Result<PoolItem<T>>> {
    return this.#entries.at(index)
  }

  /**
   * Get the entry at the given index or throw if empty
   * @param index 
   * @returns 
   */
  getAnyOrThrow(index: number): Result<PoolItem<T>> {
    const entry = this.#entries.at(index)

    if (entry == null)
      throw new EmptySlotError()

    return entry
  }

  /**
   * Get the item at the given index or null if empty or errored
   * @param index 
   * @returns 
   */
  getOrNull(index: number): Nullable<PoolItem<T>> {
    const entry = this.#entries.at(index)

    if (entry == null)
      return
    if (entry.isErr())
      return

    return entry.get()
  }

  /**
   * Get the item at the given index or throw if empty or errored
   * @param index 
   * @returns 
   */
  getOrThrow(index: number): PoolItem<T> {
    const entry = this.#entries.at(index)

    if (entry == null)
      throw new EmptySlotError()

    return entry.getOrThrow()
  }

  /**
   * Get a random item or null if none available
   * @returns 
   */
  getRandomOrNull<U>(filter: (x: Result<PoolItem<T>>) => Nullable<U>): Nullable<U> {
    return Arrays.random(this.#entries.map(filter).filter(x => x != null))
  }

  /**
   * Get a random item or throw if none available
   * @returns 
   */
  getRandomOrThrow<U>(filter: (x: Result<PoolItem<T>>) => Nullable<U>): U {
    const value = Arrays.random(this.#entries.map(filter).filter(x => x != null))

    if (value == null)
      throw new EmptyPoolError()

    return value
  }

  /**
   * Get a crypto-random item or null if none available
   * @returns 
   */
  getCryptoRandomOrNull<U>(filter: (x: Result<PoolItem<T>>) => Nullable<U>): Nullable<U> {
    return Arrays.cryptoRandom(this.#entries.map(filter).filter(x => x != null))
  }

  /**
   * Get a crypto-random item or throw if none available
   * @returns 
   */
  getCryptoRandomOrThrow<U>(filter: (x: Result<PoolItem<T>>) => Nullable<U>): U {
    const value = Arrays.cryptoRandom(this.#entries.map(filter).filter(x => x != null))

    if (value == null)
      throw new EmptyPoolError()

    return value
  }

  async waitOrThrow<U>(index: number, filter: (x: Nullable<Result<PoolItem<T>>>) => Nullable<U>, signal: AbortSignal = new AbortController().signal): Promise<U> {
    while (!signal.aborted) {
      const entry = this.#entries.at(index)
      const value = filter(entry)

      if (value != null)
        return value

      await Plume.waitOrThrow(this.events, "update", (f: Future<void>, i) => {
        if (i !== index)
          return
        f.resolve()
      }, signal)
    }

    throw signal.reason
  }

  async waitRandomOrThrow<U>(filter: (x: Nullable<Result<PoolItem<T>>>) => Nullable<U>, signal: AbortSignal = new AbortController().signal): Promise<U> {
    while (!signal.aborted) {
      const entry = Arrays.random(this.#entries)
      const value = filter(entry)

      if (value != null)
        return value

      await Plume.waitOrThrow(this.events, "update", (f: Future<void>) => {
        f.resolve()
      }, signal)
    }

    throw signal.reason
  }

  async waitCryptoRandomOrThrow<U>(filter: (x: Nullable<Result<PoolItem<T>>>) => Nullable<U>, signal: AbortSignal = new AbortController().signal): Promise<U> {
    while (!signal.aborted) {
      const entry = Arrays.cryptoRandom(this.#entries)
      const value = filter(entry)

      if (value != null)
        return value

      await Plume.waitOrThrow(this.events, "update", (f: Future<void>) => {
        f.resolve()
      }, signal)
    }

    throw signal.reason
  }

}

export interface PoolCreatorParams {
  readonly index: number
  readonly signal: AbortSignal
}

export type PoolCreator<T> = (
  params: PoolCreatorParams
) => Promise<Disposer<T>>

export class StartPool<T extends Disposable> extends Pool<T> {

  /**
   * Sparse aborters by index
   */
  readonly #aborters = new Array<AbortController>()

  /**
   * A pool of startable items
   */
  constructor() {
    super()
  }

  [Symbol.dispose]() {
    super[Symbol.dispose]()

    for (const aborter of this.#aborters)
      aborter?.abort()

    this.#aborters.length = 0
  }

  async #create(index: number, creator: PoolCreator<T>, signal: AbortSignal) {
    try {
      const disposer = await creator({ index, signal })

      using stack = new Stack()

      stack.push(disposer)
      stack.push(disposer.get())

      if (signal.aborted)
        return
      delete this.#aborters[index]

      stack.array.length = 0

      this.set(index, new Ok(disposer))
    } catch (e: unknown) {
      if (signal.aborted)
        return
      delete this.#aborters[index]

      const value = Catched.wrap(e)

      this.set(index, new Err(value))
    }
  }

  /**
   * Start the given index
   * @param index 
   * @returns 
   */
  start(index: number, creator: PoolCreator<T>) {
    this.abort(index)

    const aborter = new AbortController()
    this.#aborters[index] = aborter
    const { signal } = aborter

    this.#create(index, creator, signal)
  }

  /**
   * Abort the given index
   * @param index 
   * @returns 
   */
  abort(index: number) {
    const aborter = this.#aborters.at(index)

    if (aborter != null)
      aborter.abort()

    delete this.#aborters[index]
  }

}

export class AutoPool<T extends Disposable> extends StartPool<T> {

  constructor(
    readonly creator: PoolCreator<T>,
    readonly capacity: number
  ) {
    super()

    for (let i = 0; i < capacity; i++)
      this.start(i, creator)

    return this
  }

}