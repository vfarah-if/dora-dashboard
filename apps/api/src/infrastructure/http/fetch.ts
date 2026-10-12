/**
 * The shape of `fetch` the adapters take. Each adapter calls only the one it was given, which defaults to the global
 * `fetch`, so a test can hand in a fake.
 */
export type Fetch = typeof fetch;
