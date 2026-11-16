import { useState } from 'react'
import { Heart } from 'lucide-react'

export function CoverArtwork({ url }: { url: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  return (
    <div className="cover-artwork">
      {url && url !== failedUrl ? (
        <img src={url} alt="" draggable={false} loading="lazy" onError={() => setFailedUrl(url)} />
      ) : (
        <Heart size={36} />
      )}
    </div>
  )
}
