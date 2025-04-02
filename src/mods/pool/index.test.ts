import "@hazae41/symbol-dispose-polyfill"

import { Box } from "@hazae41/box"
import { Disposer } from "@hazae41/disposer"
import { test } from "@hazae41/phobos"
import { Ok } from "@hazae41/result"
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

    const value = new Disposer(uuid, onValueClean)

    console.log("created", uuid)

    return new Disposer(value, onEntryClean)
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

test("complex", async ({ test }) => {

})