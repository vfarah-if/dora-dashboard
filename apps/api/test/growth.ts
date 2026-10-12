const ROUNDS = 5;

/**
 * How many times the CPU time of `work(small)` that `work(large)` takes, from the least of five alternating runs of
 * each. A copy of `packages/core/test/growth.ts`, which explains why a ratio of CPU times rather than a fixed budget;
 * the API's tests cannot import it from another workspace.
 */
export function growth<T>(work: (input: T) => unknown, small: T, large: T): number {
  let leastSmall = Infinity;
  let leastLarge = Infinity;
  for (let round = 0; round < ROUNDS; round++) {
    leastSmall = Math.min(leastSmall, cpuTime(work, small));
    leastLarge = Math.min(leastLarge, cpuTime(work, large));
  }
  return leastLarge / leastSmall;
}

/**
 * The most `growth` may return for an input four times the size when work grows in proportion to it: about four, with
 * room for noise, while work that grows with the square of the input takes about sixteen.
 */
export const PROPORTIONAL = 8;

/** The CPU time, in microseconds, that the process spends on one run of `work`. */
function cpuTime<T>(work: (input: T) => unknown, input: T): number {
  const started = process.cpuUsage();
  work(input);
  const { user, system } = process.cpuUsage(started);
  return user + system;
}
