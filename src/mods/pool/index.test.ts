import "@hazae41/symbol-dispose-polyfill"

import { Disposer } from "@hazae41/disposer"
import { test } from "@hazae41/phobos"
import { Ok } from "@hazae41/result"
import { Pool } from "./index.js"

test("pool", async ({ test }) => {
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

    const value = new Disposer(uuid, onValueClean)

    console.log("created", uuid)

    return new Disposer(value, onEntryClean)
  }

  using pool = new Pool<Disposer<string>>(async (params) => {
    const { index } = params

    const entry = await create()

    return entry
  })

  const fake = await create()

  // pool.startOrThrow(0).catch(console.error)
  // await new Promise(ok => setTimeout(ok, 1000))
  pool.setOrThrow(0, new Ok(fake)).catch(console.error)

  using x = pool.moveOrThrow(0)
  console.log("x", x.getOrThrow().get())

  console.log("0", pool.getAnyOrNull(0))

  await new Promise(ok => setTimeout(ok, 5000))

  console.log("ending")

  // const mutex = new Mutex(pool)

  // async function borrowAndLog() {
  //   using x = await mutex.runOrWait(() => pool.getCryptoRandomOrThrow().then(x => x.borrowOrThrow()))
  //   console.log("borrowing", x.getOrThrow().get())
  //   await new Promise(ok => setTimeout(ok, 1000))
  //   console.log("returning", x.getOrThrow().get())
  // }

  // const pa = borrowAndLog()
  // const pb = borrowAndLog()

  // await Promise.all([pa, pb])
})