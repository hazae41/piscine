import "@hazae41/symbol-dispose-polyfill"

import { Box, Deferred, Disposer, Stack } from "@hazae41/box"
import { Future } from "@hazae41/future"
import { test } from "@hazae41/phobos"
import { AutoPool } from "./index.js"

await test("example", async ({ test, wait }) => {
  async function openOrThrow(socket: WebSocket, signal: AbortSignal) {
    using stack = new Stack()

    const future = new Future<void>()

    const onOpen = () => future.resolve()
    const onError = () => future.reject(new Error("Errored"))
    const onAbort = () => future.reject(new Error("Aborted"))

    socket.addEventListener("open", onOpen, { passive: true })
    stack.push(new Deferred(() => socket.removeEventListener("open", onOpen)))

    socket.addEventListener("error", onError, { passive: true })
    stack.push(new Deferred(() => socket.removeEventListener("error", onError)))

    signal.addEventListener("abort", onAbort, { passive: true })
    stack.push(new Deferred(() => signal.removeEventListener("abort", onAbort)))

    return await future.promise
  }

  async function createOrThrow(index: number, signal: AbortSignal) {
    const socket = new WebSocket("wss://echo.websocket.org/")
    await openOrThrow(socket, signal)

    const resource = Disposer.wrap(socket, () => socket.close())

    using entry = new Box(resource)
    using stack = new Box(new Stack())

    const onClose = () => pool.delete(index)

    socket.addEventListener("close", onClose, { passive: true })
    stack.get().push(new Deferred(() => socket.removeEventListener("close", onClose)))

    const unentry = entry.unwrapOrThrow()
    const unstack = stack.unwrapOrThrow()

    return Disposer.wrap(unentry, () => unstack[Symbol.dispose]())
  }

  // Launch a pool of 10 sockets
  using pool = new AutoPool<Disposer<WebSocket>>(createOrThrow, 10)

  {
    // Borrow socket 0 when it's available
    using borrow = await pool.waitOrThrow(0, x => x?.getOrNull()?.borrowOrNull())
    const socket = borrow.get().get().get()

    socket.send("hello")

    await new Promise(ok => socket.addEventListener("message", ok))

    // Return socket 0 into the pool
  }

  {
    // Take a random available socket and automatically start creating a new one
    using taken = await pool.waitRandomOrThrow(x => x?.getOrNull()?.unwrapOrNull())
    const socket = taken.get().get()

    socket.send("hello")

    await new Promise(ok => socket.addEventListener("message", ok))

    // Close the socket
  }

  // Use all stale sockets to send a message
  for (const entry of pool) {
    if (entry.isErr())
      continue
    const item = entry.get()

    if (item.borrowed)
      continue
    const socket = item.get().get().get()

    socket.send("hello")
  }

  // Get all entries
  const entries = [...pool]
})

await test("basic", async ({ test, wait }) => {
  async function create(index: number, signal: AbortSignal) {
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

  async function subcreate(index: number, signal: AbortSignal) {
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

