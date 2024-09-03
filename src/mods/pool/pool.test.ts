import "@hazae41/symbol-dispose-polyfill"

import { Box } from "@hazae41/box"
import { Disposer } from "@hazae41/disposer"
import { test } from "@hazae41/phobos"
import { Pool } from "./pool.js"

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

  async function a() {
    console.log("a", await pool.takeCryptoRandomOrThrow().then(r => r.get()))
  }

  async function b() {
    console.log("b", await pool.takeCryptoRandomOrThrow().then(r => r.get()))
  }

  const pa = a()
  const pb = b()

  await Promise.all([pa, pb])
})