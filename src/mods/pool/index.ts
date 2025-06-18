import { Arrays } from "@hazae41/arrays";
import { Clone, Stack } from "@hazae41/box";
import { Mutex } from "@hazae41/mutex";
import { Nullable } from "@hazae41/option";
import { Catched, Err, Ok, Result } from "@hazae41/result";
import { Promiseable } from "libs/promise/index.js";

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

export class Indexed<T extends Disposable> {

  constructor(
    readonly index: number,
    readonly value: T,
  ) { }

  [Symbol.dispose]() {
    this.value[Symbol.dispose]()
  }

  get() {
    return this.value
  }

}

export class Drop<T extends Disposable> {

  #dropped = false

  constructor(
    readonly value: T,
    readonly clean: Disposable
  ) { }

  [Symbol.dispose]() {
    this.clean[Symbol.dispose]() // delete from pool

    if (this.#dropped)
      return
    this.#dropped = true

    this.value[Symbol.dispose]()
  }

  get() {
    return this.value
  }

  dropOrNull() {
    if (this.#dropped)
      return
    this.#dropped = true

    this.clean[Symbol.dispose]()

    return this.value
  }

}

export class X<T extends Disposable> {

  #disposed = false

  constructor(
    readonly value: Clone<Mutex<T>>,
    readonly clean: Disposable
  ) { }

  static wrap<T extends Disposable>(value: T, clean: Disposable) {
    return new X(Clone.wrap(new Mutex(value)), clean)
  }

  [Symbol.dispose]() {
    if (this.#disposed)
      return
    this.#disposed = true

    using stack = new Stack()

    stack.push(this.value)
    stack.push(this.clean)
  }

  lockOrThrow() {
    if (this.#disposed)
      throw new Error()

    return Mutex.cloneAndLockOrThrow(this.value)
  }

  moveOrThrow() {
    if (this.#disposed)
      throw new Error()
    this.#disposed = true

    using _ = this.clean

    const value = this.value.get().getOrThrow()

    return value
  }

}

export class Pool<T extends Disposable> {

  /**
   * Sparse entries by index
   */
  readonly #entries = new Array<Indexed<T>>()

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
      using _ = entry
    }

    this.#entries.length = 0
  }

  #delete(index: number) {
    const previous = this.#entries.at(index)

    if (previous == null)
      return

    delete this.#entries[index]

    previous[Symbol.dispose]()

    return previous
  }

  /**
   * Set the entry at the given index and return it
   * @param index 
   * @param value 
   * @returns 
   */
  #set(index: number, value: T) {
    this.#delete(index)

    const indexed = new Indexed(index, value)

    this.#entries[index] = indexed

    return indexed
  }

  /**
   * Set the entry at the given index and return it
   * @param index 
   * @param reference 
   * @returns 
   */
  set(index: number, value: T) {
    this.#set(index, value)
  }

  /**
   * Delete the entry at the given index and return it
   * @param index 
   * @returns 
   */
  delete(index: number) {
    return this.#delete(index)
  }

  /**
   * Get the entry at the given index or null if empty
   * @param index 
   * @returns 
   */
  getOrNull(index: number): Nullable<Indexed<T>> {
    return this.#entries.at(index)
  }

  /**
   * Get the entry at the given index or throw if empty
   * @param index 
   * @returns 
   */
  getOrThrow(index: number): Indexed<T> {
    const entry = this.#entries.at(index)

    if (entry == null)
      throw new EmptySlotError()

    return entry
  }

  /**
   * Get a random item or null if none available
   * @returns 
   */
  getRandomOrNull<U>(filter: (x: Indexed<T>) => Nullable<U>): Nullable<U> {
    return Arrays.random(this.#entries.map(filter).filter(x => x != null))
  }

  /**
   * Get a random item or throw if none available
   * @returns 
   */
  getRandomOrThrow<U>(filter: (x: Indexed<T>) => Nullable<U>): U {
    const value = Arrays.random(this.#entries.map(filter).filter(x => x != null))

    if (value == null)
      throw new EmptyPoolError()

    return value
  }

  /**
   * Get a crypto-random item or null if none available
   * @returns 
   */
  getCryptoRandomOrNull<U>(filter: (x: Indexed<T>) => Nullable<U>): Nullable<U> {
    return Arrays.cryptoRandom(this.#entries.map(filter).filter(x => x != null))
  }

  /**
   * Get a crypto-random item or throw if none available
   * @returns 
   */
  getCryptoRandomOrThrow<U>(filter: (x: Indexed<T>) => Nullable<U>): U {
    const value = Arrays.cryptoRandom(this.#entries.map(filter).filter(x => x != null))

    if (value == null)
      throw new EmptyPoolError()

    return value
  }

  async getOrWait<U>(index: number, filter: (x: Nullable<Indexed<T>>) => Promiseable<Nullable<U>>): Promise<U> {
    while (true) {
      const entry = this.#entries.at(index)
      const value = await filter(entry)

      if (value != null)
        return value

      continue
    }
  }

  async getRandomOrWait<U>(filter: (x: Nullable<Indexed<T>>) => Nullable<U>, promise: Promise<void>): Promise<U> {
    while (true) {
      const entry = Arrays.random(this.#entries)
      const value = filter(entry)

      if (value != null)
        return value

      await promise
    }
  }

  async getCryptoRandomOrWait<U>(filter: (x: Nullable<Indexed<T>>) => Nullable<U>, promise: Promise<void>): Promise<U> {
    while (true) {
      const entry = Arrays.cryptoRandom(this.#entries)
      const value = filter(entry)

      if (value != null)
        return value

      await promise
    }
  }

}

export type PoolCreator<T> = (
  index: number,
  signal: AbortSignal,
) => Promise<T>

export class StartPool<T extends Disposable> extends Pool<Result<T>> {

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
      const value = await creator(index, signal)

      using stack = new Stack()

      stack.push(value)

      if (signal.aborted)
        return
      delete this.#aborters[index]

      stack.value.length = 0

      super.set(index, new Ok(value))
    } catch (e: unknown) {
      if (signal.aborted)
        return
      delete this.#aborters[index]

      const value = Catched.wrap(e)

      super.set(index, new Err(value))
    }
  }

  #start(index: number, creator: PoolCreator<T>) {
    this.#abort(index)

    const aborter = new AbortController()
    this.#aborters[index] = aborter
    const { signal } = aborter

    this.#create(index, creator, signal)
  }

  #abort(index: number) {
    const aborter = this.#aborters.at(index)

    if (aborter != null)
      aborter.abort()

    delete this.#aborters[index]
  }

  /**
   * Start the given index
   * @param index 
   * @returns 
   */
  start(index: number, creator: PoolCreator<T>) {
    this.#start(index, creator)
  }

  /**
   * Abort the given index
   * @param index 
   * @returns 
   */
  abort(index: number) {
    this.#abort(index)
  }

}

export class AutoPool<T extends Disposable> extends StartPool<T> {

  #state = "started"

  /**
   * An automatic pool or startable items
   * @param creator 
   * @param capacity 
   * @returns 
   */
  constructor(
    readonly creator: PoolCreator<T>,
    readonly capacity: number
  ) {
    super()

    for (let i = 0; i < capacity; i++)
      this.delete(i)

    return this
  }

  [Symbol.dispose]() {
    this.#state = "stopped"
    super[Symbol.dispose]()
  }

  set(index: number, value: Result<T>): never {
    throw new Error("Disallowed")
  }

  start(index: number, creator: PoolCreator<T>): never {
    throw new Error("Disallowed")
  }

  abort(index: number): never {
    throw new Error("Disallowed")
  }

  dispose(index: number) {
    if (index >= this.capacity)
      return

    super.set(index, new Err(new EmptySlotError()))

    if (this.#state === "stopped")
      return

    super.start(index, this.creator)
  }

}