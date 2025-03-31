import "@hazae41/symbol-dispose-polyfill"

import { Box } from "@hazae41/box"
import { Disposer } from "@hazae41/disposer"
import { Mutex } from "@hazae41/mutex"
import { test } from "@hazae41/phobos"
import { Pool } from "./index.js"

test("pool", async ({ test }) => {
  const pool = new Pool<Disposer<string>>(async (params) => {
    const { index } = params

    const uuid = crypto.randomUUID() as string

    console.log("creating", uuid)

    const onValueClean = () => {
      console.log("cleaning value", uuid)
    }

    const onEntryClean = () => {
      console.log("cleaning entry", uuid)
    }

    const entry = new Disposer(uuid, onValueClean)

    return new Disposer(new Box(entry), onEntryClean)
  })

  pool.start(0)
  pool.start(1)

  const mutex = new Mutex(pool)

  async function borrowAndLog() {
    using x = await mutex.runOrWait(() => pool.getCryptoRandomOrThrow().then(x => x.borrowOrThrow()))
    console.log("borrowing", x.getOrThrow().get())
    await new Promise(ok => setTimeout(ok, 1000))
    console.log("returning", x.getOrThrow().get())
  }

  const pa = borrowAndLog()
  const pb = borrowAndLog()

  await Promise.all([pa, pb])
})