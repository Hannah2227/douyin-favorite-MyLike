import logo from '../../../assets/icon.svg'

export function BrandMark({ size = 42 }: { size?: number }) {
  return <img className="brand-image" src={logo} width={size} height={size} alt="" draggable={false} />
}

/** GitHub's monochrome mark, kept as a small local vector with the rest of the icon system. */
export function GitHubMark({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.73 1.16 1.73 1.16 1 1.72 2.62 1.22 3.26.93.1-.73.39-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.54 0-1.22.44-2.22 1.16-3-.12-.28-.5-1.42.11-2.96 0 0 .95-.3 3.08 1.15a10.73 10.73 0 0 1 5.6 0c2.14-1.45 3.08-1.15 3.08-1.15.61 1.54.23 2.68.11 2.96.73.78 1.16 1.78 1.16 3 0 4.3-2.63 5.25-5.14 5.53.41.35.77 1.03.77 2.08v3.11c0 .3.2.65.78.54A11.2 11.2 0 0 0 12 .8Z" />
    </svg>
  )
}
