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

Create a pool of 5 WebSockets

```tsx
import { Pool } from "@hazae41/piscine"

const pool = new Pool<Disposer<WebSocket>>(async ({ pool, index, signal }) => {
  const raw = new WebSocket(`/api`)

  /**
   * Define the socket
   */
  using presocket = new Box(new Disposer(raw, () => raw.close()))

  /**
   * Prepare the entry
   */
  const onCloseOrError = () => {
    pool.restart(index)
  }

  raw.addEventListener("error", onCloseOrError)
  raw.addEventListener("close", onCloseOrError)

  /**
   * Move socket in the entry
   */
  const socket = presocket.moveOrThrow()

  const onEntryClean = () => {
    /** 
     * Dispose the socket if the entry still owns it
     */
    using postsocket = socket

    /**
     * Clean the entry
     */
    raw.removeEventListener("error", onCloseOrError)
    raw.removeEventListener("close", onCloseOrError)
  }

  /**
   * Define the entry
   */
  using preentry = new Box(new Disposer(socket, onEntryClean))

  /**
   * Move the entry in the pool
   */
  return new Ok(preentry.unwrapOrThrow())
}, { capacity: 5 })
```

### Random

Get a random open socket using Math's PRNG

```tsx
const socket = await pool.random()

socket.send("Hello world")
```

Get a random open socket using WebCrypto's CSPRNG

```tsx
const socket = await pool.cryptoRandom()

socket.send("Hello world")
```

### Iteration

Pools are iterator, so you can loop through open sockets or create an array

```tsx
for (const socket of pool)
  socket.send("Hello world")
```

```tsx
const sockets = [...pool]
```
