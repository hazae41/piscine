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

## Usage

### WebSockets

Create a pool of WebSockets

```tsx
import "@hazae41/symbol-dispose-polyfill";

import "@hazae41/disposable-stack-polyfill";

import { Disposer } from "@hazae41/disposer"
import { Box } from "@hazae41/box"
import { Pool } from "@hazae41/piscine"
import { Future } from "@hazae41/future"

async function openOrThrow(socket: WebSocket) {
  using stack = new DisposableStack()

  const future = new Future<void>()

  const onOpen = () => future.resolve()
  const onError = () => future.reject(new Error("Errored"))

  socket.addEventListener("open", onOpen, { passive: true })
  stack.defer(() => socket.removeEventListener("open", onOpen))
  
  socket.addEventListener("error", onError, { passive: true })
  stack.defer(() => socket.removeEventListener("error", onError))

  return await future.promise
}

const pool = new Pool<Disposer<WebSocket>>(async ({ pool, index, signal }) => {
  using stack = new Box(new DisposableStack())

  const raw = new WebSocket(`/api`)
  await waitOrThrow(raw)

  const socket = new Disposer(raw, () => raw.close())

  const box = new Box(socket)
  stack.getOrThrow().use(box)

  const onClose = () => pool.restart(index)

  raw.addEventListener("close", onClose, { passive: true })
  stack.getOrThrow().defer(() => raw.removeEventListener("close", onClose))

  const unstack = stack.unwrapOrThrow()

  return new Disposer(box, () => unstack.dispose())
})
```

Start 5 of them

```tsx
for (let i = 0; i < 5; i++)
  pool.start(i)
```

You can get the second one

```tsx
const socket = await pool.getOrThrow(1)
```

You can get a random one using Math's PRNG

```tsx
const socket = await pool.getRandomOrThrow()

socket.get().send("Hello world")
```

You can get a random one using WebCrypto's CSPRNG

```tsx
const socket = await pool.getCryptoRandomOrThrow()

socket.get().send("Hello world")
```

You can iterate on them

```tsx
for (const socket of pool)
  socket.get().send("Hello world")
```

Or grab all of them

```tsx
const sockets = [...pool]
```

You can take a random one from the pool (and restart its index)

```tsx
import { Mutex } from "@hazae41/mutex"

const mutex = new Mutex(pool)

{
  using socket = await Pool.takeCryptoRandomOrThrow(mutex)

  socket.get().send("Hello world")

  // Close socket
}
```