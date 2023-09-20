import { AbortedError } from "@hazae41/plume"
import { Err, Result } from "@hazae41/result"

export class TooManyRetriesError extends Error {
  readonly #class = TooManyRetriesError
  readonly name = this.#class.name

  constructor(options?: ErrorOptions) {
    super(`Too many retries`, options)
  }

  static from(cause: unknown) {
    return new TooManyRetriesError({ cause })
  }

}

export type Looper<LoopOutput, LoopError extends Looped.Infer<LoopError>> =
  (index: number) => Promise<Result<LoopOutput, LoopError>>

export type Looped<T> =
  | Cancel<T>
  | Retry<T>
  | Skip<T>

export namespace Looped {

  export type Infer<T> =
    | Cancel.Infer<T>
    | Skip.Infer<T>
    | Retry.Infer<T>

  export type Inner<T> =
    | Cancel.Inner<T>
    | Skip.Inner<T>
    | Retry.Inner<T>

}

export namespace Cancel {

  export type Infer<T> = Cancel<Inner<T>>

  export type Inner<T> = T extends Cancel<infer Inner> ? Inner : never

}

export namespace Skip {

  export type Infer<T> = Skip<Inner<T>>

  export type Inner<T> = T extends Skip<infer Inner> ? Inner : never

}

export namespace Retry {

  export type Infer<T> = Retry<Inner<T>>

  export type Inner<T> = T extends Retry<infer Inner> ? Inner : never

}

export class Cancel<T> {

  constructor(
    readonly inner: T
  ) { }

  static new<T>(inner: T) {
    return new Cancel(inner)
  }

  isCancel(): this is Cancel<T> {
    return true
  }

  isRetry(): false {
    return false
  }

  isSkip(): false {
    return false
  }

}

export class Retry<T> {

  constructor(
    readonly inner: T
  ) { }

  static new<T>(inner: T) {
    return new Retry(inner)
  }

  isCancel(): false {
    return false
  }

  isRetry(): this is Retry<T> {
    return true
  }

  isSkip(): false {
    return false
  }

}

export class Skip<T>  {

  constructor(
    readonly inner: T
  ) { }

  static new<T>(inner: T) {
    return new Skip(inner)
  }

  isCancel(): false {
    return false
  }

  isRetry(): false {
    return false
  }

  isSkip(): this is Skip<T> {
    return true
  }

}

export interface LoopOptions {
  init?: number
  base?: number
  max?: number
  signal?: AbortSignal
}

export async function tryLoop<LoopOutput, LoopError extends Looped.Infer<LoopError>>(
  looper: Looper<LoopOutput, LoopError>,
  options: LoopOptions = {}
): Promise<Result<LoopOutput, Cancel.Inner<LoopError> | AbortedError | TooManyRetriesError>> {
  const { init = 1000, base = 2, max = 3, signal } = options

  const errors = new Array<LoopError>()

  for (let i = 0; !signal?.aborted && i < max; i++) {
    const result = await looper(i)

    if (result.isOk())
      return result

    const looped = result.get()

    if (looped.isSkip()) {
      errors.push(looped)
      continue
    }

    if (looped.isRetry()) {
      errors.push(looped)
      console.debug(`Loop failed ${i + 1} time(s)`, { error: looped.inner, looper: looper.toString() })
      await new Promise(ok => setTimeout(ok, init * (base ** i)))
      continue
    }

    return new Err(looped.inner)
  }

  if (signal?.aborted)
    return new Err(AbortedError.from(signal.reason))
  return new Err(TooManyRetriesError.from(errors))
}