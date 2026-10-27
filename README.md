<div align="center">

<img src="apps/desktop/assets/icon.svg" width="120" alt="MyLike Logo" />

# MyLike

**把喜欢留下来，让回看更简单。**

一个整理、搜索和回看抖音喜欢与收藏的 Windows / macOS 桌面应用。

[![Release](https://img.shields.io/github/v/release/Hannah2227/douyin-favorite-MyLike?style=flat-square&color=ff5c8a)](https://github.com/Hannah2227/douyin-favorite-MyLike/releases/latest)
[![Windows x64](https://img.shields.io/badge/Windows-x64-5865f2?style=flat-square)](https://github.com/Hannah2227/douyin-favorite-MyLike/releases/latest)
[![Build](https://github.com/Hannah2227/douyin-favorite-MyLike/actions/workflows/desktop.yml/badge.svg?branch=main)](https://github.com/Hannah2227/douyin-favorite-MyLike/actions/workflows/desktop.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-6bb99b?style=flat-square)](LICENSE)

[![Stars](https://img.shields.io/github/stars/Hannah2227/douyin-favorite-MyLike?style=flat-square&logo=github&label=Stars&color=f5c451)](https://github.com/Hannah2227/douyin-favorite-MyLike/stargazers)
[![Forks](https://img.shields.io/github/forks/Hannah2227/douyin-favorite-MyLike?style=flat-square&label=Forks&color=8ba6fa)](https://github.com/Hannah2227/douyin-favorite-MyLike/forks)
[![Downloads](https://img.shields.io/github/downloads/Hannah2227/douyin-favorite-MyLike/total?style=flat-square&label=Downloads&color=ff5c8a)](https://github.com/Hannah2227/douyin-favorite-MyLike/releases)

[下载应用](https://github.com/Hannah2227/douyin-favorite-MyLike/releases/latest) · [功能特性](#功能特性) · [界面预览](#界面预览) · [反馈问题](https://github.com/Hannah2227/douyin-favorite-MyLike/issues)

</div>

## 界面预览

### 喜欢的内容

![喜欢的内容](assets/readme/likes.png)

### 仪表盘

![仪表盘](assets/readme/dashboard.png)

## 下载

**[下载最新版 · Windows x64](https://github.com/Hannah2227/douyin-favorite-MyLike/releases/latest)**

在发布页下载文件名以 `portable.exe` 结尾的应用，保存到固定文件夹后双击运行，免安装使用。

### macOS

Mac 版本提供 Apple Silicon（`arm64`，M 系列芯片）和 Intel（`x64`）两种安装包，最低系统要求为 macOS 13。发布页提供 Mac 附件后，下载对应芯片的 `MyLike-版本号-mac-arm64.dmg` 或 `MyLike-版本号-mac-x64.dmg`，打开后将 MyLike 拖入「应用程序」。

发布前可在仓库 Actions 的 **Electron desktop** 工作流下载 `MyLike-macOS-arm64` / `MyLike-macOS-x64` 构建产物。普通 CI 和本地默认生成的是临时签名测试包，未经 Apple 公证，系统可能阻止打开；正式分发应使用下方的签名发布流程。无需关闭系统安全保护。

Mac 保留原生标题栏和菜单，支持 ⌘C / ⌘V / ⌘A 等编辑操作。关闭主窗口（红色按钮或 ⌘W）会隐藏窗口，后台任务和播放会继续；点击 Dock 图标或按 ⌘1 恢复窗口。使用 ⌘Q 或 MyLike 菜单中的退出，保存进度并退出应用。

升级前请退出旧版，再使用新版 EXE；旧 WPF 版的数据与登录态不迁移，首次使用新版需重新登录和采集。

## 功能特性

- **喜欢与收藏**：增量采集、断点续采、收藏夹同步与按夹浏览；播放中收藏、多选加入收藏夹及新建收藏夹。
- **同步整理**：单条或批量取消抖音点赞、收藏，平台确认后同步更新本地记录。
- **随手找到**：标题 / 作者搜索，类型与年月筛选，触底自动加载，长列表流畅浏览。
- **沉浸回看**：顺序 / 洗牌、断点续播、视频 / 图集 / 实况原声混音、倍速、全屏、清屏、播放列表与自定义快捷键。
- **边采边看**：后台采集或取消点赞、收藏时继续播放，任务进度和异常集中管理。
- **本地管理**：多账号隔离、账号改名与删除、批量整理、喜欢元数据导入导出与关键操作自动备份。
- **按你的习惯**：深浅主题、界面缩放、窗口记忆、播放偏好与内容仪表盘。

## 快速上手

1. **添加账号并登录**：在应用打开的抖音窗口中完成扫码登录，身份核验成功后窗口自动收起。
2. **收录内容**：首次自动采集喜欢，日常用“更新”收录新点赞；历史可断点续采，结束后可在任务页复查末尾。收藏页可同步作品与收藏夹。
3. **开始回看**：直接点播，或在筛选范围内顺序 / 洗牌播放。清屏时按 Esc 或清屏快捷键退出，默认 H，可在设置修改。

遇到滑块验证时，应用会暂停任务并打开抖音窗口；验证通过且原接口恢复后窗口自动收起，再手动继续任务。限流时请稍后重试。更多操作见应用内的「使用教程」与「常见问题」。

本地数据在 Windows 上保存在 `%APPDATA%\MyLikeElectron`，在 macOS 上保存在 `~/Library/Application Support/MyLikeElectron`。本地删除与远端取消点赞、收藏是不同操作，远端取消前会要求确认；取消收藏会移除全部收藏夹关联，喜欢记录保留。

## 开发

使用 Electron + TypeScript + React + SQLite。需要 Node.js 24.12+、pnpm 11.22。

```sh
cd apps/desktop
pnpm install --frozen-lockfile
pnpm exec install-electron
pnpm dev
```

`pnpm test` 运行单元测试，`pnpm test:e2e` 运行桌面集成测试，`pnpm package:win` 生成 Windows 发行包。旧版源码、测试和构建流程统一保存在 [`legacy/`](legacy/)。

### 构建 Mac 版本

在 Mac 上使用上述 Node.js / pnpm 环境。修改品牌 SVG 后运行 `pnpm icons`，同时生成 Windows 图标和包含 Retina 分辨率的 Mac ICNS 图标。

```sh
# 当前 Mac 芯片架构，生成临时签名的 DMG 和 ZIP 测试包
pnpm package:mac

# 指定架构（可以交叉打包，运行测试需在对应架构验证）
pnpm package:mac --arm64
pnpm package:mac --x64

# 仅生成 .app，用于本机测试
pnpm package:mac:dir
```

输出位于 `apps/desktop/dist/`。Apple Silicon 的应用路径为 `dist/mac-arm64/MyLike.app`，Intel 为 `dist/mac/MyLike.app`。打包工具按目标架构获取 Electron，不复用本机其他架构的运行时。

集成测试使用临时数据目录与受控接口，不需要真实抖音账号。可用 `MYLIKE_EXECUTABLE` 指向打包后的可执行文件，例如：

```sh
MYLIKE_EXECUTABLE="$PWD/dist/mac-arm64/MyLike.app/Contents/MacOS/MyLike" pnpm test:e2e
```

真实扫码登录、人工验证、在线播放和实际账号同步仍需另外人工验收；CI 测试不能代替这些检查。

### Mac 签名与发布到同一个 Release

正式分发使用 Developer ID Application 证书与 Apple 公证。`pnpm package:mac:signed --arm64` / `--x64` 会要求有效签名证书并启用 hardened runtime 和公证。环境变量配置参见 [electron-builder 26 签名文档](https://www.electron.build/v26/docs/features/code-signing/)。

仓库维护者可在 Settings → Secrets and variables → Actions 中设置：

| Secret                        | 用途                                               |
| ----------------------------- | -------------------------------------------------- |
| `MAC_CSC_LINK`                | Base64 编码的 Developer ID Application `.p12` 证书 |
| `MAC_CSC_KEY_PASSWORD`        | `.p12` 证书密码（无密码时可留空）                  |
| `APPLE_ID`                    | 用于公证的 Apple ID                                |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple 专用 App 密码                                |
| `APPLE_TEAM_ID`               | Apple Developer 团队 ID                            |

证书和密码不要提交到代码仓库。Fork PR 不需要也不会使用这些发布凭据。

1. 合并 Mac 支持代码，将 `package.json` 版本更新到待发布版本，并创建指向该代码的标签及 Release（可先建草稿）。标签必须是版本号或 `v` 加版本号。旧标签若未包含 Mac 支持，需要使用新版本标签。
2. 在 Actions → **Electron desktop** → Run workflow 中填写已有 Release 的 `release_tag`，勾选 `sign_mac`。工作流会检出该标签，并校验版本号与标签一致。
3. Windows 与两种 Mac 架构的构建和测试全部通过后，工作流向该 Release 追加两种 Mac 的 DMG、ZIP 和各自的 SHA-256 校验文件。保留原有 Windows 附件，不覆盖同名文件。
4. 复查发布附件和说明，再发布草稿。已发布且允许修改附件的 Release 也可以追加；启用了 immutable releases 的已发布版本不能追加。

不填写 `release_tag` 时仅构建，不上传 Release；不勾选 `sign_mac` 时仅生成测试包，也不上传 Release。自动化上传需要仓库允许工作流取得 `contents: write` 权限；详情参见 [GitHub Release 管理说明](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)。

## 免责声明

- 本项目用于个人学习与账号内容整理，与抖音 / 字节跳动无关联，未经其授权或背书。
- 请仅访问和整理本人账号或已获授权的数据，遵守适用法律法规、平台服务条款及内容权利人的合法权益。请勿用于未经授权的采集、侵权传播或其他滥用行为。
- 视频、图片、音乐等内容的权利归原权利人所有；本地收录不代表获得转载、传播或其他使用授权。
- 平台接口、访问限制或内容状态变化可能导致功能不可用、采集不完整。请自行备份重要数据，并在批量取消点赞等操作前确认账号和范围。
- 软件按现状提供，不保证持续可用或适用于特定用途。在适用法律允许的范围内，作者不承担因使用本软件产生的账号限制、数据丢失等损失责任；具体以 [MIT License](LICENSE) 的担保与责任条款为准。

## 许可证

本项目采用 [MIT License](LICENSE)，第三方组件保留各自的版权和许可证，相关声明随发行包提供。
