/** The shape of `fetch` the adapters take, so a test can hand in a fake and no adapter reaches for the global. */
export type Fetch = typeof fetch;
