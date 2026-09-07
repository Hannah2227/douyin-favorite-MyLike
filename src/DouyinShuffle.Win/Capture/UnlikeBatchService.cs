using DouyinShuffle.Win.Storage;

namespace DouyinShuffle.Win.Capture;

/// <summary>
/// 批量取消点赞请求(UI → 命令泵)。Scope:
///   all    = 当前列表内全部有效条目;
///   time   = 按发布时间范围(CreateTime ∈ [StartTime, EndTime],EndTime=0 表示无上限);
///   author = 按作者昵称精确匹配;
///   ids    = 显式传入的 aweme_id 列表(选择性取消)。
/// </summary>
public sealed class UnlikeBatchRequest
{
    public string Scope { get; set; } = "all";
    public string[] Ids { get; set; } = Array.Empty<string>();
    public long StartTime { get; set; }
    public long EndTime { get; set; }
    public string[] Authors { get; set; } = Array.Empty<string>();
}

/// <summary>
/// 批量取消抖音点赞 — 批量调度器(承接原 MainWindow.UnlikeRunAsync 的编排职责):
/// - 解析筛选条件(全部/时间范围/作者/显式 ids)→ 目标 aweme_id 集合;
/// - 复用 UnlikeService.UnlikeOneAsync 逐条执行,保留自适应节奏 + 风控分流;
/// - 逐条结果(成功/业务拒绝/无响应)落盘 unlike_log.json,支持失败重试与崩溃断点续跑。
///
/// 宿主动作(移除条目/落盘/探测/reload/弹验证窗)经构造注入的委托回调,
/// 本类不直接依赖 MainWindow/LikeCollector/LikeListStore,保持单向解耦。
///
/// 风控分流(与历史实现一致):连续 3 条 NoResponse → 探测 favorite 只读接口,
///   仍通(或无法探测)→ 页面 SDK 状态问题 → reload 后慢速自愈(限 1 次);
///   也不通 → 账号级验证 → 停止并弹验证窗,失败项保留在本地供重试。
/// 业务明确拒绝(有状态码)跳过继续;连续同因拒绝 ≥3 视为疑似限流,退避但不中断。
/// </summary>
public sealed class UnlikeBatchService
{
    private readonly UnlikeService _unlike;
    private readonly UnlikeLogStore _log;
    private readonly Func<IReadOnlyCollection<AwemeItem>> _itemProvider;
    private readonly Action<string> _onSuccess;
    private readonly Action<string> _onToast;
    private readonly Action<int, int, string> _onProgress;
    private readonly Action<string> _onEnd;
    private readonly Func<string> _secUidProvider;
    private readonly Func<Task> _reloadAsync;
    private readonly Action _openVerifyWindow;
    private readonly Func<Task<bool>> _favoriteOkAsync;
    private readonly Func<bool> _isVerifyWindowOpen;

    private CancellationTokenSource? _cts;
    private volatile bool _running;

    /// <summary>是否正在运行(宿主据此做与采集/播放的互斥)。</summary>
    public bool IsRunning => _running;

    public UnlikeBatchService(
        UnlikeService unlike,
        UnlikeLogStore log,
        Func<IReadOnlyCollection<AwemeItem>> itemProvider,
        Action<string> onSuccess,
        Action<string> onToast,
        Action<int, int, string> onProgress,
        Action<string> onEnd,
        Func<string> secUidProvider,
        Func<Task> reloadAsync,
        Action openVerifyWindow,
        Func<Task<bool>> favoriteOkAsync,
        Func<bool> isVerifyWindowOpen)
    {
        _unlike = unlike;
        _log = log;
        _itemProvider = itemProvider;
        _onSuccess = onSuccess;
        _onToast = onToast;
        _onProgress = onProgress;
        _onEnd = onEnd;
        _secUidProvider = secUidProvider;
        _reloadAsync = reloadAsync;
        _openVerifyWindow = openVerifyWindow;
        _favoriteOkAsync = favoriteOkAsync;
        _isVerifyWindowOpen = isVerifyWindowOpen;
    }

    /// <summary>把筛选条件解析为目标 aweme_id 列表(排除失效,按发布时间倒序)。</summary>
    public List<string> ResolveTargets(UnlikeBatchRequest req)
    {
        var items = _itemProvider();
        IEnumerable<AwemeItem> q;
        switch (req.Scope)
        {
            case "time":
                q = items.Where(i => i.Status != 1
                    && i.CreateTime >= req.StartTime
                    && (req.EndTime <= 0 || i.CreateTime <= req.EndTime));
                break;
            case "author":
                var authors = new HashSet<string>(req.Authors ?? Array.Empty<string>());
                q = items.Where(i => i.Status != 1 && authors.Contains(i.AuthorName));
                break;
            case "ids":
                var idSet = new HashSet<string>(req.Ids ?? Array.Empty<string>());
                q = items.Where(i => idSet.Contains(i.AwemeId));
                break;
            default: // all
                q = items.Where(i => i.Status != 1);
                break;
        }
        return q.OrderByDescending(i => i.CreateTime).Select(i => i.AwemeId).ToList();
    }

    /// <summary>上次失败项(状态非 success 且仍在当前列表)的 id,供手动重试。</summary>
    public List<string> FailedIds()
    {
        var alive = new HashSet<string>(_itemProvider().Select(i => i.AwemeId));
        return _log.Load().Entries
            .Where(e => e.Status != "success")
            .Select(e => e.AwemeId)
            .Distinct()
            .Where(alive.Contains)
            .ToList();
    }

    /// <summary>启动批量取消(传入已解析的目标 id)。立即返回,进度经 onProgress/onEnd 回推。</summary>
    public void Start(IReadOnlyList<string> ids)
    {
        if (_running || ids.Count == 0) return;
        _cts = new CancellationTokenSource();
        _running = true;
        _ = RunAsync(ids, _cts.Token);
    }

    /// <summary>停止当前批次(用户点「停止」)。</summary>
    public void Stop() => _cts?.Cancel();

    // ---------- 主循环(移植自原 MainWindow.UnlikeRunAsync,逻辑保持一致) ----------

    private async Task RunAsync(IReadOnlyList<string> ids, CancellationToken ct)
    {
        var rnd = Random.Shared;
        var ok = 0;
        var skip = 0;
        var risk = 0;                 // 连续 NoResponse
        var sameReject = 0;           // 连续同文案业务拒绝
        string? lastReject = null;
        var selfHealLeft = 1;         // 风控现场 reload 自愈次数上限(防 reload 循环)
        var stopReason = "";

        // 元数据一次快照(循环里只按 id 查,避免每轮全量复制列表)
        var meta = new Dictionary<string, AwemeItem>();
        foreach (var it in _itemProvider())
            meta.TryAdd(it.AwemeId, it);

        // 初始化日志:active + pending 快照(崩溃后断点续跑依据)
        var log = _log.Load();
        log.Active = true;
        log.PendingIds = ids.ToList();
        _log.Save(log);

        try
        {
            for (var i = 0; i < ids.Count; i++)
            {
                if (ct.IsCancellationRequested) { stopReason = "已手动停止"; break; }
                var id = ids[i];
                _onProgress(i + 1, ids.Count, $"正在取消 {i + 1}/{ids.Count}…已成功 {ok} 条");
                meta.TryGetValue(id, out var item);

                var r = await _unlike.UnlikeOneAsync(id, ct);
                if (r.Success)
                {
                    ok++;
                    risk = 0;
                    sameReject = 0;
                    lastReject = null;
                    AppendEntry(log, id, item, "success", "ok");
                    _onSuccess(id);   // 移除条目 + 落盘 items.dylist
                }
                else if (r.FailKind == UnlikeFailKind.NoResponse)
                {
                    risk++;
                    AppendEntry(log, id, item, "noresponse", r.Message);
                    if (risk >= 3)
                    {
                        // 现场分流:探测 favorite 只读接口,区分"页面问题(reload 可愈)"与"账号级验证(弹窗)"
                        var favOk = false;
                        var uid = _secUidProvider();
                        try { if (uid.Length > 0) favOk = await _favoriteOkAsync(); } catch { }
                        if (selfHealLeft > 0 && (favOk || uid.Length == 0))
                        {
                            selfHealLeft--;
                            risk = 0;
                            _onToast("连续取消失败,正在刷新页面状态后慢速重试…");
                            await _reloadAsync();
                            try { await Task.Delay(4000, ct); }
                            catch (OperationCanceledException) { stopReason = "已手动停止"; break; }
                            // 该条未成功 → 保留在 pending,跳过下方 Remove
                            continue;
                        }
                        stopReason = $"连续 {risk} 条无响应且接口探测失败(疑似触发验证),已自动停止";
                        break;
                    }
                }
                else   // 业务明确拒绝(下架/重复取消等)→ 跳过继续;连续同因≥3 视为疑似限流退避
                {
                    skip++;
                    AppendEntry(log, id, item, "rejected", r.Message);
                    var same = lastReject != null && r.Message == lastReject;
                    lastReject = r.Message;
                    sameReject = same ? sameReject + 1 : 1;
                }

                // 当前 id 已处理(无论成败)→ 移出 pending,落盘日志
                log.PendingIds.Remove(id);
                _log.Save(log);

                // 自适应节奏:无迹象快,有迹象立即收敛
                var d = risk > 0
                    ? 4000 + rnd.Next(0, 2000)
                    : sameReject >= 3 ? 3000 + rnd.Next(0, 1000)
                    : 1500 + rnd.Next(0, 1000);
                if ((i + 1) % 20 == 0) d += 5000;   // 每 20 条长休散热
                try { await Task.Delay(d, ct); }
                catch (OperationCanceledException) { stopReason = "已手动停止"; break; }
            }
        }
        catch (Exception ex)
        {
            AppLog.Write("UNLIKE BATCH ERR " + ex);
            stopReason = "执行出错";
        }
        finally
        {
            _running = false;
            _cts = null;
            log.Active = false;
            _log.Save(log);
            if (stopReason.Contains("验证") && !_isVerifyWindowOpen())
            {
                // 引导用户过滑块:验证通过后引擎页自动 reload;失败项本地未删,可点「重试失败项」续跑
                _openVerifyWindow();
            }
            var summary = stopReason.Length > 0
                ? $"{stopReason}。已取消 {ok} 条,失败 {skip} 条。"
                : $"已全部处理:取消 {ok} 条,失败 {skip} 条。";
            _onEnd(summary);
        }
    }

    private void AppendEntry(UnlikeLog log, string id, AwemeItem? item, string status, string message)
    {
        log.Entries.Add(new UnlikeLogEntry
        {
            AwemeId = id,
            Desc = item?.Desc ?? "",
            AuthorName = item?.AuthorName ?? "",
            CreateTime = item?.CreateTime ?? 0,
            Status = status,
            Message = message,
            ProcessedAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
        });
    }
}
