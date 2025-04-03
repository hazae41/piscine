import "@hazae41/symbol-dispose-polyfill"

import { Disposer } from "@hazae41/box"
import { test } from "@hazae41/phobos"
import { Catched, Err } from "@hazae41/result"
import { AutoPool, PoolCreatorParams } from "./index.js"

test("basic", async ({ test }) => {
  async function create(params: PoolCreatorParams) {
    const { index, signal } = params

    console.log("creating", index)

    const socket = new WebSocket(`wss://echo.websocket.org/`)
    const resource = Disposer.wrap(socket, () => socket.close())

    await new Promise(ok => socket.addEventListener("open", ok))

    console.log("created", index)

    const onError = (error: unknown) => {
      pool.set(index, new Err(Catched.wrap(error)))
      pool.start(index, create)
    }

    socket.addEventListener("error", onError)
    socket.addEventListener("close", onError)

    const onEntryClean = () => {
      socket.removeEventListener("error", onError)
      socket.removeEventListener("close", onError)
    }

    return Disposer.wrap(resource, onEntryClean)
  }

  using pool = new AutoPool(create, 3)

  borrow(0)
  borrow(0)

  async function borrow(index: number) {
    console.log("waiting", index)

    const box = await pool.getOrWaitOrThrow(index)

    console.log("borrowing", index)

    using borrow = box.borrowOrThrow()
    const resource = borrow.getOrThrow()
    const socket = resource.get()

    console.log("borrowed", index)

    socket.send("hello world")

    const event = await new Promise<MessageEvent>(ok => socket.addEventListener("message", ok))

    console.log("got", event.data)

    console.log("returning", index)
  }

  await new Promise(ok => setTimeout(ok, 5000))

  console.log("ending")
})