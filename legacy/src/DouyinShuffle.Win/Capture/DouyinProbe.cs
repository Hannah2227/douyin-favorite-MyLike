using Microsoft.Web.WebView2.Core;
using Newtonsoft.Json.Linq;

namespace DouyinShuffle.Win.Capture;

/// <summary>接口健康状态:全流程(登录/验证/采集/风控复核)统一使用的唯一权威信号。</summary>
public enum ApiHealth
{
    /// <summary>接口返回合法 JSON 且带 sec_uid → 登录完成 + 签名就绪,一切正常。</summary>
    Ok,
    /// <summary>接口返回 HTML 验证页 → 真风控,需要人工完成滑块。只有此状态才弹人工验证窗。</summary>
    Blocked,
    /// <summary>空响应/网络异常/SDK 未就绪/未登录 → 等待重试即可,绝不弹验证窗打扰用户。</summary>
    NotReady
}

/// <summary>
/// 抖音账号探针(全部异步,禁止 .GetAwaiter().GetResult()):
/// - 登录态:cookie 里出现 sessionid / sessionid_ss / sid_guard 即视为已登录;
/// - 健康检查:页面上下文裸 fetch /user/profile/self/(securitySDK 自动补签名),三态判定。
/// </summary>
public static class DouyinProbe
{
    public const string DouyinHomeUrl = "https://www.douyin.com/";
    public const string LikePageUrl = "https://www.douyin.com/user/self?showTab=like";

    /// <summary>异步读 cookie 判断登录态(www + 根域都查,HttpOnly 也能读到)。</summary>
    public static async Task<bool> IsLoggedInAsync(CoreWebView2? core)
    {
        if (core == null) return false;
        try
        {
            foreach (var domain in new[] { "https://www.douyin.com/", "https://douyin.com/" })
            {
                var cookies = await core.CookieManager.GetCookiesAsync(domain);
                foreach (var c in cookies)
                {
                    if (c.Name is "sessionid" or "sessionid_ss" or "sid_guard" && !string.IsNullOrEmpty(c.Value))
                        return true;
                }
            }
            return false;
        }
        catch { return false; }
    }

    /// <summary>
    /// 统一健康检查:页面上下文裸 fetch profile/self(securitySDK 自动补签名)。
    /// 返回 (健康状态, sec_uid)。这是登录窗/验证窗的完成条件,也是风控复核、
    /// sec_uid 探测的唯一信号源:
    /// - Ok      → 登录完成且签名就绪(滑块没滑完、SDK 没就绪都不会是 Ok);
    /// - Blocked → 接口返回 HTML 验证页 = 真风控;
    /// - NotReady → 其余一切失败(空响应/网络异常/未登录/SDK 未就绪)。
    ///
    /// 实现注意:本环境 ExecuteScriptAsync 不等待 promise(async 返回值恒为空),
    /// 因此结果必须走 postMessage 回传(与直连采集同款通道),C# 端 TCS + 超时接收。
    /// </summary>
    public static async Task<(ApiHealth health, string secUid)> CheckHealthAsync(CoreWebView2? core)
    {
        if (core == null) return (ApiHealth.NotReady, "");
        var id = Guid.NewGuid().ToString("N");
        var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        void Handler(object? s, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                var jo = JObject.Parse(e.WebMessageAsJson);
                if (jo?["type"]?.Value<string>() == "health_resp" && jo["id"]?.Value<string>() == id)
                    tcs.TrySetResult(jo["result"]?.Value<string>() ?? "");
            }
            catch { }
        }
        core.WebMessageReceived += Handler;
        try
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            // 取数脚本见 Capture/Scripts/health-check.js(请求原则与直连采集同款:不伪造指纹)
            await core.ExecuteScriptAsync(ScriptLoader.Get("health-check.js").Replace("{{ID}}", id));
            var v = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(6));   // JS 6s 超时 + 余量
            sw.Stop();
            AppLog.Write($"HEALTH {v} ({sw.ElapsedMilliseconds}ms)");
            if (v.StartsWith("ok:", StringComparison.Ordinal)) return (ApiHealth.Ok, v[3..]);
            if (v == "html") return (ApiHealth.Blocked, "");
            return (ApiHealth.NotReady, "");
        }
        catch { AppLog.Write("HEALTH timeout/err"); return (ApiHealth.NotReady, ""); }
        finally { core.WebMessageReceived -= Handler; }
    }

    /// <summary>
    /// 收藏接口(喜欢列表)探测:裸 fetch 第一页(count=1 最小开销)。
    /// 风控分接口场景的关键探针 —— 收藏接口被限时 profile/self 健康检查可能仍 Ok
    /// (实测:favorite 连续超时黑洞,self 277ms 正常返回)。验证窗口的"验证通过"、
    /// 升级弹窗前的预判,都必须以收藏接口本身的恢复为准。
    /// 返回 true = 接口可翻页;false = 黑洞/验证页/异常。
    /// </summary>
    public static async Task<bool> CheckFavoriteApiAsync(CoreWebView2? core, string secUserId)
    {
        if (core == null || string.IsNullOrEmpty(secUserId)) return false;
        var id = Guid.NewGuid().ToString("N");
        var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        void Handler(object? s, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                var jo = JObject.Parse(e.WebMessageAsJson);
                if (jo?["type"]?.Value<string>() == "fav_resp" && jo["id"]?.Value<string>() == id)
                    tcs.TrySetResult(jo["result"]?.Value<string>() ?? "");
            }
            catch { }
        }
        core.WebMessageReceived += Handler;
        try
        {
            // 探测脚本见 Capture/Scripts/favorite-probe.js
            var js = ScriptLoader.Get("favorite-probe.js")
                .Replace("{{ID}}", id)
                .Replace("{{SEC_USER_ID}}", secUserId);
            await core.ExecuteScriptAsync(js);
            var v = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(8));   // JS 6s 超时 + 余量
            AppLog.Write("FAV-PROBE " + v);
            return v == "ok";
        }
        catch { AppLog.Write("FAV-PROBE timeout/err"); return false; }
        finally { core.WebMessageReceived -= Handler; }
    }

    /// <summary>页面是否正显示风控验证(滑块/安全验证)。URL 文案双查,尽量导航后 1s 再调。</summary>
    public static async Task<bool> HasCaptchaAsync(CoreWebView2? core)
    {
        if (core == null) return false;
        const string js = """
            (function () {
              try {
                var u = location.href || '';
                if (u.indexOf('verify') >= 0 || u.indexOf('captcha') >= 0) return true;
                if (!document.body) return false;
                // querySelector 只接受单个选择器(第二参会被忽略);两坑位用逗号列表一次命中
                if (document.querySelector('#captcha, #captcha_verify')) return true;
                if (document.querySelector('[id*="captcha"], [class*="captcha_verify"], [class*="captcha"][style*="visible"]')) return true;
                var s = document.body.innerText || '';
                if (s.indexOf('拖动滑块') >= 0 || s.indexOf('完成验证') >= 0 || s.indexOf('安全验证') >= 0) return true;
              } catch (e) {}
              return false;
            })();
            """;
        try
        {
            var r = await core.ExecuteScriptAsync(js);
            return string.Equals(r?.Trim(), "true", StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    /// <summary>
    /// detail 接口(播放取链)探测:裸 fetch 指定 aweme_id 的详情,三态判定。
    /// 用途:播放取链连续失败时区分"引擎页状态过期(reload 重建 SDK 可修复)"与
    /// "detail 接口真被限(探测同样失败,reload 无用)"——播放侧终于能直接感知 detail 接口状态,
    /// 不必再盲 reload 或依赖验证窗信号(验证窗信号是 favorite/self,代表不了 detail,实测踩坑)。
    /// </summary>
    public static async Task<ApiHealth> CheckDetailApiAsync(CoreWebView2? core, string awemeId)
    {
        if (core == null || string.IsNullOrEmpty(awemeId)) return ApiHealth.NotReady;
        var id = Guid.NewGuid().ToString("N");
        var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        void Handler(object? s, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                var jo = JObject.Parse(e.WebMessageAsJson);
                if (jo?["type"]?.Value<string>() == "detail_resp" && jo["id"]?.Value<string>() == id)
                    tcs.TrySetResult(jo["body"]?.Value<string>() ?? jo["err"]?.Value<string>() ?? "");
            }
            catch { }
        }
        core.WebMessageReceived += Handler;
        try
        {
            // 取数脚本见 Capture/Scripts/detail-fetch.js(6s 超时 + C# TCS 兜底)。
            // ★注意:同一脚本也被 LikeCollector 播放取链通道复用(它按 awemeId 关联 _detailTcsMap)。
            // 探测必须注入独立 RID 让响应带本次 token 回来,否则按 awemeId 匹配会与播放取链
            // 通道互相干扰/永远匹配不上(历史 bug:只替换 AID,id 恒为 awemeId,回调永不命中,
            // 探测每次 6s 超时 → 播放失败自动 reload 恢复链路整条失效)。
            var js = ScriptLoader.Get("detail-fetch.js")
                .Replace("{{AID}}", awemeId)
                .Replace("{{RID}}", Newtonsoft.Json.JsonConvert.ToString(id));   // 探测通道:独立 token,不与播放取链串扰
            await core.ExecuteScriptAsync(js);
            var v = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(8));   // JS 6s 超时 + 余量(与 favorite-probe 同款 8s)
            AppLog.Write("DETAIL-PROBE " + (v?.Length > 80 ? v[..80] : v));
            if (string.IsNullOrEmpty(v) || v.StartsWith("err:", StringComparison.Ordinal)) return ApiHealth.NotReady;
            var t = v.TrimStart();
            if (t.StartsWith("<")) return ApiHealth.Blocked;   // HTML 验证页 = 真风控
            try { _ = JObject.Parse(t); return ApiHealth.Ok; }  // 合法 JSON = detail 接口正常
            catch { return ApiHealth.NotReady; }
        }
        catch { AppLog.Write("DETAIL-PROBE timeout/err"); return ApiHealth.NotReady; }
        finally { core.WebMessageReceived -= Handler; }
    }
}
