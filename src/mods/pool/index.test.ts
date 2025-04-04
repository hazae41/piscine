import "@hazae41/symbol-dispose-polyfill"

import { Disposer } from "@hazae41/box"
import { test } from "@hazae41/phobos"
import { Catched, Err } from "@hazae41/result"
import { AutoPool, PoolCreatorParams } from "./index.js"

test("basic", async ({ test, wait }) => {
  async function create(params: PoolCreatorParams) {
    const { index, signal } = params

    console.log(index, "creating")

    const socket = new WebSocket(`wss://echo.websocket.org/`)

    const onDestroy = () => {
      socket.close()

      console.log(index, "destroying")
    }

    const resource = Disposer.wrap(socket, onDestroy)

    await new Promise(ok => socket.addEventListener("open", ok))
    await new Promise(ok => socket.addEventListener("message", ok))

    console.log(index, "created")

    const onError = (error: unknown) => {
      pool.set(index, new Err(Catched.wrap(error)))
      pool.start(index, create)
    }

    socket.addEventListener("error", onError)
    socket.addEventListener("close", onError)

    const onDelete = () => {
      socket.removeEventListener("error", onError)
      socket.removeEventListener("close", onError)

      console.log(index, "deleting")
    }

    return Disposer.wrap(resource, onDelete)
  }

  using pool = new AutoPool(create, 2)

  async function borrow() {
    using borrow = await pool.waitRandomOrThrow(x => x?.getOrNull()?.borrowOrNull())

    const { index, value } = borrow.get()

    console.log(index, "borrowed")

    const socket = value.get()

    socket.send("hello world")

    const event = await new Promise<MessageEvent>(ok => socket.addEventListener("message", ok))

    console.log(index, "got", event.data)
  }

  borrow()
  borrow()
  borrow()

  await new Promise(ok => setTimeout(ok, 5000))

  console.log("ending")
})