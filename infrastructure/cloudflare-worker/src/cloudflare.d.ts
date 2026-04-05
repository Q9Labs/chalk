declare interface QueueMessage<T = unknown> {
  id: string
  body: T
  attempts: number
  retry(): void
  ack(): void
}

declare interface MessageBatch<T = unknown> {
  queue: string
  messages: Array<QueueMessage<T>>
}

declare interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

declare interface Queue<T = unknown> {
  send(message: T): Promise<void>
}

declare interface AiBinding {
  run(model: string, input: unknown): Promise<unknown>
}
