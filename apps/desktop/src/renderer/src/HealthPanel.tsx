import { useEffect, useState } from 'react'
import { LogIn, ShieldCheck } from 'lucide-react'
import type { Snapshot } from '../../shared/contracts'
import { healthLabels, healthStatus } from '../../shared/health'
import { taskRecovery } from '../../shared/task-recovery'
import { accountLabel } from '../../shared/account-label'
export function HealthPanel({
  snapshot,
  accountId,
  login,
  probe
}: {
  snapshot: Snapshot | null
  accountId: string | null
  login: () => void
  probe: () => void
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(t)
  }, [])
  const account = snapshot?.accounts.find((a) => a.id === accountId),
    health = snapshot?.health
  const entries = health?.accountId === accountId ? health.entries : []
  const status = health?.checking ? 'uncertain' : healthStatus(entries, now)
  const bad = entries.filter((e) => e.status !== 'normal')
  const describe = (ops: string[]) => {
    const group = entries.filter((e) => ops.includes(e.operation))
    return group.some((e) => e.status === 'abnormal')
      ? '异常'
      : (ops[0] === 'likes' ? ['likes'] : ['favorites', 'folders']).some(
            (op) => !group.some((e) => e.operation === op)
          ) || group.some((e) => e.status !== 'normal' || now - e.at >= 600000)
        ? '不明确'
        : '正常'
  }
  const attention = snapshot?.authentication
  const reasons = attention
    ? [attention.kind === 'verification' ? '请在抖音窗口完成验证。' : '请在抖音窗口完成登录。']
    : bad.length
      ? [...new Set(bad.map((e) => taskRecovery(e.code)?.message ?? '暂时无法完成核验，请稍后再试。'))].slice(
          0,
          3
        )
      : [status === 'normal' ? '本次核验通过，可继续采集。' : '尚未取得完整结果，请点击核验状态。']
  const remaining = Math.max(
    0,
    Math.ceil((Math.max(0, ...(snapshot?.recovery ?? []).map((r) => r.retryAt)) - now) / 1000)
  )
  const uncertain = snapshot?.unlike?.unknown ?? 0
  return (
    <section className="connection-strip" aria-label="账号状态">
      <span className={'connection-avatar health-' + status}>
        <ShieldCheck size={21} />
      </span>
      <div className="connection-copy">
        <strong>
          {account ? accountLabel(account) : '尚未添加账号'}{' '}
          <span className={'health-label health-' + status} role="status">
            {healthLabels[status]}
          </span>
        </strong>
        {account && (
          <p>
            {health?.checking
              ? '正在核验登录、喜欢与收藏，请稍候…'
              : '喜欢：' +
                describe(['likes']) +
                ' · 收藏：' +
                describe(['favorites', 'folders', 'folderItems'])}
          </p>
        )}
        {(account ? reasons : ['在左侧添加账号后即可开始。']).map((reason, i) => (
          <p key={i}>{reason}</p>
        ))}
        {!!remaining && <p>部分操作暂不可用，请约 {remaining} 秒后再核验。</p>}
        {!!uncertain && (
          <p>
            有 {uncertain} 条取消操作结果待确认，请在下方任务记录中检查结果。核验正常不会重复发送取消操作。
          </p>
        )}
        {health?.checkedAt && <p>最近核验：{new Date(health.checkedAt).toLocaleString('zh-CN')}</p>}
      </div>
      <div className="connection-actions">
        <button disabled={!accountId || health?.checking} onClick={login}>
          <LogIn size={15} />
          打开抖音窗口
        </button>
        <button className="primary verify-login" disabled={!accountId || health?.checking} onClick={probe}>
          <ShieldCheck size={15} />
          {health?.checking ? '核验中…' : '核验状态'}
        </button>
      </div>
    </section>
  )
}
