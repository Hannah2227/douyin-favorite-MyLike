import type { WindowState } from '../shared/preferences'
type Area = { x: number; y: number; width: number; height: number }

/** Keep a remembered window visible after monitor removal, DPI changes or corrupt settings. */
export function restoreWindowState(raw: WindowState | null, areas: Area[]): WindowState | null {
  if (!raw || !areas.length || ![raw.x, raw.y, raw.width, raw.height].every(Number.isFinite)) return null
  const area =
    areas.find(
      (a) =>
        raw.x + 80 < a.x + a.width &&
        raw.x + raw.width - 80 > a.x &&
        raw.y + 40 < a.y + a.height &&
        raw.y + 40 >= a.y
    ) ?? areas[0]!
  const width = Math.min(Math.max(raw.width, 920), area.width)
  const height = Math.min(Math.max(raw.height, 640), area.height)
  return {
    x: Math.round(Math.min(Math.max(raw.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(raw.y, area.y), area.y + area.height - height)),
    width: Math.round(width),
    height: Math.round(height),
    maximized: raw.maximized === true
  }
}
