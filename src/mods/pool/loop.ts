import { AbortError } from "@hazae41/plume"
import { Err, Result } from "@hazae41/result"
import { PoolCreatorParams } from "./pool.js"

export type Creator<CreateOutput, CreateError> =
  (params: PoolCreatorParams<any, any>) => Promise<Result<CreateOutput, CreateError>>

export class TooManyRetriesError extends Error {
  readonly #class = TooManyRetriesError
  readonly name = this.#class.name

  constructor() {
    super(`Too many retries`)
  }

}

export async function tryCreateLoop<CreateOutput, CreateError>(tryCreate: Creator<CreateOutput, CreateError>, params: PoolCreatorParams<any, any>): Promise<Result<CreateOutput, CreateError | AbortError | TooManyRetriesError>> {
  const { signal } = params

  for (let i = 0; !signal?.aborted && i < 3; i++) {
    const result = await tryCreate(params)

    if (result.isOk())
      return result

    console.warn(`tryCreate failed ${i + 1} time(s)`, { error: result.get() })
    await new Promise(ok => setTimeout(ok, 1000 * (2 ** i)))
    continue
  }

  if (signal?.aborted)
    return new Err(AbortError.from(signal.reason))
  return new Err(new TooManyRetriesError())
}