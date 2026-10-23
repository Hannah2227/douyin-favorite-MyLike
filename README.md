<div align="center">

<img src="apps/desktop/assets/icon.svg" width="120" alt="MyLike Logo" />

# MyLike

**把喜欢留下来，让回看更简单。**

一个整理、搜索和回看抖音喜欢与收藏的 Windows 桌面应用。

[![Release](https://img.shields.io/github/v/release/Hannah2227/douyin-favorite-MyLike?style=flat-square&color=ff5c8a)](https://github.com/Hannah2227/douyin-favorite-MyLike/releases/latest)
[![Windows x64](https://img.shields.io/badge/Windows-x64-5865f2?style=flat-square)](https://github.com/Hannah2227/douyin-favorite-MyLike/releases/latest)
[![Build](https://github.com/Hannah2227/douyin-favorite-MyLike/actions/workflows/desktop.yml/badge.svg?branch=main)](https://github.com/Hannah2227/douyin-favorite-MyLike/actions/workflows/desktop.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-6bb99b?style=flat-square)](LICENSE)

[下载应用](https://github.com/Hannah2227/douyin-favorite-MyLike/releases/latest) · [功能特性](#功能特性) · [界面预览](#界面预览) · [反馈问题](https://github.com/Hannah2227/douyin-favorite-MyLike/issues)

</div>

## 下载

| Windows x64 | 使用方式 |
| --- | --- |
| [免安装 EXE](https://github.com/Hannah2227/douyin-favorite-MyLike/releases/download/v2.0.0/MyLike-2.0.0-win-x64-portable.exe) | 下载后双击运行 |
| [ZIP 解压版](https://github.com/Hannah2227/douyin-favorite-MyLike/releases/download/v2.0.0/MyLike-2.0.0-win-x64.zip) | 完整解压后运行 `MyLike.exe` |

无需安装 Node.js、.NET 或 WebView2。文件校验值见发布页的 [SHA256SUMS.txt](https://github.com/Hannah2227/douyin-favorite-MyLike/releases/download/v2.0.0/SHA256SUMS.txt)。

## 功能特性

- **喜欢与收藏**：增量采集、断点续采、收藏夹同步与按夹浏览。
- **随手找到**：标题 / 作者搜索，类型与年月筛选，触底自动加载，长列表流畅浏览。
- **沉浸回看**：顺序 / 洗牌、断点续播、视频 / 图集 / 实况、倍速、全屏、播放列表与自定义快捷键。
- **边采边看**：后台采集或取消点赞时继续播放，任务进度和异常集中管理。
- **本地管理**：多账号隔离、账号改名与删除、批量整理、喜欢元数据导入导出、备份与缓存清理。
- **按你的习惯**：深浅主题、界面缩放、窗口记忆、播放偏好与内容仪表盘。

## 界面预览

### 喜欢的内容

![喜欢的内容](assets/readme/likes.png)

### 仪表盘

![仪表盘](assets/readme/dashboard.png)

## 快速上手

1. **添加账号并登录**：在应用打开的抖音窗口中完成扫码登录。
2. **收录内容**：采集喜欢，或进入收藏页同步收藏与收藏夹。
3. **开始回看**：直接点播，或在筛选范围内顺序 / 洗牌播放。

遇到验证或限流时，按应用提示处理后继续。更多操作见应用内的「使用教程」与「常见问题」。

本地数据保存在 `%APPDATA%\MyLikeElectron`。旧 WPF 版升级到 2.0 需要重新登录和采集；本地删除与远端取消点赞是不同操作，取消点赞前会要求确认。

## 开发

使用 Electron + TypeScript + React + SQLite。需要 Node.js 24.12+、pnpm 11.22。

```powershell
cd apps/desktop
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm test` 运行单元测试，`pnpm test:e2e` 运行桌面集成测试，`pnpm package:win` 生成 Windows 发行包。旧版源码、测试和构建流程统一保存在 [`legacy/`](legacy/)。

## 许可证

本项目采用 [MIT License](LICENSE)，第三方组件保留各自的版权和许可证，相关声明随发行包提供。

本项目与抖音 / 字节跳动无关联。请使用自己的账号，并遵守平台的服务条款。
