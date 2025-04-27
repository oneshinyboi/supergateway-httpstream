export interface Logger {
  info: (...args: any[]) => void
  error: (...args: any[]) => void
  warn?: (...args: any[]) => void
}
