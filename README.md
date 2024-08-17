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
import { Pool } from "@hazae41/piscine"

const pool = new Pool<Disposer<WebSocket>>(async ({ pool, index, signal }) => {
  using stack = new Box(new DisposableStack())

  const raw = new WebSocket(`/api`)
  await WebSockets.waitOrThrow(raw)
  
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

Get a random open socket using Math's PRNG

```tsx
const socket = await pool.getRandomOrThrow()

socket.get().send("Hello world")
```

Get a random open socket using WebCrypto's CSPRNG

```tsx
const socket = await pool.getCryptoRandomOrThrow()

socket.get().send("Hello world")
```

### Iteration

Pools are iterator, so you can loop through open sockets or create an array

```tsx
for (const socket of pool)
  socket.get().send("Hello world")
```

```tsx
const sockets = [...pool]
```
