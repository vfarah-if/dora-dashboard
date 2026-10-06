/** The slice of a logger the services need. Fastify's `app.log` satisfies it. */
export interface Logger {
  warn(context: object, message: string): void;
  /** For failures nobody planned for, whose detail must reach the log because it is not shown to the person. */
  error(context: object, message: string): void;
}

export const noopLogger: Logger = { warn: () => undefined, error: () => undefined };
