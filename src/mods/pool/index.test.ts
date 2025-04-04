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
      console.log(index, "destroyed")

      socket.close()
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

  using pool = new AutoPool(create, 3)

  async function borrow() {
    using borrow = await pool.waitRandomOrThrow(x => x?.getOrNull()?.borrowOrNull())

    const { index, value } = borrow.get()

    console.log(index, "borrowed")

    const socket = value.get()

    socket.close()

    await new Promise(ok => socket.addEventListener("close", ok))

    // const event = await new Promise<MessageEvent>(ok => socket.addEventListener("message", ok))

    // console.log(index, "got", event.data)

    console.log(index, "returning")
  }

  borrow()
  borrow()

  for (const entry of pool)
    console.log(entry)

  await new Promise(ok => setTimeout(ok, 10000))

  console.log("ending")
})