using Microsoft.Web.WebView2.Core;
using Newtonsoft.Json.Linq;

namespace DouyinShuffle.Win.Capture;

/// <summary>
/// 采集器(浏览器即签名器架构的 WebView2 实现):
/// 引擎页保持"零初始化脚本"的干净状态,采集脚本经 ExecuteScriptAsync 瞬时注入(用后即弃),
/// 在页面上下文发裸 fetch 由 webmssdk 拦截器自动补签名,响应经消息通道回传统一入库。
///
/// 采集为单一通道(paged-loop.js,历史教训:曾有"主动签名"二级回退通道,
/// 依赖的全局签名函数在新版抖音已收进 webmssdk 内部,实测 10 次调用零成功,已删)。
/// 失败分流由宿主编排:网络抖动 → 退避重试;限流 → favorite 探测确认后弹滑块。
///
/// 消息协议(JS → C#,全部经 chrome.webview.postMessage):
/// - direct_started  {cursor}          脚本已执行(同步心跳;看门狗喂狗)
/// - direct_resp     {url, status, body}  单页响应体(→ ProcessBody 入库)
/// - direct_progress {fetched, cursor, items, totalItems}  页级进度(→ 状态栏/大数字)
/// - direct_fail     {fetched, empty, status, body}  页级失败(诊断日志)
/// - direct_done     {reason, fetched, totalItems}   循环结束(→ TCS 结果)
///   reason ∈ complete/incremental/stalled/safety/stopped/blocked/notready
/// - detail_resp     {id, body|err}   实时取链结果(→ FetchFreshUrlsByApiAsync)
///
/// 历史教训(勿倒退):
/// - 任何文档创建时(AddScriptToExecuteOnDocumentCreatedAsync)的 fetch/XHR 包装都会被
///   webmssdk 检测/干扰其签名层 → 直连被服务端黑洞(旧 BridgeJs/CaptureJs/SignHelperJs 已删);
/// - 静音/关弹窗等需求改经 ExecuteScriptAsync 瞬时注入,不碰 window.fetch。
/// </summary>
public sealed class LikeCollector
{
    private readonly CoreWebView2 _webView;
    private readonly Dictionary<string, AwemeItem> _items = new();
    private readonly object _sync = new();
    private long _maxCursor;
    private string _currentUrl = "";

    /// <summary>直连翻页模式:响应不过位置闸门(可能不在喜欢页)。</summary>
    private volatile bool _directMode;

    /// <summary>直连结束通知(JS 循环回传 direct_done 时置位)。</summary>
    private TaskCompletionSource<string>? _directTcs;

    /// <summary>直连心跳(direct_started 同步回传;看门狗用,防脚本语法错等静默死亡)。</summary>
    private TaskCompletionSource<bool>? _directHeartbeatTcs;

    /// <summary>直连采集是否正在进行(并发保护:同时只允许一个 JS 翻页循环)。</summary>
    private volatile bool _directRunning;

    /// <summary>直连采集中已入库条数(进度推送用;JS 只回传页级进度)。</summary>
    private int _directStoredAtStart;

    /// <summary>接口失败退避重试中(direct_fail 置位,direct_progress 清除)→ 进度文案附带"接口受限正在重试"提示。</summary>
    private bool _retrying;

    /// <summary>当前采集轮次(分轮续采时由宿主设置,进度文本展示用;默认 1)。</summary>
    public int Round { get; set; } = 1;

    /// <summary>采集开关(调试用;关闭后不处理任何响应)。</summary>
    public bool CaptureEnabled { get; set; } = true;

    /// <summary>新增一条(UI 线程)。</summary>
    public event Action<AwemeItem>? ItemAdded;

    /// <summary>状态变化(UI 线程)。</summary>
    public event Action<string>? StatusChanged;

    /// <summary>已采数量变化(UI 线程,实时)。</summary>
    public event Action<int>? CountChanged;

    /// <summary>疑似被风控(直连连续空响应)。宿主应复核后弹验证窗口。</summary>
    public event Action? RiskDetected;

    /// <summary>诊断信息(分页空响应/疑似风控等)。</summary>
    public event Action<string>? Diagnostic;

    public LikeCollector(CoreWebView2 webView)
    {
        _webView = webView;
        webView.NavigationCompleted += (_, _) => _currentUrl = webView.Source;
        webView.WebMessageReceived += OnWebMessageReceived;
    }

    /// <summary>
    /// 初始化(干净页面,零初始化脚本)。占位与文档锚点。
    /// </summary>
    public Task InstallAsync() => Task.CompletedTask;

    public IReadOnlyCollection<AwemeItem> Items
    {
        get { lock (_sync) return _items.Values.ToList(); }
    }

    /// <summary>O(1) 计数(避免每加一条就复制整个列表)。</summary>
    public int Count
    {
        get { lock (_sync) return _items.Count; }
    }

    public long MaxCursor { get { lock (_sync) return _maxCursor; } }
    public bool IsRunning => _directRunning;

    /// <summary>最近一次响应的边界游标(每页解析即更新,不受 trackCursor 影响)。
    /// 两阶段采集(issue #3):头部增量阶段按编排器传入的 trackCursor 决定是否回写断点,
    /// 续轮起点由编排器读本属性驱动 —— 已有深断点时断点(_maxCursor)保持原值不互踩。</summary>
    private long _lastBoundary;

    /// <summary>当前轮次是否把翻页进度回写断点游标(经 StartDirectAsync 传入;默认 true=旧行为)。</summary>
    private volatile bool _trackCursor = true;

    /// <summary>最近一次解析到的边界游标(0=本轮还没有合法页)。</summary>
    public long LastBoundaryCursor { get { lock (_sync) return _lastBoundary; } }

    // ---------- 消息回传 ----------

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            if (!CaptureEnabled) return;
            var jo = JObject.Parse(e.WebMessageAsJson);
            var type = jo["type"]?.Value<string>();

            // 采集结束通知
            if (type == "direct_done")
            {
                var reason = jo["reason"]?.Value<string>() ?? "unknown";
                var fetched = jo["fetched"]?.Value<int>() ?? 0;
                var totalItems = jo["totalItems"]?.Value<int>() ?? 0;
                Diagnostic?.Invoke($"DIRECT-DONE reason={reason} pages={fetched} rawItems={totalItems} stored={Count}");
                // 首页即失败(fetched=0)= 接口黑洞 → 宿主切换二级签名采集,不当风控处理;
                // 采集中途失败(fetched>0)才走风控复核流程
                if (reason is "blocked" or "error" && fetched > 0)
                    RiskDetected?.Invoke();
                _directTcs?.TrySetResult($"{reason}:{fetched}");
                return;
            }

            // 采集心跳:脚本开始执行(看门狗喂狗)
            if (type == "direct_started")
            {
                Diagnostic?.Invoke($"COLLECT-STARTED cursor={jo["cursor"]?.Value<long>() ?? 0}");
                _directHeartbeatTcs?.TrySetResult(true);
                return;
            }

            // 页级失败上报(诊断:状态码 + 响应体片段);退避重试中 → 进度文案附带提示
            if (type == "direct_fail")
            {
                var status = jo["status"]?.Value<int>() ?? 0;
                var empty = jo["empty"]?.Value<int>() ?? 0;
                var head = (jo["body"]?.Value<string>() ?? "").Replace("\n", " ");
                if (head.Length > 80) head = head[..80];
                Diagnostic?.Invoke($"DIRECT-FAIL empty={empty} status={status} body={head}");
                _retrying = true;   // 采不动:接口失败退避重试中
                return;
            }

            // 页级进度(状态栏实时反馈:轮次 + 本轮新增 + 累计)
            if (type == "direct_progress")
            {
                var fetched = jo["fetched"]?.Value<int>() ?? 0;
                var newCount = Count - _directStoredAtStart;
                var retryTip = _retrying ? " · 接口受限正在重试,被动失败后请等一会儿再采集" : "";
                StatusChanged?.Invoke($"采集中(第 {Round} 轮):本轮新增 {newCount} 条 · 已采 {Count} 条(本轮第 {fetched} 页)…{retryTip}");
                _retrying = false;   // 有成功页返回 → 恢复为正常采集状态
                CountChanged?.Invoke(Count);
                return;
            }

            // 裸 fetch 取链结果(实时刷新直链用)
            if (type == "detail_resp")
            {
                var id = jo["id"]?.Value<string>() ?? "";
                var err = jo["err"]?.Value<string>();
                FreshMedia? result = null;
                if (string.IsNullOrEmpty(err))
                {
                    var detailBody = jo["body"]?.Value<string>();
                    if (!string.IsNullOrEmpty(detailBody))
                    {
                        try
                        {
                            var jo2 = JObject.Parse(detailBody);
                            if (jo2["aweme_detail"] is JObject det)
                            {
                                var item = AwemeParser.FromToken(det, extractLinks: true);
                                if (item.AwemeId.Length > 0)
                                    result = new FreshMedia
                                    {
                                        PlayUrls = item.PlayUrls,
                                        ImageUrls = item.ImageUrls,
                                        LiveImageUrls = item.LiveImageUrls,   // 实况动态子链(v1.0.7;曾遗漏导致动图显示为静态)
                                        MusicUrl = item.MusicUrl,
                                        CoverUrl = item.CoverUrl
                                    };
                            }
                        }
                        catch { }
                    }
                }
                lock (_sync)
                {
                    if (_detailTcsMap.TryGetValue(id, out var tcs))
                        tcs.TrySetResult(result);
                }
                return;
            }

            if (type != "direct_resp") return;
            var body = jo["body"]?.Value<string>();
            if (string.IsNullOrEmpty(body)) return;
            if (!body.TrimStart().StartsWith("{")) return;   // HTML(验证页)由 direct_fail 上报

            ProcessBody(body);
        }
        catch
        {
            // 非采集消息,忽略
        }
    }

    private void ProcessBody(string body)
    {
        var parsed = AwemeParser.Parse(body);

        // 位置闸门:被动捕获(页面自身请求)只收"用户主页喜欢 Tab"的数据;
        // 直连翻页模式响应来自页面签名的定向 fetch,不受页面位置限制。
        if (!_directMode && !(_currentUrl.Contains("/user/") && _currentUrl.Contains("showTab=like"))) return;

        lock (_sync)
        {
            foreach (var item in parsed.Items)
            {
                if (_items.TryAdd(item.AwemeId, item))
                {
                    ItemAdded?.Invoke(item);
                }
                else
                {
                    // 已存在 → 更新直链(链接保鲜:重采时刷新旧条目链接,播放不因链接过期而卡)
                    if (_items.TryGetValue(item.AwemeId, out var existing))
                    {
                        var changed = false;
                        if (item.PlayUrls.Count > 0 && !ListsEqual(existing.PlayUrls, item.PlayUrls))
                        {
                            existing.PlayUrls = item.PlayUrls;
                            existing.PlayUrl = item.PlayUrls[0];
                            changed = true;
                        }
                        if (item.ImageUrls.Count > 0 && !ListsEqual(existing.ImageUrls, item.ImageUrls))
                        {
                            existing.ImageUrls = item.ImageUrls;
                            changed = true;
                        }
                        if (item.MusicUrl.Length > 0 && existing.MusicUrl != item.MusicUrl)
                        {
                            existing.MusicUrl = item.MusicUrl;
                            changed = true;
                        }
                        if (changed) ItemAdded?.Invoke(existing);
                    }
                }
            }
            if (parsed.MaxCursor > 0)
            {
                _lastBoundary = parsed.MaxCursor;   // 边界游标:每页即记(两阶段续轮用,不受 trackCursor 影响)
                if (_trackCursor) _maxCursor = parsed.MaxCursor;   // 断点游标:仅断点续采阶段回写
            }
        }
    }

    // ---------- 实时取链(播放前刷新直链) ----------

    /// <summary>裸 fetch 取链挂起的 TCS(awemeId → 结果)。</summary>
    private readonly Dictionary<string, TaskCompletionSource<FreshMedia?>> _detailTcsMap = new();

    /// <summary>实时取链(播放前刷新直链):页面签名的 detail 接口,返回最新直链。</summary>
    public async Task<FreshMedia?> FetchFreshUrlsByApiAsync(string awemeId)
    {
        TaskCompletionSource<FreshMedia?> tcs;
        lock (_sync)
        {
            // 并发重复取链(预取与手动播放竞态):复用同一等待句柄。
            // 旧实现直接覆盖 → 先到者失去 TCS,只能挂满 6s 超时,表现为播放莫名变慢。
            if (_detailTcsMap.TryGetValue(awemeId, out var existing) && !existing.Task.IsCompleted)
                tcs = existing;
            else
            {
                tcs = new TaskCompletionSource<FreshMedia?>(TaskCreationOptions.RunContinuationsAsynchronously);
                _detailTcsMap[awemeId] = tcs;
            }
        }
        try
        {
            var js = ScriptLoader.Get("detail-fetch.js")
                .Replace("{{AID}}", awemeId)
                .Replace("{{RID}}", "null");   // 播放取链通道按 awemeId 关联 → RID 置 null,id 回传 AID
            await _webView.ExecuteScriptAsync(js);
            return await tcs.Task.WaitAsync(TimeSpan.FromSeconds(6));
        }
        catch { return null; }
        finally
        {
            lock (_sync)
            {
                if (_detailTcsMap.TryGetValue(awemeId, out var cur) && ReferenceEquals(cur, tcs))
                    _detailTcsMap.Remove(awemeId);
            }
        }
    }

    // ---------- 翻页采集(单一通道) ----------

    /// <summary>启动直连翻页采集(公开入口)。
    /// trackCursor(默认 true):是否把翻页进度回写断点游标(_maxCursor)。
    /// hardResume(默认 false):断点硬续模式 —— 禁用"整页已知→incremental"停。
    /// 两参数刻意解耦(issue #3 两阶段采集):
    ///   头部增量轮:hardResume=false(增量语义,补完新点赞即停;knownIds 表生效),
    ///     trackCursor=仅当无深断点时 true(有深断点时增量边界不得覆盖断点);
    ///   断点续尾部轮:hardResume=true(硬续区都该是未采内容,出现整页已知=接口卡页,
    ///     停成 incremental 会清断点、重演"卡在几千条再采无新增"),trackCursor=true。
    /// </summary>
    public Task<string> StartDirectAsync(string secUserId, long startCursor,
        IReadOnlyCollection<string> knownIds, CancellationToken cancellationToken,
        bool trackCursor = true, bool hardResume = false)
        => RunPagedLoopAsync(secUserId, startCursor, knownIds, cancellationToken, trackCursor, hardResume);

    /// <summary>
    /// 直连翻页采集。裸 fetch + 结构性参数,webmssdk 拦截器自动补签名,
    /// 循环改 max_cursor 翻页,响应经消息通道回传复用 ProcessBody 入库。
    /// 增量模式:knownIds 非空时,整页全为已知 ID 即停(喜欢列表倒序,断点后旧内容无需重翻)。
    /// </summary>
    private async Task<string> RunPagedLoopAsync(string secUserId, long startCursor,
        IReadOnlyCollection<string> knownIds, CancellationToken cancellationToken,
        bool trackCursor = true, bool hardResume = false)
    {
        if (_directRunning) return "busy"; // 已有翻页循环,拒绝并发
        if (string.IsNullOrEmpty(secUserId)) return "nouser";
        _directRunning = true;
        _directStoredAtStart = Count;
        _trackCursor = trackCursor;   // busy 检查之后才置位:不污染已在跑轮次的游标行为
        lock (_sync) _lastBoundary = 0;

        // 已有数据量大时启用增量(至少 50 条才有意义;全量重采只在用户主动清空后)
        List<string> known;
        lock (_sync) known = _items.Keys.ToList();
        var useIncremental = knownIds.Count > 0 && known.Count >= 50;
        var knownJson = "null";
        if (useIncremental)
        {
            // 对象字面量({"id":1,...}):O(1) 命中查找(数组 indexOf 对 6 万条是 O(n) 每条)。
            // 不设条数上限:截断会让超限部分退化为"未知",增量整页已知即停的判断失真 → 重翻全量。
            // 10 万条级列表脚本约 2.7MB,ExecuteScriptAsync 可承受,正确性优先。
            var sb = new System.Text.StringBuilder("{");
            foreach (var id in knownIds)
            {
                sb.Append(Newtonsoft.Json.JsonConvert.SerializeObject(id));
                sb.Append(":1,");
            }
            if (sb.Length > 1) sb.Length--;   // 去尾逗号
            sb.Append('}');
            knownJson = sb.ToString();
        }

        var js = ScriptLoader.Get("paged-loop.js")
            .Replace("{{SEC_USER_ID}}", secUserId)
            .Replace("{{START_CURSOR}}", startCursor.ToString())
            .Replace("{{KNOWN_IDS}}", knownJson)
            .Replace("{{RESUME_MODE}}", hardResume ? "1" : "0");   // 硬续模式与是否写断点解耦(头部增量轮永远是增量语义)

        // JS 循环是 async IIFE,ExecuteScriptAsync 不会等它完成 → 用 direct_done 消息驱动结束
        _directTcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        _directHeartbeatTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        _directMode = true;
        try
        {
            // 启动 JS 循环(不等待;同步心跳 direct_started 会立即回传,日志可验证脚本已执行)
            await _webView.ExecuteScriptAsync(js);
            Diagnostic?.Invoke("COLLECT-DISPATCHED");

            // 看门狗:5 秒内无心跳 = 脚本未执行(语法错/页面上下文失效)→ 立即报错,
            // 不再挂到用户手动停止才发现(曾经因模板替换缺个右花括号静默死亡 40 分钟)
            var firstDone = await Task.WhenAny(_directHeartbeatTcs.Task, Task.Delay(5000));
            if (firstDone != _directHeartbeatTcs.Task)
            {
                Diagnostic?.Invoke("COLLECT-NO-HEARTBEAT(script not executed)");
                return "error:no_heartbeat";
            }

            // 取消 → 置位 JS 停止标志 + 兜底结束
            using var reg = cancellationToken.Register(() =>
            {
                try { _ = _webView.ExecuteScriptAsync("window.__dsh_direct_stop__=true;"); } catch { }
                _directTcs?.TrySetResult("stopped:0");
            });

            // 等 JS 回传 direct_done;超时 90 分钟兜底(5.8万条 ≈ 3000+ 页)
            return await _directTcs.Task.WaitAsync(TimeSpan.FromMinutes(90));
        }
        catch (OperationCanceledException) { return "stopped"; }
        catch (Exception ex) { return "error:" + ex.Message; }
        finally
        {
            _directMode = false;
            _directTcs = null;
            _directHeartbeatTcs = null;
            _directRunning = false;
        }
    }

    // ---------- 持久化合并 ----------

    /// <summary>两个字符串列表是否相等(顺序无关,用于判断直链是否变化)。</summary>
    private static bool ListsEqual(List<string> a, List<string> b)
    {
        if (a.Count != b.Count) return false;
        var set = new HashSet<string>(a);
        return b.All(set.Contains);
    }

    /// <summary>启动时回填持久化数据(含上次翻页断点 cursor,断点续采用)。</summary>
    public void Seed(IEnumerable<AwemeItem> saved, long maxCursor = 0)
    {
        lock (_sync)
        {
            foreach (var item in saved)
                _items.TryAdd(item.AwemeId, item);
            if (maxCursor > 0) _maxCursor = maxCursor;
        }
    }

    /// <summary>清空内存中的全部数据(配合存储层清空)。</summary>
    public void Clear()
    {
        lock (_sync)
        {
            _items.Clear();
            _maxCursor = 0;
            _lastBoundary = 0;
        }
    }

    /// <summary>按 aweme_id 删除单条(列表删除)。</summary>
    public void Remove(string awemeId)
    {
        lock (_sync) _items.Remove(awemeId);
    }

    public (List<AwemeItem> items, long cursor) Snapshot()
    {
        lock (_sync) return (_items.Values.ToList(), _maxCursor);
    }
}
