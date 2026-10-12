const ROUNDS = 5;

/**
 * How many times the CPU time of `work(small)` that `work(large)` takes, from the least of five alternating runs of
 * each.
 *
 * A test that cares how work grows compares two sizes on the same machine rather than holding one run to a fixed
 * budget. CI runs every workspace's suite at once on a shared runner and under coverage, where a run took about ten
 * times as long as on a laptop, so a fixed budget passed locally and failed there. A ratio cancels out the machine's
 * speed. CPU time rather than time on the clock leaves out the time the process spends waiting for a core while other
 * suites run, and the least of five runs leaves out a pause that happens to land on one of them.
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
 * The most `growth` may return for an input four times the size when work grows in proportion to it. That work takes
 * about four times as long; twice that leaves room for noise, and work that grows with the square of the input, such
 * as a loop that reads again what it has already read, takes sixteen times as long and still fails.
 */
export const PROPORTIONAL = 8;

/** The CPU time, in microseconds, that the process spends on one run of `work`. */
function cpuTime<T>(work: (input: T) => unknown, input: T): number {
  const started = process.cpuUsage();
  work(input);
  const { user, system } = process.cpuUsage(started);
  return user + system;
}
