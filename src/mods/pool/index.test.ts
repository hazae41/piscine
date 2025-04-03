import "@hazae41/symbol-dispose-polyfill"

import { Box, Disposer } from "@hazae41/box"
import { test } from "@hazae41/phobos"
import { Catched, Err, Ok } from "@hazae41/result"
import { PoolCreatorParams, StartPool } from "./index.js"

test("basic", async ({ test }) => {
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

    const onError = (error: unknown) => {
      pool.set(index, new Err(Catched.wrap(error)))
      pool.start(index, create)
    }

    const value = Disposer.wrap(uuid, onValueClean)

    console.log("created", uuid)

    return Disposer.wrap(value, onEntryClean)
  }

  using pool = new StartPool<Disposer<string>>()

  const fake0 = await create({ index: 0, signal: new AbortController().signal })
  const fake1 = await create({ index: 1, signal: new AbortController().signal })

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