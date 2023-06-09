import { AbortError } from "@hazae41/plume"
import { Err, Result } from "@hazae41/result"
import { PoolCreatorParams } from "./pool.js"

export type Creator<CreateOutput, CreateError, RetryError> =
  (params: PoolCreatorParams<any, any>) => Promise<Result<CreateOutput, CreateError | Retry<RetryError>>>

export class TooManyRetriesError extends Error {
  readonly #class = TooManyRetriesError
  readonly name = this.#class.name

  constructor() {
    super(`Too many retries`)
  }

}

export class Retry<T> {
  constructor(
    readonly inner: T
  ) { }

  static is<T>(value: unknown): value is Retry<T> {
    return value instanceof Retry
  }

}

export async function tryCreateLoop<CreateOutput, CreateError, RetryError>(tryCreate: Creator<CreateOutput, CreateError, RetryError>, params: PoolCreatorParams<any, any>): Promise<Result<CreateOutput, CreateError | AbortError | TooManyRetriesError>> {
  const { signal } = params

  for (let i = 0; !signal?.aborted && i < 3; i++) {
    const result = await tryCreate(params)

    if (result.isOk())
      return result

    if (Retry.is(result.inner)) {
      console.warn(`tryCreate failed ${i + 1} time(s)`, { error: result.get() })
      await new Promise(ok => setTimeout(ok, 1000 * (2 ** i)))
      continue
    }

    return result as Err<CreateError>
  }

  if (signal?.aborted)
    return new Err(AbortError.from(signal.reason))
  return new Err(new TooManyRetriesError())
}