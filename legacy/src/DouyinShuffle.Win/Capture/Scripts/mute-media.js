// 静音并暂停页面上自动播放的视频/音频(登录窗/验证窗用,不需要声音)。
// 每秒重复执行,抖音 feed 会不断起新视频。
(function () {
  function muteAll() {
    try {
      document.querySelectorAll('video, audio').forEach(function (v) {
        try { v.muted = true; if (v.pause) v.pause(); } catch (e) {}
      });
    } catch (e) {}
  }
  muteAll();
  setInterval(muteAll, 1000);
})();
