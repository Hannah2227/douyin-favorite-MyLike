# 媒体测试样本

`flower.mp4` 来自 MDN 的 CC0 示例视频（H.264 / AAC），用于验证生产包的真实 Chromium 解码、图集音乐与播放器资源释放，不随应用发行。

- 来源：https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4
- SHA-256：`0cd83d944a6ca7822b4a8306cecc60a36e859b041f6702c6a1ad9ead78924451`

`portrait.webm` 为本项目生成的 1080×1920 VP8 竖屏测试视频，使用 Canvas 几何图样与 MediaRecorder 录制，约 2 秒、无音轨，无第三方内容，不随应用发行。边框用于检查裁切，圆形用于检查比例；用于验证真实媒体固有尺寸不会撑大播放布局。静态竖图的同款 SVG 在测试中生成。

抖音接口样本由测试在独立 Session 中生成，不连接真实账号。受控页面验证通过不代表真实抖音 SDK、登录与接口已经通过验收。
