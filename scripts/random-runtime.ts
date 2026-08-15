const NON_ZERO_SEED = 0x9e37_79b9;

export interface DeterministicRandom {
  integer(minimum: number, maximum: number): number;
  next(): number;
  pick<T>(values: readonly T[]): T;
  sampleUnique<T>(values: readonly T[], count: number, key: (value: T) => string): T[];
}

const unsignedSeed = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("Random seed must be an unsigned 32-bit integer.");
  }
  return value >>> 0;
};

export const deriveDeterministicSeed = (rootSeed: number, label: string): number => {
  let state = unsignedSeed(rootSeed) || NON_ZERO_SEED;
  for (let index = 0; index < label.length; index += 1) {
    state ^= label.charCodeAt(index);
    state = Math.imul(state, 0x01_00_01_93) >>> 0;
  }
  return state || NON_ZERO_SEED;
};

export const createDeterministicRandom = (seed: number): DeterministicRandom => {
  let state = unsignedSeed(seed) || NON_ZERO_SEED;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const integer = (minimum: number, maximum: number): number => {
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || maximum < minimum) {
      throw new Error("Random integer bounds must be ordered safe integers.");
    }
    return minimum + Math.floor(next() * (maximum - minimum + 1));
  };
  const pick = <T>(values: readonly T[]): T => {
    if (values.length === 0) throw new Error("Cannot select from an empty collection.");
    return values[Math.floor(next() * values.length)]!;
  };
  const sampleUnique = <T>(values: readonly T[], count: number, key: (value: T) => string): T[] => {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("Random sample count must be a non-negative safe integer.");
    }
    const unique = [...new Map(values.map((value) => [key(value), value])).values()];
    for (let index = unique.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(next() * (index + 1));
      [unique[index], unique[swapIndex]] = [unique[swapIndex]!, unique[index]!];
    }
    return unique.slice(0, count);
  };
  return { integer, next, pick, sampleUnique };
};

export const runBoundedTasks = async <T>(
  tasks: readonly (() => Promise<T>)[],
  concurrency: number,
): Promise<PromiseSettledResult<T>[]> => {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("Task concurrency must be a positive integer.");
  }
  const results = Array.from<PromiseSettledResult<T> | undefined>({ length: tasks.length });
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "fulfilled", value: await tasks[index]!() };
      } catch (reason: unknown) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results.map((result) => {
    if (!result) throw new Error("A bounded task did not produce a result.");
    return result;
  });
};
