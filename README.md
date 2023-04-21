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

const pool = new Pool<WebSocket>(({ pool, index, signal }) => {
  const socket = new WebSocket(`/api`)

  const onCloseOrError = () => {
    socket.removeEventListener("error", onCloseOrError)
    socket.removeEventListener("close", onCloseOrError)

    pool.delete(socket)
  }

  socket.addEventListener("error", onCloseOrError)
  socket.addEventListener("close", onCloseOrError)

  return socket
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
