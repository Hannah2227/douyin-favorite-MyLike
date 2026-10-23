// Shared by likes and favorites. Page sizes remain platform hints, not guarantees.
export const collectionPolicy = {
  interval: 800,
  retry: 3000,
  pagesPerSegment: 24,
  segmentMs: 180_000,
  cooldown: 1500
}
