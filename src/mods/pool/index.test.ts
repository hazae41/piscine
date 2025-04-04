import "@hazae41/symbol-dispose-polyfill"

import { Disposer } from "@hazae41/box"
import { test } from "@hazae41/phobos"
import { Catched, Err } from "@hazae41/result"
import { AutoPool, PoolCreatorParams } from "./index.js"

test("basic", async ({ test, wait }) => {
  async function create(params: PoolCreatorParams) {
    const { index, signal } = params

    console.log("creating", index)

    const socket = new WebSocket(`wss://echo.websocket.org/`)

    const onDestroy = () => {
      socket.close()

      console.log("destroying", index)
    }

    const resource = Disposer.wrap(socket, onDestroy)

    await new Promise(ok => socket.addEventListener("open", ok))
    await new Promise(ok => socket.addEventListener("message", ok))

    console.log("created", index)

    const onError = (error: unknown) => {
      pool.set(index, new Err(Catched.wrap(error)))
      pool.start(index, create)
    }

    socket.addEventListener("error", onError)
    socket.addEventListener("close", onError)

    const onDelete = () => {
      socket.removeEventListener("error", onError)
      socket.removeEventListener("close", onError)

      console.log("deleting", index)
    }

    return Disposer.wrap(resource, onDelete)
  }

  using pool = new AutoPool(create, 3)

  // borrow(0)
  // borrow(0)

  // async function borrow(index: number) {
  //   console.log("waiting", index)

  //   using borrow = await pool.waitOrThrow(index, x => x?.getOrNull()?.borrowOrNull())

  //   console.log("borrowing", index)

  //   const resource = borrow.get()
  //   const socket = resource.get()

  //   socket.send("hello world")

  //   const event = await new Promise<MessageEvent>(ok => socket.addEventListener("message", ok))

  //   console.log("got", event.data)

  //   console.log("returning", index)
  // }

  await new Promise(ok => setTimeout(ok, 5000))

  console.log("ending")
})