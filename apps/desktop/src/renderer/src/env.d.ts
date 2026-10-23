import type { DesktopAPI } from '../../shared/contracts'
declare global {
  interface Window {
    mylike: DesktopAPI
  }
}
