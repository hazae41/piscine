import "@hazae41/symbol-dispose-polyfill"

import { Box, Disposer, Stack } from "@hazae41/box"
import { test } from "@hazae41/phobos"
import { Catched, Err, Ok } from "@hazae41/result"
import { Pool } from "./index.js"

test("basic", async ({ test }) => {
  async function create() {
    const uuid = crypto.randomUUID() as string

    console.log("creating", uuid)

    await new Promise(ok => setTimeout(ok, 1000))

    const onValueClean = () => {
      console.log("cleaning value", uuid)
    }

    const onEntryClean = () => {
      console.log("cleaning entry", uuid)
    }

    const value = Disposer.with(uuid, onValueClean)

    console.log("created", uuid)

    return Disposer.with(value, onEntryClean)
  }

  using pool = new Pool<Disposer<string>>()

  const fake0 = await create()
  const fake1 = await create()

  pool.set(0, new Ok(fake0))
  pool.set(1, new Ok(fake1))

  // borrow(pool.getOrThrow(0))
  // borrow(pool.getOrThrow(1))

  async function borrow(box: Box<Disposer<string>>) {
    using borrow = box.borrowOrThrow()
    console.log("borrowed", borrow.getOrThrow().get())
    await new Promise(ok => setTimeout(ok, 1000))
  }

  console.log("waiting for any entry")

  const item = await pool.getRandomOrWaitOrThrow()
  const view = item.getOrThrow()

  console.log("got", view.get())

  await new Promise(ok => setTimeout(ok, 5000))

  console.log("ending")
})

export type X<T extends Disposable> =
  | Pending<T>
  | Settled<T>
export class Pending<T extends Disposable> {
  constructor(
    readonly promise: PromiseLike<T>,
    readonly aborter: AbortController
  ) { }

  [Symbol.dispose]() {
    this.aborter.abort()
  }

  await() {
    return this.promise
  }

  isPending(): this is Pending<T> {
    return true
  }

  isSettled(): false {
    return false
  }

}

export class Settled<T extends Disposable> {

  constructor(
    readonly value: T
  ) { }

  [Symbol.dispose]() {
    this.value[Symbol.dispose]()
  }

  await() {
    return this.value
  }

  isPending(): false {
    return false
  }

  isSettled(): this is Settled<T> {
    return true
  }
}

test("complex", async ({ test }) => {
  type T = Disposer<string>

  using pool = new Pool<X<Disposer<string>>>()

  async function create(uuid: string, signal: AbortSignal) {
    console.log("creating", uuid)

    await new Promise(ok => setTimeout(ok, 1000))

    const onValueClean = () => {
      console.log("cleaning value", uuid)
    }

    const onEntryClean = () => {
      console.log("cleaning entry", uuid)
    }

    const value = Disposer.with(uuid, onValueClean)

    console.log("created", uuid)

    return Disposer.with(value, onEntryClean)
  }

  async function apply(index: number, pending: Pending<Disposer<T>>) {
    const { promise, aborter } = pending

    try {
      const disposer = await promise

      using stack = new Stack()

      stack.push(disposer)
      stack.push(disposer.get())

      if (aborter.signal.aborted)
        return

      stack.array.length = 0

      const wrapped = new Settled(disposer.value)
      const dmapped = new Disposer(wrapped, disposer.clean)

      pool.set(index, new Ok(dmapped))
    } catch (e: unknown) {
      if (aborter.signal.aborted)
        return

      const value = Catched.wrap(e)

      pool.set(index, new Err(value))
    }
  }

  async function launch(index: number, create: (signal: AbortSignal) => Promise<Disposer<T>>) {
    pool.delete(index)

    const uuid = crypto.randomUUID() as string

    console.log("launching", uuid)

    const aborter = new AbortController()
    const { signal } = aborter

    const promise = create(signal)
    const pending = new Pending(promise, aborter)

    apply(index, pending)

    const empty = Disposer.wrap(pending)

    pool.set(index, new Ok(empty))
  }

  const x = pool.getOrThrow(0).getOrThrow()
  const y = await x.await()
})