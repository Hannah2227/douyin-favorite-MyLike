<div align="center">

<img src="apps/desktop/assets/icon.svg" width="120" alt="MyLike Logo" />

# MyLike

**把喜欢，再喜欢一遍。**

一个回看抖音喜欢与收藏的 Windows 桌面应用。

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

![喜欢的内容](assets/readme/likes-preview.png)

### 仪表盘

![仪表盘](assets/readme/dashboard-preview.png)

## 下载

**[下载最新版 · Windows x64](https://github.com/Hannah2227/douyin-favorite-MyLike/releases/latest)**

在发布页下载文件名以 `portable.exe` 结尾的应用，保存到固定文件夹后双击运行，免安装使用。

macOS（社区版本）：请前往[贡献者维护的仓库](https://github.com/billybobz-design/douyin-favorite-MyLike)下载，相关问题请在该仓库反馈。

v2.0.3 与 v2.0.2 的本地数据兼容。升级前请退出旧版，再使用新版 EXE；旧 WPF 版的数据与登录态不迁移，首次使用新版需重新登录和采集。

## 功能特性

- **喜欢与收藏**：增量采集、断点续采、单独同步收藏夹内容与按夹浏览；AI 分类前实时核实收藏夹列表；播放中收藏、多选加入收藏夹及新建收藏夹。
- **AI 整理**：可将喜欢作品添加到选中的收藏夹，或将已收藏作品分类到收藏夹；分类前核实远端收藏夹，只有明确勾选并填写逗号分隔的名称后才会创建私密 AI 收藏夹，同名收藏夹会复用；同一作品可归入多个收藏夹。
- **同步整理**：单条或批量取消抖音点赞、收藏，平台确认后同步更新本地记录。
- **随手找到**：标题 / 作者搜索，类型与年月筛选，触底自动加载，长列表流畅浏览。
- **沉浸回看**：顺序 / 洗牌、断点续播、视频 / 图集 / 实况原声混音、播放器内评论与回复、倍速、全屏、清屏、播放列表与自定义快捷键。
- **边采边看**：后台采集或取消点赞、收藏时继续播放，任务进度和异常集中管理，统一核验登录、喜欢与收藏状态。
- **本地管理**：多账号隔离、账号改名与删除、批量整理与关键操作自动备份。
- **按你的习惯**：深浅主题、界面缩放、窗口记忆、播放偏好与内容仪表盘。

## 快速上手

1. **添加账号并登录**：在应用打开的抖音窗口中完成扫码登录，身份核验成功后窗口自动收起。
2. **收录内容**：喜欢与收藏统一使用“更新顶部、向下采集、停止”：获取新内容、继续历史采集或保存进度停止；收藏页还可单独“同步收藏夹”及其中的作品，按夹浏览。收藏、取消收藏和收藏夹分类会按平台确认同步到云端；本地新建的收藏夹默认只保存在本机。开启“允许同步本地收藏夹到抖音”后，从收藏页点击“写回云端”，弹窗只列出本地与云端数量不一致或仍有待写回改动的本地收藏夹，可选择默认收藏列表和要写回的收藏夹（支持全选）。只处理所选范围，其他改动保留；写回已同步收藏夹时会核对作品，并补写本地存在、云端缺少的内容，核对本身不会删除云端作品，遇到不可见作品会跳过并在结果中统计。可用“同步收藏夹”重新拉取云端收藏夹内容。可在“管理本地收藏夹”中新建、改名或删除本地创建的收藏夹；改名仅影响本地，删除已写回的夹会在本机隐藏而不会删除云端收藏夹，夹内作品仍保留在默认收藏列表。AI 分类前会先核实抖音收藏夹列表。
3. **开始回看**：直接点播，或在筛选范围内顺序 / 洗牌播放。清屏时按 Esc 或清屏快捷键退出，默认 H，可在设置修改。

任务受阻时，到“连接与任务”点击“核验状态”，查看绿色正常、黄色不明确或红色异常及对应建议。需要登录或验证时会打开抖音窗口，完成后自动收起；核验不会自动恢复已停止的任务。更多操作见应用内的「使用教程」与「常见问题」。

本地数据保存在 `%APPDATA%\MyLikeElectron`。本地删除与远端取消点赞、收藏是不同操作，远端取消前会要求确认；取消收藏会移除全部收藏夹关联，喜欢记录保留。

## 开发

使用 Electron + TypeScript + React + SQLite。需要 Node.js 24.12+、pnpm 11.22。

```powershell
cd apps/desktop
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm test` 运行单元测试，`pnpm test:e2e` 运行桌面集成测试，`pnpm package:win` 生成 Windows 发行包。旧版源码、测试和构建流程统一保存在 [`legacy/`](legacy/)。

## 免责声明

- 本项目用于个人学习与账号内容整理，与抖音 / 字节跳动无关联，未经其授权或背书。
- 请仅访问和整理本人账号或已获授权的数据，遵守适用法律法规、平台服务条款及内容权利人的合法权益。请勿用于未经授权的采集、侵权传播或其他滥用行为。
- 视频、图片、音乐等内容的权利归原权利人所有；本地收录不代表获得转载、传播或其他使用授权。
- 平台接口、访问限制或内容状态变化可能导致功能不可用、采集不完整。请自行备份重要数据，并在批量取消点赞等操作前确认账号和范围。
- 软件按现状提供，不保证持续可用或适用于特定用途。在适用法律允许的范围内，作者不承担因使用本软件产生的账号限制、数据丢失等损失责任；具体以 [MIT License](LICENSE) 的担保与责任条款为准。

## 许可证

本项目采用 [MIT License](LICENSE)，第三方组件保留各自的版权和许可证，相关声明随发行包提供。
