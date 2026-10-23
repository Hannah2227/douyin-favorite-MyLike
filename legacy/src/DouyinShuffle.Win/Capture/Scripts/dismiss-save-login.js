// 自动关闭抖音"是否保存登录信息"弹窗(优先点"取消/暂不保存"按钮,找不到就隐藏弹窗)。
// 该弹窗出现在登录后的抖音页上,常被用户误认为风控验证弹窗。
(function () {
  function dismiss() {
    try {
      var all = document.querySelectorAll('body *');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.children.length > 10) continue;
        var t = el.innerText || '';
        if (t.indexOf('保存登录信息') < 0 || t.length > 500) continue;
        var btns = el.querySelectorAll('button, [role="button"], span, div');
        for (var j = 0; j < btns.length; j++) {
          var bt = (btns[j].innerText || '').trim();
          if (bt === '取消' || bt === '暂不保存' || bt === '不保存' || bt === '以后再说') {
            try { btns[j].click(); } catch (e) {}
            return;
          }
        }
        el.style.display = 'none';
      }
    } catch (e) {}
  }
  setInterval(dismiss, 1200);
})();
