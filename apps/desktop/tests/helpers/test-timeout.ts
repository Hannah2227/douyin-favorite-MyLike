/** Shared CI runners need more scheduling time; media timing assertions stay unchanged. */
export const testTimeout = (milliseconds: number): number => milliseconds * (process.env.CI ? 2 : 1)
