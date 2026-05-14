declare interface ScheduledController {
  cron: string
  scheduledTime: number
}

declare interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

declare interface R2Object {
  key: string
}

declare interface R2ObjectBody {
  text(): Promise<string>
}

declare interface R2ListOptions {
  prefix?: string
  limit?: number
  cursor?: string
}

declare interface R2Objects {
  objects: R2Object[]
  truncated: boolean
  cursor?: string
}

declare interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>
  put(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  list(options?: R2ListOptions): Promise<R2Objects>
}
