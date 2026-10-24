import type { Dispatch, SetStateAction } from 'react'

import { Heart, Plus, X } from 'lucide-react'

import { call, type Perform } from './api'

type Props = {
  busy: boolean
  name: string
  setName: Dispatch<SetStateAction<string>>
  setAdding: Dispatch<SetStateAction<boolean>>
  setNotice: Dispatch<SetStateAction<string>>
  perform: Perform
}
export function AccountDialog({ busy, name, setName, setAdding, setNotice, perform }: Props) {
  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="添加抖音账号"
        onSubmit={(e) => {
          e.preventDefault()
          void perform('添加账号', async () => {
            await call(window.mylike.invoke('createAccount', { name }))
            setAdding(false)
            setName('')
            setNotice('账号已创建。登录后可自动采集，采集途中也可以观看视频。')
          })
        }}
      >
        <button type="button" className="modal-close" aria-label="关闭" onClick={() => setAdding(false)}>
          <X size={18} />
        </button>
        <div className="modal-icon">
          <Heart size={25} />
        </div>
        <h2>添加抖音账号</h2>
        <p>先给账号取一个本地名称，登录后会显示抖音昵称。</p>
        <label>
          账号名称
          <input
            aria-label="账号名称"
            autoFocus
            maxLength={40}
            required
            value={name}
            placeholder="例如：我的抖音"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button className="primary" disabled={busy || !name.trim()} type="submit">
          <Plus size={16} />
          创建账号
        </button>
      </form>
    </div>
  )
}
