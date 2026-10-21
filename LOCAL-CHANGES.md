# 本机增强版：喜欢 / 收藏 / 我推荐过的作品

左侧三个入口分别显示三个本地列表。首次进入收藏或推荐，点击「采集」，完成后点「刷新」；搜索、分类、洗牌和顺序播放沿用原播放器。

“推荐”指本人点过推荐的作品，使用 `/aweme/v1/web/familiar/recommend/feed/`，不是首页个性化推荐。
“收藏”使用 `/aweme/v1/web/aweme/listcollection/` 的 POST 表单请求。

喜欢仍使用原账号目录；收藏和推荐分别在该目录的 `collections`、`recommendations` 子目录内保存列表、断点和续播进度。账号登录态沿用原来的 WebView2 profile。切换列表时等待旧列表保存完成，采集或验证期间禁止切换。

收藏、推荐页不提供取消点赞，宿主也拒绝这两个来源的取消点赞命令。本地删除和导入导出作用于当前列表。

升级前请自行备份现有程序和 `%LOCALAPPDATA%\DouyinShuffle\Data`。

验证：

```powershell
node tests/classify.test.js
node tests/list-sources.test.js
node tests/source-ui.test.js
dotnet run --project tests/StorageSmoke
dotnet publish src/DouyinShuffle.Win -c Release -o artifacts/publish
```

抖音接口可能变化；若出现限流或验证提示，请在应用内按提示操作，采集断点会保留。
