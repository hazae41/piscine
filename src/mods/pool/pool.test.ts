import "@hazae41/symbol-dispose-polyfill"

import { Box } from "@hazae41/box"
import { Disposer } from "@hazae41/disposer"
import { Mutex } from "@hazae41/mutex"
import { test } from "@hazae41/phobos"
import { Ok } from "@hazae41/result"
import { Pool } from "./pool.js"

test("pool", async ({ test }) => {

  const pool = new Pool<string>(async p => {
    const { index, pool } = p

    console.log("creating", index)
    await new Promise(ok => setTimeout(ok, 1000))

    const i = setTimeout(() => {
      console.log("lol", index)
      pool.restart(index)
    }, 1000)

    const onEntryClean = () => {
      console.log("cleaning", index)
      clearTimeout(i)
    }

    return new Ok(new Disposer(new Box(crypto.randomUUID() as string), onEntryClean))
  }, { capacity: 1 })

  const mutex = new Mutex(pool)

  while (true) {
    const x = await pool.getOrThrow(0)
    console.log(x)
    await new Promise(ok => setTimeout(ok, 1000))
  }

  await new Promise(ok => setTimeout(ok, 5 * 1000))
  console.log("stop")
})