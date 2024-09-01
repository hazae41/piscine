
export type Looper<T> =
  (index: number) => Promise<T>

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

/**
 * @deprecated
 */
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

export namespace Cancel {

  export type Infer<T> = Cancel<Inner<T>>

  export type Inner<T> = T extends Cancel<infer Inner> ? Inner : never

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

export namespace Retry {

  export type Infer<T> = Retry<Inner<T>>

  export type Inner<T> = T extends Retry<infer Inner> ? Inner : never

  export function runSync<T>(f: () => T) {
    try {
      return f()
    } catch (error) {
      throw new Retry(error)
    }
  }

  export async function run<T>(f: () => Promise<T>) {
    try {
      return await f()
    } catch (error) {
      throw new Retry(error)
    }
  }

}

export class Skip<T> {

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

export namespace Skip {

  export type Infer<T> = Skip<Inner<T>>

  export type Inner<T> = T extends Skip<infer Inner> ? Inner : never

  export function runSync<T>(f: () => T) {
    try {
      return f()
    } catch (error) {
      throw new Skip(error)
    }
  }

  export async function run<T>(f: () => Promise<T>) {
    try {
      return await f()
    } catch (error) {
      throw new Skip(error)
    }
  }

}

export interface LoopOptions {
  readonly init?: number
  readonly base?: number
  readonly max?: number
}

export async function loopOrThrow<T>(
  looper: Looper<T>,
  options: LoopOptions = {}
) {
  const { init = 1000, base = 2, max = 3 } = options

  const errors = new Array<unknown>()

  for (let i = 0; i < max; i++) {
    try {
      return await looper(i)
    } catch (error) {
      if (error instanceof Skip) {
        errors.push(error)
        continue
      }

      if (error instanceof Retry) {
        errors.push(error)
        await new Promise(ok => setTimeout(ok, init * (base ** i)))
        continue
      }

      throw error
    }
  }

  throw TooManyRetriesError.from(errors)
}