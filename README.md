![piscine](https://user-images.githubusercontent.com/4405263/225078829-f9cbc271-1740-44b8-929c-802d0929fa5c.png)

Create async pools with automatic retry

```bash
npm i @hazae41/piscine
```

[**Node Package 📦**](https://www.npmjs.com/package/@hazae41/piscine)

## Features

### Current features
- 100% TypeScript and ESM
- No external dependency
- Simple API
- Automatic retry
- Get a fast random value using Math's PRNG
- Get a secure random value using WebCrypto's CSPRNG
- Rust-like resource borrowing and moving

### Usage

Create an automatic pool of 10 WebSockets

```tsx
import "@hazae41/symbol-dispose-polyfill"

import { Box, Deferred, Disposer, Stack } from "@hazae41/box"
import { Future } from "@hazae41/future"
import { test } from "@hazae41/phobos"
import { AutoPool } from "@hazae41/piscine"

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

// Destroy the pool
```