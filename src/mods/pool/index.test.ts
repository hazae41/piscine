import "@hazae41/symbol-dispose-polyfill"

import { Disposer } from "@hazae41/box"
import { test } from "@hazae41/phobos"
import { AutoPool, PoolCreatorParams } from "./index.js"

test("basic", async ({ test, wait }) => {
  async function create(params: PoolCreatorParams) {
    const { index, signal } = params

    console.log(index, "creating")

    const socket = new WebSocket(`wss://echo.websocket.org/`)

    const onDestroy = () => {
      console.log(index, "destroying")

      socket.close()

      console.log(index, "destroyed")
    }

    const resource = Disposer.wrap(socket, onDestroy)

    await new Promise(ok => socket.addEventListener("open", ok))
    await new Promise(ok => socket.addEventListener("message", ok))

    console.log(index, "created")

    const onClose = () => {
      console.log(index, "closed")

      pool.delete(index)
    }

    socket.addEventListener("close", onClose)

    const onDelete = () => {
      console.log(index, "deleted")

      socket.removeEventListener("close", onClose)
    }

    return Disposer.wrap(resource, onDelete)
  }

  using pool = new AutoPool(create, 1)

  // async function borrow() {
  //   using borrow = await pool.waitRandomOrThrow(x => x?.getOrNull()?.borrowOrNull())

  //   const { index, value } = borrow.get()

  //   console.log(index, "borrowed")

  //   const socket = value.get()

  //   // socket.close()

  //   // await new Promise(ok => socket.addEventListener("close", ok))

  //   socket.send("hello")

  //   const event = await new Promise<MessageEvent>(ok => socket.addEventListener("message", ok))

  //   console.log(index, "got", event.data)

  //   console.log(index, "returning")
  // }

  // borrow()
  // borrow()

  async function subcreate(params: PoolCreatorParams) {
    const { index } = params

    const entry = pool.getAnyOrThrow(index)
    const borrow = entry.getOrThrow().borrowOrThrow()

    console.log(index, "borrowed")

    const socket = borrow.get().get().get()

    const onClose = () => {
      console.log(index, "subclosed")

      pool.delete(index)
    }

    socket.addEventListener("close", onClose)

    const onDelete = () => {
      console.log(index, "subdeleted")

      socket.removeEventListener("close", onClose)
    }

    return Disposer.wrap(borrow, onDelete)
  }

  using subpool = new AutoPool(subcreate, 1)

  async function subborrow() {
    using borrow = await subpool.waitRandomOrThrow(x => x?.getOrNull()?.borrowOrNull())

    const { index, value } = borrow.get()

    console.log(index, "subborrowed")

    const socket = value.get().get().get()

    socket.send("hello")

    const event = await new Promise<MessageEvent>(ok => socket.addEventListener("message", ok))

    console.log(index, "subgot", event.data)

    console.log(index, "subreturning")
  }

  pool.events.on("update", async (i) => {
    const entry = subpool.getAnyOrNull(i)

    if (entry == null)
      return
    if (entry.isOk())
      return

    subpool.delete(i)
  })

  subborrow()

  await new Promise(ok => setTimeout(ok, 10000))

  console.log("ending")
})