import { ShuffleFn } from "./models.js";

export const defaultShuffle: ShuffleFn = <T>(items: readonly T[]): T[] => {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

export const deterministicShuffle: ShuffleFn = <T>(items: readonly T[]): T[] => {
  return [...items];
};

export function createOrderedShuffle(orderByInstanceId: string[]): ShuffleFn {
  return <T>(items: readonly T[]): T[] => {
    const keyed = items as Array<T & { instance_id?: string }>;
    const map = new Map(orderByInstanceId.map((id, index) => [id, index]));
    return [...keyed].sort((a, b) => {
      const ai = a.instance_id ? map.get(a.instance_id) : undefined;
      const bi = b.instance_id ? map.get(b.instance_id) : undefined;
      const av = ai ?? Number.MAX_SAFE_INTEGER;
      const bv = bi ?? Number.MAX_SAFE_INTEGER;
      return av - bv;
    }) as T[];
  };
}
