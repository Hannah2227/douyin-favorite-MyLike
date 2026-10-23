import type { Operation } from './page-request'

export type AccessTarget = { operation: Exclude<Operation, 'unlike'>; parameters: Record<string, string> }
export type AccessEvent =
  | { type: 'required'; accountId: string; kind: 'login' | 'verification'; target: AccessTarget }
  | { type: 'closed'; accountId: string }
export type PageState = { ready: boolean; captcha: boolean }

// Only visible challenge widgets count. Captcha scripts, hidden templates, user
// captions and fingerprint parameters such as verifyFp are not challenge evidence.
export function inspectPageState(): PageState {
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect()
    return (
      rect.width >= 30 &&
      rect.height >= 15 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth &&
      !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
      element.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true
      })
    )
  }
  const ready = !!document.body && ['interactive', 'complete'].includes(document.readyState)
  const challengeUrl = /(?:^|[/_-])(?:captcha|verify|verification)(?:$|[/_-])/i.test(location.pathname)
  const widgets = document.querySelectorAll(
    '[id*="captcha" i], [class*="captcha" i], ' +
      'iframe[src*="/captcha"], iframe[src*="/verify"], [data-testid*="captcha"]'
  )
  const dialogs = document.querySelectorAll('[role="dialog"], [id*="verify"], [class*="verify"]')
  return {
    ready,
    captcha:
      ready &&
      (challengeUrl ||
        [...widgets].some(visible) ||
        [...dialogs].some(
          (element) =>
            visible(element) &&
            /拖动滑块|完成安全验证|请完成验证|安全验证|验证码|captcha/i.test(element.textContent ?? '')
        ))
  }
}

export const pageStateScript = `(${inspectPageState.toString()})()`
