using DouyinShuffle.Win.Capture;
using Microsoft.Web.WebView2.Core;
using Newtonsoft.Json.Linq;

namespace DouyinShuffle.Win.Player;

/// <summary>
/// 播放控制器(方案 B:独立纯净播放页):
/// - PlayerWebView:本地 player.html(完全自有的播放器页面,无抖音页面干扰);
/// - 取链仍在隐藏抖音页(DouyinWebView)做(securitySDK 签名依赖),结果递给播放页;
/// - 媒体请求的 Referer/UA 由宿主 WebResourceRequested 改写(见 MainWindow),防盗链无忧;
/// - “原页”按钮:导航抖音页看评论,返回后从记忆进度续播。
/// 消息(播放页 → C#):postMessage({player:'next'|'prev'|'allfailed'|'close'|'openpage'})
/// 命令(C# → 播放页):__dshPlayerLoad(text) / __dshPlayerShow(cfg) / __dshPlayerHide()
/// </summary>
public sealed class PlaybackController
{
    private readonly CoreWebView2 _webView;      // 播放页(本地 player.html)
    private readonly object _sync = new();
    private List<AwemeItem> _queue = new();
    private int _index = -1;
    private bool _active;
    private bool _userInitiated;
    private bool _autoNext;   // 自动连播:当前条目播放结束自动切下一条(默认关)
    private readonly HashSet<string> _refreshedIds = new();
    private int _skipped;

    /// <summary>跳转原页前的播放进度记忆(awemeId → 秒),返回后从此续播。</summary>
    private readonly Dictionary<string, double> _resumePositions = new();

    /// <summary>正在预检/取链的 awemeId(防并发重复)。</summary>
    private readonly HashSet<string> _prefetching = new();

    /// <summary>连续取链失败计数(>=5 自动停止,防风控)。</summary>
    private int _failureStreak;

    /// <summary>当前播放项变化(item, 队列内索引)。</summary>
    public event Action<AwemeItem?, int>? CurrentChanged;

    /// <summary>自动连播开关变化(宿主据此持久化 + 同步主界面勾选态)。</summary>
    public event Action<bool>? AutoNextChanged;

    /// <summary>播放停止。</summary>
    public event Action? Closed;

    /// <summary>已跳转原页(宿主应弹出独立抖音窗口显示该视频页)。参数:aweme_id。</summary>
    public event Action<string>? PageOpened;

    /// <summary>请求返回应用并续播(从原页触发)。</summary>
    public event Action? ResumeRequested;

    /// <summary>一般性提示。</summary>
    public event Action<string>? Notice;

    /// <summary>取链连续失败(疑似风控)。携带失败时的队列索引,宿主 reload 引擎页后可从此重试。</summary>
    public event Action<int>? RiskDetected;

    /// <summary>请求窗口全屏切换(播放页 JS 的全屏按钮/双击/F 键)。</summary>
    public event Action? FullscreenToggleRequested;

    /// <summary>实时取链器(抖音页上下文):输入 aweme_id,返回新鲜直链/图片/音乐;失败返回 null。</summary>
    public Func<string, Task<FreshMedia?>>? FreshUrlFetcher;

    /// <summary>播放页就绪任务(宿主注入;页面没加载完时点播放,先等就绪再注入命令)。</summary>
    public Task? PageReadyTask;

    public PlaybackController(CoreWebView2 playerWebView)
    {
        _webView = playerWebView;
        _webView.WebMessageReceived += OnMessage;
    }

    public bool IsActive { get { lock (_sync) return _active; } }
    public bool AutoNext { get { lock (_sync) return _autoNext; } }
    public IReadOnlyList<AwemeItem> Queue { get { lock (_sync) return _queue.ToList(); } }
    public int CurrentIndex { get { lock (_sync) return _index; } }

    /// <summary>设置自动连播开关(播放页/主界面切换、启动恢复统一入口;单一真源)。</summary>
    public void SetAutoNext(bool on)
    {
        lock (_sync) _autoNext = on;
        AutoNextChanged?.Invoke(on);
        _ = EvalAsync($"window.__dshSetAutoNext ? window.__dshSetAutoNext({(on ? "true" : "false")}) : 0");
    }

    /// <summary>导航播放页到 player.html(本地文件)。</summary>
    public Task NavigateAsync(string playerHtmlPath)
    {
        return Task.CompletedTask;
        // 实际导航由宿主做(需要 Navigate 到文件),这里只保留接口占位
    }

    /// <summary>设置队列(复制,保持收集顺序)。</summary>
    public void SetQueue(IEnumerable<AwemeItem> items)
    {
        lock (_sync) _queue = items.ToList();
    }

    /// <summary>追加一条到队尾。</summary>
    public void Append(AwemeItem item)
    {
        lock (_sync) _queue.Add(item);
    }

    /// <summary>Fisher-Yates 洗牌(原地)。</summary>
    public void Shuffle()
    {
        lock (_sync)
        {
            var rnd = Random.Shared;
            for (int i = _queue.Count - 1; i > 0; i--)
            {
                int j = rnd.Next(i + 1);
                (_queue[i], _queue[j]) = (_queue[j], _queue[i]);
            }
        }
    }

    /// <summary>从指定索引开始播放。取链失败自动跳过;连续 5 条失败停止。</summary>
    public Task PlayAtAsync(int index, bool userInitiated = false)
    {
        AwemeItem? item;
        lock (_sync)
        {
            if (index < 0 || index >= _queue.Count) return Task.CompletedTask;
            item = _queue[index];
            _index = index;
            _active = true;
            _userInitiated = userInitiated;
        }
        return ShowCurrentAsync();
    }

    /// <summary>洗牌后从头播放。</summary>
    public async Task StartShuffledAsync()
    {
        Shuffle();
        await PlayAtAsync(0, userInitiated: true);
    }

    /// <summary>宿主 reload 引擎页重建 SDK 后,从指定索引重试播放(取链失败自愈链路)。</summary>
    public Task RetryPlayAsync(int index) => PlayAtAsync(index, userInitiated: true);

    private Task NextAsync() => AdvanceAsync(1);
    private Task PrevAsync() => AdvanceAsync(-1);

    private async Task AdvanceAsync(int delta)
    {
        int next;
        lock (_sync)
        {
            if (delta > 0) next = _index + 1 < _queue.Count ? _index + 1 : -1;
            else next = _index > 0 ? _index - 1 : -1;
        }
        if (next < 0)
        {
            await StopAsync();
            return;
        }
        await PlayAtAsync(next, userInitiated: delta < 0);
    }

    public async Task StopAsync()
    {
        lock (_sync)
        {
            _active = false;
            _index = -1;
        }
        await EvalAsync("window.__dshPlayerHide ? window.__dshPlayerHide() : 0");
        if (_skipped > 0)
            Notice?.Invoke($"播放结束,已跳过 {_skipped} 条失效内容。");
        lock (_sync) _skipped = 0;
        Closed?.Invoke();
    }

    private async Task ShowCurrentAsync()
    {
        AwemeItem? it;
        lock (_sync)
        {
            if (_index < 0 || _index >= _queue.Count) return;
            it = _queue[_index];
        }

        // 严格新链模式:播放前必须取到新链。取链期间播放页显示 loader。
        await EvalAsync($"window.__dshPlayerLoad ? window.__dshPlayerLoad({Json("正在获取播放地址…")}) : 0");

        var fresh = FreshUrlFetcher != null ? await SafeFetchAsync(it) : null;
        if (fresh is { HasAny: true })
        {
            lock (_sync) _failureStreak = 0;
            await ShowCurrentCoreAsync(it);
            _ = PrefetchNextAsync(_index);
            return;
        }

        // 取链失败
        lock (_sync) _failureStreak++;
        if (_failureStreak >= 5)
        {
            var failedIndex = _index;   // StopAsync 会清 _index,先记下重试锚点
            Notice?.Invoke("连续 5 条无法获取新链接(可能触发风控),已停止播放。");
            RiskDetected?.Invoke(failedIndex);
            await StopAsync();
            return;
        }
        lock (_sync) _skipped++;
        Notify("该内容无法获取新链接(可能已下架),已跳过。");
        await AdvanceAsync(1);
    }

    /// <summary>调用取链器并应用结果到 item;重试一次。返回 null 表示失败。</summary>
    private async Task<FreshMedia?> SafeFetchAsync(AwemeItem item)
    {
        // 预检缓存命中 → 直接用 item 里的新链
        lock (_sync)
        {
            if (_refreshedIds.Contains(item.AwemeId))
            {
                return item.PlayUrls.Count > 0 || item.ImageUrls.Count > 0
                    ? new FreshMedia { PlayUrls = item.PlayUrls, ImageUrls = item.ImageUrls, MusicUrl = item.MusicUrl }
                    : null;
            }
        }
        for (var attempt = 0; attempt < 2; attempt++)
        {
            try
            {
                var fresh = await FreshUrlFetcher!(item.AwemeId);
                if (fresh is { HasAny: true })
                {
                    // 过滤直链:并行探测(串行 3×6s=18s 太慢;总超时 2.5s,超时后不再等慢探测)
                    var aliveUrls = new List<string>();
                    if (fresh.PlayUrls.Count > 0)
                    {
                        var candidates = fresh.PlayUrls.Take(3).ToList();
                        var probes = candidates.Select(u => Task.Run(async () =>
                        {
                            try { return await LinkProber.IsAliveAsync(u) ? u : null; }
                            catch { return null; }
                        })).ToList();
                        await Task.WhenAny(Task.WhenAll(probes), Task.Delay(2500));
                        foreach (var p in probes)
                        {
                            if (p.IsCompletedSuccessfully && p.Result != null) aliveUrls.Add(p.Result);
                        }
                    }
                    lock (_sync)
                    {
                        if (aliveUrls.Count > 0) { item.PlayUrls = aliveUrls; item.PlayUrl = aliveUrls[0]; }
                        else if (fresh.PlayUrls.Count > 0) { item.PlayUrls = fresh.PlayUrls; item.PlayUrl = fresh.PlayUrls[0]; }
                        if (fresh.ImageUrls.Count > 0) item.ImageUrls = fresh.ImageUrls;
                        if (fresh.MusicUrl.Length > 0) item.MusicUrl = fresh.MusicUrl;
                        if (fresh.CoverUrl.Length > 0 && item.CoverUrl != fresh.CoverUrl)
                            item.CoverUrl = fresh.CoverUrl;
                        _refreshedIds.Add(item.AwemeId);
                    }
                    return fresh;
                }
            }
            catch { }
            if (attempt == 0) await Task.Delay(1200);
        }
        return null;
    }

    /// <summary>构建 cfg 并注入播放页(实际播放动作)。</summary>
    private async Task ShowCurrentCoreAsync(AwemeItem it)
    {
        // 播放页尚未加载完成(应用刚启动就点播放)→ 等就绪(最多 5s)
        if (PageReadyTask != null && !PageReadyTask.IsCompleted)
        {
            try { await PageReadyTask.WaitAsync(TimeSpan.FromSeconds(5)); } catch { }
        }
        var urlsJson = it.PlayUrls.Count > 0
            ? Newtonsoft.Json.JsonConvert.SerializeObject(it.PlayUrls)
            : Newtonsoft.Json.JsonConvert.SerializeObject(new[] { it.PlayUrl });
        var imagesJson = Newtonsoft.Json.JsonConvert.SerializeObject(it.ImageUrls);
        var timeText = it.CreateTime > 0
            ? DateTimeOffset.FromUnixTimeSeconds(it.CreateTime).ToLocalTime().ToString("yyyy-MM-dd")
            : "";
        double resume = 0;
        lock (_sync) { _resumePositions.TryGetValue(it.AwemeId, out resume); }
        var cfg = string.Concat(
            "{urls:", urlsJson,
            ",images:", imagesJson,
            ",music:", Json(it.MusicUrl),
            ",title:", Json(it.Desc),
            ",author:", Json(it.AuthorName),
            ",time:", Json(timeText),
            ",resume:", resume.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture),
            ",index:", _index,
            ",total:", Queue.Count,
            ",autoNext:", AutoNext ? "true" : "false", "}");
        await EvalAsync("window.__dshPlayerShow ? window.__dshPlayerShow(" + cfg + ") : 0");
        CurrentChanged?.Invoke(it, _index);
    }

    /// <summary>后台预检:提前为接下来 3 条取新链,命中缓存的播放时零等待。带节流防风控。</summary>
    private async Task PrefetchNextAsync(int currentIndex)
    {
        try
        {
            const int window = 3;
            for (var offset = 1; offset <= window; offset++)
            {
                AwemeItem? next;
                lock (_sync)
                {
                    if (!_active) return;
                    var i = currentIndex + offset;
                    if (i < 0 || i >= _queue.Count) return;
                    next = _queue[i];
                    if (_refreshedIds.Contains(next.AwemeId)) continue;
                    if (!_prefetching.Add(next.AwemeId)) continue;
                }
                try
                {
                    await SafeFetchAsync(next);
                    await Task.Delay(350);
                }
                finally
                {
                    lock (_sync) _prefetching.Remove(next.AwemeId);
                }
            }
        }
        catch { }
    }

    // ---------- 消息(来自播放页) ----------

    private void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            var jo = JObject.Parse(e.WebMessageAsJson);
            if (jo["player"] == null) return;
            var msg = jo["player"]!.Value<string>();
            AppLog.Write($"PLAY MSG {msg}");

            switch (msg)
            {
                case "ended":
                    break;   // 循环播放(抖音式:滚轮/按钮切歌)
                case "allfailed":
                case "error":
                    _ = HandleFailAsync();
                    break;
                case "diag":
                    // 诊断:w/h=0 → 解码失败(典型:HEVC 无解码器);记录供排查
                    AppLog.Write($"PLAY DIAG video {jo["w"]}x{jo["h"]} codec={jo["codec"]}");
                    if ((jo["w"]?.Type ?? Newtonsoft.Json.Linq.JTokenType.Null) == Newtonsoft.Json.Linq.JTokenType.Integer
                        && jo["w"]!.Value<int>() == 0)
                        Notify("画面解码失败(可能是 H.265 编码且系统缺 HEVC 支持),已尝试切换备用链接。");
                    break;
                case "next":
                    _ = NextAsync();
                    break;
                case "autonext":
                    // 播放页 toggle 上报目标值;C# 单一真源,持久化后回写幂等
                    if (jo["on"]?.Type == Newtonsoft.Json.Linq.JTokenType.Boolean)
                        SetAutoNext(jo["on"]!.Value<bool>());
                    else
                        SetAutoNext(!AutoNext);
                    break;
                case "prev":
                    _ = PrevAsync();
                    break;
                case "shuffle":
                    Shuffle();
                    if (IsActive) _ = PlayAtAsync(0, userInitiated: true);
                    break;
                case "close":
                    _ = StopAsync();
                    break;
                case "openpage":
                    _ = OpenPageCurrentAsync();
                    break;
                case "fullscreen":
                    FullscreenToggleRequested?.Invoke();
                    break;
                case "queueJump":
                    // 播放队列侧栏:跳转到指定索引播放
                    _ = PlayAtAsync(jo["index"]?.Value<int>() ?? -1, userInitiated: true);
                    break;
                case "queueSlice":
                    // 播放队列侧栏:按需返回队列片段(标题/图集标记),避免几万条整传
                    SendQueueSlice(jo["from"]?.Value<int>() ?? 0, jo["count"]?.Value<int>() ?? 80);
                    break;
                case "resume":
                    ResumeRequested?.Invoke();
                    break;
            }
        }
        catch { }
    }

    // ---------- 失效处理 ----------

    /// <summary>
    /// 播放队列侧栏取片段:锁内手工拼 JSON(仅 i/标题/图集标记),整队列几万条不整传;
    /// 结果注入播放页 __dshQueueSlice(items,total,current)。
    /// </summary>
    private void SendQueueSlice(int from, int count)
    {
        if (count is < 1 or > 200) count = 80;
        if (from < 0) from = 0;
        string json;
        int total, cur;
        lock (_sync)
        {
            total = _queue.Count;
            cur = _index;
            if (from >= total) json = "[]";
            else
            {
                var sb = new System.Text.StringBuilder();
                sb.Append('[');
                var end = Math.Min(from + count, total);
                for (var k = from; k < end; k++)
                {
                    if (k > from) sb.Append(',');
                    var it = _queue[k];
                    sb.Append("{\"i\":").Append(k)
                      .Append(",\"t\":").Append(Newtonsoft.Json.JsonConvert.ToString(it.Desc))
                      .Append(",\"c\":").Append(Newtonsoft.Json.JsonConvert.ToString(it.CoverUrl))
                      .Append(",\"g\":").Append(it.PlayUrls.Count == 0 && it.ImageUrls.Count > 0 ? "true" : "false")
                      .Append('}');
                }
                sb.Append(']');
                json = sb.ToString();
            }
        }
        _ = EvalAsync($"window.__dshQueueSlice && window.__dshQueueSlice({json},{total},{cur})");
    }

    private async Task HandleFailAsync()
    {
        if (await TryRefreshCurrentAsync()) return;
        Notify("该内容无法播放,滚轮切换或点【跳过】。");
    }

    /// <summary>现场实时取链后重播(每视频一次)。</summary>
    private async Task<bool> TryRefreshCurrentAsync()
    {
        AwemeItem? item = null;
        int startIndex;
        lock (_sync)
        {
            if (!_active || _index < 0 || _index >= _queue.Count) return false;
            item = _queue[_index];
            startIndex = _index;
        }
        if (FreshUrlFetcher == null) return false;
        if (!_refreshedIds.Add(item.AwemeId)) return false;

        Notify("正在实时获取最新链接…");
        var fresh = await FreshUrlFetcher(item.AwemeId);
        lock (_sync)
        {
            if (!_active || _index != startIndex) return false;
        }
        if (fresh is { HasAny: true })
        {
            lock (_sync)
            {
                if (fresh.PlayUrls.Count > 0) { item.PlayUrls = fresh.PlayUrls; item.PlayUrl = fresh.PlayUrls[0]; }
                if (fresh.ImageUrls.Count > 0) item.ImageUrls = fresh.ImageUrls;
                if (fresh.MusicUrl.Length > 0) item.MusicUrl = fresh.MusicUrl;
            }
            await ShowCurrentAsync();
            return true;
        }
        return false;
    }

    // ---------- 原页(看评论) ----------

    /// <summary>宿主把“原页”操作代理到这里:记录进度由宿主在导航前调用 RecordProgressAsync。</summary>
    public async Task RecordProgressAsync()
    {
        AwemeItem? item;
        lock (_sync)
        {
            if (_index < 0 || _index >= _queue.Count) return;
            item = _queue[_index];
        }
        double pos = 0;
        try
        {
            var raw = await _webView.ExecuteScriptAsync(
                "(function(){var v=document.getElementById('dsh-video');return v?v.currentTime:0;})();");
            double.TryParse(raw?.Trim().Trim('"'), System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out pos);
        }
        catch { }
        lock (_sync)
        {
            if (pos >= 2) _resumePositions[item.AwemeId] = pos;
        }
    }

    /// <summary>在抖音页导航到当前视频原页(评论)。播放页由宿主隐藏。</summary>
    private async Task OpenPageCurrentAsync()
    {
        AwemeItem? item;
        lock (_sync)
        {
            if (_index < 0 || _index >= _queue.Count) return;
            item = _queue[_index];
        }
        await RecordProgressAsync();
        PauseCurrent();
        PageOpened?.Invoke(item.AwemeId);
    }

    /// <summary>宿主供悬浮按钮等触发"返回播放"。</summary>
    public void RequestResume() => ResumeRequested?.Invoke();

    /// <summary>宿主导航回播放页后调用:从记忆进度恢复播放当前条目。</summary>
    public void ResumeAfterNavigate()
    {
        int idx;
        lock (_sync)
        {
            if (!_active || _index < 0 || _index >= _queue.Count) return;
            idx = _index;
        }
        _ = PlayAtAsync(idx, userInitiated: true);
    }

    /// <summary>暂停当前播放(打开原页/弹窗时,避免两处声音叠加)。</summary>
    public void PauseCurrent()
    {
        _ = EvalAsync("(function(){var v=document.getElementById('dsh-video');if(v&&!v.paused)v.pause();var a=document.getElementById('dsh-audio');if(a&&!a.paused)a.pause();return true;})();");
    }

    // ---------- 辅助 ----------

    private async Task EvalAsync(string js)
    {
        try { await _webView.ExecuteScriptAsync(js); }
        catch { }
    }

    /// <summary>
    /// 双通道提示:播放期间 UI 页是 Collapsed 的,Notice 事件(toast)用户看不见 →
    /// 同时把文案注入播放页 loader(__dshPlayerLoad),播放中也能看到发生了什么。
    /// </summary>
    private void Notify(string msg)
    {
        Notice?.Invoke(msg);
        _ = EvalAsync($"window.__dshPlayerLoad ? window.__dshPlayerLoad({Json(msg)}) : 0");
    }

    private static string Json(string? s) => Newtonsoft.Json.JsonConvert.ToString(s ?? "");
}
