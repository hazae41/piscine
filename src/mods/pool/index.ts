import { Arrays } from "@hazae41/arrays";
import { Box, Deferred, Disposer, Stack } from "@hazae41/box";
import { Future } from "@hazae41/future";
import { Nullable } from "@hazae41/option";
import { Plume, SuperEventTarget } from "@hazae41/plume";
import { Catched, Err, Ok, Result } from "@hazae41/result";

export interface PoolCreatorParams {
  readonly index: number
  readonly signal: AbortSignal
}

export type PoolCreator<T> =
  (params: PoolCreatorParams) => Promise<Disposer<T>>

export type PoolEntry<T extends Disposable> =
  | PoolOkEntry<T>
  | PoolErrEntry<T>

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
    using _ = this.clean

    super[Symbol.dispose]()
  }

  moveOrNull() {
    const box = super.moveOrNull()

    if (box == null)
      return
    this.pool.delete(this.index)

    return box
  }

  moveOrThrow(): Box<T> {
    const box = super.moveOrThrow()

    this.pool.delete(this.index)

    return box
  }

  unwrapOrNull(): Nullable<T> {
    const value = super.unwrapOrNull()

    if (value == null)
      return
    this.pool.delete(this.index)

    return value
  }

  unwrapOrThrow(): T {
    const value = super.unwrapOrThrow()

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

export class PoolOkEntry<T extends Disposable> extends Ok<PoolItem<T>> {

  constructor(
    readonly pool: Pool<T>,
    readonly index: number,
    readonly value: PoolItem<T>
  ) {
    super(value)
  }

}

export class PoolErrEntry<T extends Disposable> extends Err<Error> {

  constructor(
    readonly pool: Pool<T>,
    readonly index: number,
    readonly value: Error
  ) {
    super(value)
  }

}

export type PoolEvents<T extends Disposable> = {
  ready: (entry: PoolOkEntry<T>) => void
  error: (entry: PoolErrEntry<T>) => void
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
    super(`Empty slot`)
  }

}

export class Pool<T extends Disposable> {

  readonly events = new SuperEventTarget<PoolEvents<T>>()

  /**
   * Sparse entries by index
   */
  readonly #entries = new Array<PoolEntry<T>>()

  /**
   * A pool of disposable items
   */
  constructor() { }

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

    delete this.#entries[index]

    if (previous == null)
      return
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
      const entry = new PoolOkEntry(this, index, item)

      this.delete(index)

      this.#entries[index] = entry

      this.events.emit("ready", entry).catch(console.error)

      return entry
    } else {
      const value = result.getErr()
      const entry = new PoolErrEntry(this, index, value)

      this.delete(index)

      this.#entries[index] = entry

      this.events.emit("error", entry).catch(console.error)

      return entry
    }
  }

  update(index: number) {
    const entry = this.#entries.at(index)

    if (entry == null)
      return
    if (entry.isErr())
      return

    this.events.emit("ready", entry).catch(console.error)
  }

  /**
   * Get the entry at the given index or null if empty
   * @param index 
   * @returns 
   */
  getAnyOrNull(index: number): Nullable<PoolEntry<T>> {
    return this.#entries.at(index)
  }

  /**
   * Get the entry at the given index or throw if empty
   * @param index 
   * @returns 
   */
  getAnyOrThrow(index: number): PoolEntry<T> {
    const entry = this.#entries.at(index)

    if (entry == null)
      throw new EmptySlotError()

    return entry
  }

  /**
   * Get the item at the given index or null if not available
   * @param index 
   * @returns 
   */
  getOrNull(index: number): Nullable<PoolItem<T>> {
    const entry = this.#entries.at(index)

    if (entry == null)
      return
    if (entry.isErr())
      return

    return entry.get().checkOrNull()
  }

  /**
   * Get the item at the given index or throw if not available
   * @param index 
   * @returns 
   */
  getOrThrow(index: number): PoolItem<T> {
    const entry = this.#entries.at(index)

    if (entry == null)
      throw new EmptySlotError()
    if (entry.isErr())
      throw entry.getErr()

    return entry.get().checkOrThrow()
  }

  /**
   * Get a random item or throw if none available
   * @returns 
   */
  getRandomOrThrow(): PoolItem<T> {
    const entry = Arrays.random([...this.#entries.filter(x => x != null && x.isOk() && x.get().owned) as PoolOkEntry<T>[]])

    if (entry == null)
      throw new EmptyPoolError()

    return entry.get()
  }

  /**
   * Get a crypto-random item or throw if none available
   * @returns 
   */
  getCryptoRandomOrThrow(): PoolItem<T> {
    const entry = Arrays.cryptoRandom([...this.#entries.filter(x => x != null && x.isOk() && x.get().owned) as PoolOkEntry<T>[]])

    if (entry == null)
      throw new EmptyPoolError()

    return entry.get()
  }

  /**
   * Get the item at the given index or wait for it to be available
   * @param index 
   * @param signal 
   * @returns 
   */
  async getOrWaitOrThrow(index: number, signal = new AbortController().signal): Promise<PoolItem<T>> {
    while (true) {
      const entry = this.#entries.at(index)

      if (entry != null && entry.isOk() && entry.value.owned)
        return entry.get()

      await Plume.waitOrThrow(this.events, "ready", (f: Future<void>, x) => {
        if (x.index !== index)
          return
        f.resolve()
      }, signal)
    }
  }

  /**
   * Get a random item or wait for one to be available
   * @param signal 
   * @returns 
   */
  async getRandomOrWaitOrThrow(signal = new AbortController().signal): Promise<PoolItem<T>> {
    while (true) {
      const entry = Arrays.random([...this.#entries.filter(x => x != null && x.isOk() && x.get().owned) as PoolOkEntry<T>[]])

      if (entry != null)
        return entry.get()

      await Plume.waitOrThrow(this.events, "ready", (f: Future<void>) => {
        f.resolve()
      }, signal)
    }
  }

  /**
   * Get a crypto-random item or wait for one to be available
   * @param signal 
   * @returns 
   */
  async getCryptoRandomOrWaitOrThrow(signal = new AbortController().signal): Promise<PoolItem<T>> {
    while (true) {
      const entry = Arrays.cryptoRandom([...this.#entries.filter(x => x != null && x.isOk() && x.get().owned) as PoolOkEntry<T>[]])

      if (entry != null)
        return entry.get()

      await Plume.waitOrThrow(this.events, "ready", (f: Future<void>) => {
        f.resolve()
      }, signal)
    }
  }

}

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

// export class AutoPool<T extends Disposable> extends StartPool<T> {

//   constructor(
//     readonly creator: PoolCreator<T>,
//     readonly capacity: number
//   ) {
//     super()

//     for (let i = 0; i < capacity; i++)
//       this.start(i, creator)

//     return this
//   }

// }