/** Lets the event loop run other work, so parsing a large report does not starve the server. */
export const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** How many files a parser reads between yields. */
export const YIELD_EVERY = 200;
