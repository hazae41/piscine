import { AbortError } from "@hazae41/plume"
import { Err, Result } from "@hazae41/result"
import { PoolCreatorParams } from "./pool.js"

export type Creator<CreateOutput, CancelError, RetryError> =
  (params: PoolCreatorParams<any, any>) => Promise<Result<CreateOutput, Cancel<CancelError> | Retry<RetryError>>>

export class TooManyRetriesError extends Error {
  readonly #class = TooManyRetriesError
  readonly name = this.#class.name

  constructor() {
    super(`Too many retries`)
  }

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

}

export async function tryCreateLoop<CreateOutput, CancelError, RetryError>(tryCreate: Creator<CreateOutput, CancelError, RetryError>, params: PoolCreatorParams<any, any>): Promise<Result<CreateOutput, CancelError | AbortError | TooManyRetriesError>> {
  const { signal } = params

  for (let i = 0; !signal?.aborted && i < 3; i++) {
    const result = await tryCreate(params)

    if (result.isOk())
      return result

    const looped = result.get()

    if (looped.isRetry()) {
      console.warn(`tryCreate failed ${i + 1} time(s)`, { error: looped.inner })
      await new Promise(ok => setTimeout(ok, 1000 * (2 ** i)))
      continue
    }

    return new Err(looped.inner)
  }

  if (signal?.aborted)
    return new Err(AbortError.from(signal.reason))
  return new Err(new TooManyRetriesError())
}