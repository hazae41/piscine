import "@hazae41/symbol-dispose-polyfill"

import { Disposer, Stack } from "@hazae41/box"
import { test } from "@hazae41/phobos"
import { Catched, Err, Ok } from "@hazae41/result"
import { Pending, Pool, PoolCreator, PoolCreatorParams } from "./index.js"

// test("basic", async ({ test }) => {
//   async function create() {
//     const uuid = crypto.randomUUID() as string

//     console.log("creating", uuid)

//     await new Promise(ok => setTimeout(ok, 1000))

//     const onValueClean = () => {
//       console.log("cleaning value", uuid)
//     }

//     const onEntryClean = () => {
//       console.log("cleaning entry", uuid)
//     }

//     const value = Disposer.wrap(uuid, onValueClean)

//     console.log("created", uuid)

//     return Disposer.wrap(value, onEntryClean)
//   }

//   using pool = new Pool<Disposer<string>>()

//   const fake0 = await create()
//   const fake1 = await create()

//   pool.set(0, new Ok(fake0))
//   pool.set(1, new Ok(fake1))

//   // borrow(pool.getOrThrow(0))
//   // borrow(pool.getOrThrow(1))

//   async function borrow(box: Box<Disposer<string>>) {
//     using borrow = box.borrowOrThrow()
//     console.log("borrowed", borrow.getOrThrow().get())
//     await new Promise(ok => setTimeout(ok, 1000))
//   }

//   console.log("waiting for any entry")

//   const item = await pool.getRandomOrWaitOrThrow()
//   const view = item.getOrThrow()

//   console.log("got", view.get())

//   await new Promise(ok => setTimeout(ok, 5000))

//   console.log("ending")
// })

test("complex", async ({ test }) => {
  type T = Disposer<string>

  using pool = new Pool<T>()

  async function create(params: PoolCreatorParams) {
    const { index, signal } = params

    const uuid = crypto.randomUUID() as string

    console.log("creating", uuid)

    await new Promise(ok => setTimeout(ok, 1000))

    const onValueClean = () => {
      console.log("cleaning value", uuid)
    }

    const onEntryClean = () => {
      console.log("cleaning entry", uuid)
    }

    const value = Disposer.wrap(uuid, onValueClean)

    console.log("created", uuid)

    return Disposer.wrap(value, onEntryClean)
  }

  async function wait(index: number, promise: Promise<Disposer<T>>, signal: AbortSignal) {
    try {
      const disposer = await promise

      using stack = new Stack()

      stack.push(disposer)
      stack.push(disposer.get())

      signal.throwIfAborted()

      stack.array.length = 0

      return pool.set(index, new Ok(disposer))
    } catch (e: unknown) {
      signal.throwIfAborted()

      const value = Catched.wrap(e)

      return pool.set(index, new Err(value))
    }
  }

  async function launch(index: number, create: PoolCreator<T>) {
    pool.delete(index)

    console.log("launching", index)

    const aborter = new AbortController()
    const { signal } = aborter

    const promise = wait(index, create({ index, signal }), signal)
    const pending = new Pending(promise, aborter)

    pool.set(index, new Err(pending))

    return await promise
  }

  launch(0, create)

  const x = pool.getOrThrow(0)
  console.log("x", x)

  const y = pool.getAnyOrThrow(0)

  if (y.isOk()) {

  } else {
    const error = y.getErr()

    if (error instanceof Pending) {
      const item = await error.promise
    } else {
      throw error
    }
  }
})