/** The slice of a logger the services need. Fastify's `app.log` satisfies it. */
export interface Logger {
  warn(context: object, message: string): void;
}

export const noopLogger: Logger = { warn: () => undefined };
