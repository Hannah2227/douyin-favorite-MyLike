using DouyinShuffle.Win.Capture;
using Microsoft.Web.WebView2.Core;

namespace DouyinShuffle.Win;

/// <summary>
/// 采集编排器(单一通道 + 收藏接口单一真相源):
///
/// 链路:登录检查 → sec_uid(self 探测,只管登录态) → 引擎页预热 →
///   ★采集前预检(favorite 探测,8s 内定位接口状态)
///     OK  → 两阶段翻页采集(单一直连通道):
///           ①头部增量(cursor=0,补新点赞/首次全量;单轮 200 页上限,safety 分轮续)
///           ②断点续尾部(仅当上次未跑完;从深断点继续,最多 200 轮 ≈ 72 万条)
///     不通 → 短重试 2 次 → 仍不通分流:
///       已有数据 = 限流 → 弹验证窗(轮询 favorite 恢复,恢复即自动断点续采)
///       无数据   = 网络/环境 → 报错退出
///   翻页中失败 → favorite 探测分流(同上)
///
/// 探测信号原则:要采什么就探什么 —— 一切"接口可用性"判断都用收藏接口本身
/// (favorite-probe);profile/self 只用于登录态与 sec_uid。
/// 历史教训:风控是分接口的,收藏接口被限时 self 仍正常返回(实测 548ms Ok),
/// 用 self 复核风控必然误判;同理"主动签名"二级通道依赖的全局签名函数在新版
/// 抖音已收进 webmssdk 内部,实测 10 次调用零成功,两条歧路均已删除。
/// </summary>
internal sealed class CollectOrchestrator
{
    private readonly MainWindow _host;

    private CancellationTokenSource? _collectCts;
    private bool _collecting;
    private string _lastSecUid = "";

    /// <summary>上次采集未跑完全量(失败/中断/停止)→ 下次点「采集」从断点续采而非从头增量。</summary>
    private bool _lastCollectIncomplete;

    /// <summary>认证等待续采开关:登录/验证弹窗打开时置位,认证完成后自动开始/续采。与风控状态机正交。</summary>
    private bool _pendingCollectResume;
    private int _autoRecoverCount;   // 采集波动静默恢复次数(防死循环,超过 3 次转人工/终止)
    private int _riskRecoverHandling;   // OnCollectRisk 门闩(1=进行中):与主流程 blocked 分流互斥,防双发探测/collectDone

    /// <summary>风控统一状态机:挂起/验证窗/恢复的单一状态源(取代散落的 _riskHangup 标志)。</summary>
    private readonly RiskStateMachine _riskState = new();

    public bool IsCollecting => _collecting;
    public string SecUid => _lastSecUid;
    /// <summary>风控挂起中(等用户下次点采集)。</summary>
    public bool IsRiskHeld => _riskState.IsRiskHeld;
    /// <summary>验证窗打开中。</summary>
    public bool IsVerifying => _riskState.IsVerifying;

    public CollectOrchestrator(MainWindow host) => _host = host;

    /// <summary>启动时回填持久化状态(sec_uid 缓存 + 断点续采标志)。</summary>
    public void SeedState(string secUid, bool collectIncomplete)
    {
        _lastSecUid = secUid;
        _lastCollectIncomplete = collectIncomplete;
    }

    public void ClearSecUid() => _lastSecUid = "";

    /// <summary>
    /// 开始采集(命令泵入口):两阶段 —— 先头部增量(cursor 0,补新点赞/首次全量),
    /// 再断点续尾部(仅当上次未跑完:从 MaxCursor 深断点继续采未完成的旧尾部)。
    /// </summary>
    public string Start()
    {
        if (_collecting) return "busy";
        // 验证窗口开着(等接口恢复)期间拒绝新采集:此时启动只会立刻再黑洞,反复刺激接口
        if (_host.IsVerifyWindowOpen)
        {
            AppLog.Write("COLLECT rejected: verify window open");
            return "err:验证窗口等待接口恢复中,请完成滑块或稍候;关闭验证窗后再点采集";
        }
        var collector = _host.Collector;
        var cursor = _lastCollectIncomplete && collector is { Count: > 0 } ? collector.MaxCursor : 0;
        AppLog.Write($"COLLECT start cursor={cursor} incomplete={_lastCollectIncomplete} risk={_riskState.Current}");
        _ = RunCollectAsync(cursor);
        return "started";
    }

    /// <summary>停止采集(用户点「停止」):不再自动续采。</summary>
    public void Stop()
    {
        if (_collectCts != null) { try { _collectCts.Cancel(); } catch { } }
        _pendingCollectResume = false;
    }

    /// <summary>采集因"未登录弹登录窗"被用户取消时复位:清挂起标志 + 复位 UI(进度条/采集按钮)。
    /// 否则 UI 会永久停在"采集中"、采集按钮永久灰(关掉登录窗的经典死锁)。</summary>
    public void CancelPendingResume()
    {
        if (!_pendingCollectResume) return;
        _pendingCollectResume = false;
        var count = _host.Collector?.Count ?? 0;
        _host.DispatchUi($"window.__dsh_collectDone && window.__dsh_collectDone({MainWindow.JsonText(count.ToString())},false)");
    }

    /// <summary>认证成功后自动续采(若采集被登录/验证打断)。返回 true=确实续采(调用方据此提示用户)。</summary>
    public async Task<bool> ResumeAfterAuthAsync()
    {
        if (!_pendingCollectResume) return false;
        _pendingCollectResume = false;
        // 等旧采集循环完全退出再重启(风控取消有延迟,避免双循环)
        for (var i = 0; i < 20 && _collecting; i++) await Task.Delay(250);
        if (_host.IsShuttingDown) return false;
        var resumeCursor = _host.Collector is { Count: > 0 } ? _host.Collector.MaxCursor : 0;
        _ = RunCollectAsync(resumeCursor);
        return true;
    }

    /// <summary>
    /// 采集中途疑似风控(JS 循环连续退避后仍黑洞,blocked)→ favorite 探测分流:
    /// 已恢复 = 真波动 → 静默续采;不通 → reload 重建 SDK 再探 → 仍不通 = 限流弹验证窗。
    /// 不用 profile/self 复核(风控分接口,self 正常说明不了收藏接口状态)。
    /// </summary>
    public async void OnCollectRisk()
    {
        if (!_host.Dispatcher.CheckAccess()) { _ = _host.Dispatcher.BeginInvoke(OnCollectRisk); return; }
        if (_host.Collector == null || _lastSecUid.Length == 0) return;
        // 门闩:采集中途 blocked 会同时触发 RiskDetected(→ 本流程)与主流程的 blocked 分流,
        // 两个出口并行会双发探测/reload/toast/collectDone。抢到者负责,主流程收尾见"riskHandled"分支。
        if (Interlocked.Exchange(ref _riskRecoverHandling, 1) != 0) return;
        try
        {
            var uid = _lastSecUid;
            AppLog.Write($"RISK-RECHECK fav auto={_autoRecoverCount}");
            var favOk = await DouyinProbe.CheckFavoriteApiAsync(_host.DouyinCoreInternal, uid);

            // 已恢复 = 真波动(JS 退避期间接口回来了)→ 静默续采
            if (favOk && _autoRecoverCount < 3)
            {
                _autoRecoverCount++;
                _riskState.OnRecovered();
                _host.DispatchUi("window.__dsh_toast && window.__dsh_toast(" + MainWindow.JsonText("采集波动,自动恢复中…") + ",false)");
                await ResumeAsync();
                return;
            }

            // 不通 → reload 重建 SDK 拦截器(登录/风控后旧页面持过期状态是黑洞常见原因)再探一次
            if (!favOk)
            {
                await _host.ReloadDouyinPageAsync();
                favOk = await DouyinProbe.CheckFavoriteApiAsync(_host.DouyinCoreInternal, uid);
                if (favOk && _autoRecoverCount < 3)
                {
                    _autoRecoverCount++;
                    _riskState.OnRecovered();
                    _host.DispatchUi("window.__dsh_toast && window.__dsh_toast(" + MainWindow.JsonText("已恢复页面状态,自动继续采集…") + ",false)");
                    await ResumeAsync();
                    return;
                }
            }

            // 仍不通 = 限流:挂起等待,不再立即弹窗(弹窗推迟到用户下次点「采集」的预检阶段,
            // 减少采集中途加载抖音页对接口的刺激);UI 补 collectDone 让进度条复位并刷新列表
            _autoRecoverCount = 0;
            _riskState.OnRiskConfirmed(requireManual: false);   // → RiskHeld
            Stop();
            _host.DispatchUi("window.__dsh_toast && window.__dsh_toast(" + MainWindow.JsonText("采集被风控暂停,请稍等片刻后再点「采集」,届时会自动弹出滑块验证") + ",true)");
            _host.DispatchUi($"window.__dsh_collectDone && window.__dsh_collectDone({MainWindow.JsonText((_host.Collector?.Count ?? 0).ToString())},false)");
        }
        finally { Interlocked.Exchange(ref _riskRecoverHandling, 0); }
    }
    /// <summary>等旧循环退出后从断点重启采集。</summary>
    private async Task ResumeAsync()
    {
        for (var i = 0; i < 20 && _collecting; i++) await Task.Delay(250);
        if (_host.IsShuttingDown) return;
        var resumeCursor = _host.Collector is { Count: > 0 } ? _host.Collector.MaxCursor : 0;
        _ = RunCollectAsync(resumeCursor);
    }

    // ---------- 主流程 ----------

    private async Task RunCollectAsync(long startCursor = 0)
    {
        var collector = _host.Collector;
        if (collector == null || _collecting) return;
        _collecting = true;
        _collectCts = new CancellationTokenSource();
        var ct = _collectCts.Token;
        // 退出路径统一收口:中途 return 的分支若已让 UI 进入"采集中"状态(发过 collectStatus)
        // 且没有挂起等待(登录/验证后自动续采),必须在 finally 补发 collectDone,
        // 否则 UI 进度条永久卡住、采集按钮永久灰(新用户关掉登录窗即触发的经典死锁)。
        var uiCollecting = false;
        var sentDone = false;
        void MarkUiCollecting() => uiCollecting = true;
        try
        {
            // 1. 登录检查
            if (!await _host.IsLoggedInAsync())
            {
                _host.DispatchUi("window.__dsh_toast && window.__dsh_toast(" + MainWindow.JsonText("请先登录") + ",true)");
                _pendingCollectResume = true;   // 登录成功后自动开始采集
                _host.OpenAuthWindow(DouyinAuthWindow.AuthMode.Login);
                return;
            }

            // 2. sec_uid:优先缓存,否则经 self 探测状态机(只管登录态,不管收藏接口状态)
            var uid = _lastSecUid;
            if (uid.Length == 0 || !uid.StartsWith("MS4wLjAB"))
            {
                var (health, probedUid) = await ProbeAccountAsync(ct, MarkUiCollecting);
                switch (health)
                {
                    case ApiHealth.Ok when probedUid.Length > 0:
                        uid = probedUid;
                        break;
                    case ApiHealth.Blocked:
                        _pendingCollectResume = true;
                        _host.DispatchUi("window.__dsh_toast && window.__dsh_toast(" + MainWindow.JsonText("接口受限,请在弹出的页面完成验证") + ",true)");
                        _host.OpenAuthWindow(DouyinAuthWindow.AuthMode.Verify);
                        return;
                    default:
                        AppLog.Write("PROBE not-ready give up");
                        _host.DispatchUi("window.__dsh_toast && window.__dsh_toast(" + MainWindow.JsonText("接口持续无响应(网络或临时限制),请稍后重新采集") + ",true)");
                        _host.DispatchUi($"window.__dsh_collectDone && window.__dsh_collectDone({MainWindow.JsonText(collector.Count.ToString())},false)");
                        return;
                }
                _lastSecUid = uid;
            }

            // 3. 引擎页预热
            await _host.EnsureLikePageAsync();

            // 4. ★采集前预检:favorite 探测(8s 内定位接口状态,不再黑洞 2×15s 才发现问题)
            if (!ct.IsCancellationRequested)
            {
                _host.DispatchUi("window.__dsh_collectStatus && window.__dsh_collectStatus(" + MainWindow.JsonText("正在检查接口状态…可能需要几十秒") + ")");
                MarkUiCollecting();
                var favOk = await DouyinProbe.CheckFavoriteApiAsync(_host.DouyinCoreInternal, uid);
                if (!favOk && !ct.IsCancellationRequested)
                {
                    // 短重试一次(2s,滤掉瞬时抖动);仍不通则分流
                    await Task.Delay(2000, ct);
                    favOk = await DouyinProbe.CheckFavoriteApiAsync(_host.DouyinCoreInternal, uid);
                }
                if (!favOk && !ct.IsCancellationRequested)
                {
                    // 用户主动点「采集」→ 允许弹滑块验证窗(风控挂起状态也在这一环恢复验证)
                    await HandleInterfaceDownAsync(uid, collector.Count, ct, allowPopup: true);
                    if (!ct.IsCancellationRequested)
                        return;   // 已分流(弹验证窗或报错),本轮结束
                }
            }
            if (ct.IsCancellationRequested) return;
            _riskState.OnRecovered();   // 预检通过(接口恢复)→ 解除风控挂起/验证状态

            // 5. 翻页采集:两阶段。★先头部增量、再断点续尾部(issue #3:采完后新点赞的视频采不进来)。
            //    根因:上次未完成时 Start() 只从 MaxCursor 深处断点续采 —— 喜欢列表按时间倒序
            //    翻页(游标越翻越小),新点赞全在列表顶部,深断点之后的翻页永远碰不到它们;
            //    等旧尾部全部采完(可能几万条)才轮到头部,用户感知就是"点了采集、新点赞永远不进来"。
            //    阶段 A(头部增量,cursor=0):新增点赞都在顶部,增量碰到"整页已采"即秒停,
            //      没有新增时开销极小;首次使用(无数据)也由本阶段完成全量(safety 分轮续)。
            //      ★trackCursor = 仅全量模式写断点(见下方阶段 A 注释);增量边界永不写断点。
            //    阶段 B(断点续旧尾部):仅当上次未跑完(_lastCollectIncomplete)且确有断点。
            var knownIds = collector.Items.Select(i => i.AwemeId).ToList();
            var reason = "";
            var lastRoundStored = collector.Count;   // 上轮结束时的入库数(防呆参照)
            var deepCursor = startCursor;            // 深断点,阶段 B 起点
            collector.Round = 1;
            // —— 阶段 A:头部增量(总是先跑;hardResume=false 保持增量可停)——
            //    ★trackCursor = 仅全量模式(无既有数据)写断点。不能用 deepCursor==0 判定:
            //    正常采完后的普通增量 deepCursor 也是 0,若把增量边界写进断点,一旦增量中途
            //    stalled(incomplete=true),下次就会从"已采区内的浅边界"硬续 —— 硬续禁用
            //    knownIds 表 → 整个已采区反复空翻 → 零新增防呆停止 → 断点依旧 → 死循环。
            //    只有首次全量(knownIds<50,采集器同款判定)的中断进度才是合法深断点。
            var headTrack = knownIds.Count < 50;
            reason = await collector.StartDirectAsync(uid, 0, knownIds, ct, trackCursor: headTrack);
            AppLog.Write($"COLLECT head {reason}");
            try { _host.SaveNow(true); } catch { }
            var rk = reason.Split(':')[0];
            var round = 0;
            // safety = 头部 200 页没翻完(新增极多/首次全量)→ 从最近边界游标分轮续(单轮≈3600 条)
            var fullMode = knownIds.Count < 50;   // 全量模式(与采集器增量启用判定一致)
            while (rk == "safety" && !ct.IsCancellationRequested && round < 200)
            {
                // 防呆:连续整轮零新增(接口异常翻页)→ 停止空转。
                // ★仅全量模式启用:增量轮"零新增"是常态(补完新增即停,safety 不会走到续轮);
                //   全量续轮翻过的页大多已知,去重后单轮新增为 0 可能是正常现象(尤其中断重启后),
                //   连续两轮零新增才判定异常。
                if (fullMode && round > 0 && collector.Count == lastRoundStored)
                {
                    AppLog.Write("COLLECT zero-progress round, stop");
                    reason = "stalled:0";
                    break;
                }
                lastRoundStored = collector.Count;
                round++;
                collector.Round = round + 1;
                reason = await collector.StartDirectAsync(uid, collector.LastBoundaryCursor, knownIds, ct, trackCursor: headTrack);
                AppLog.Write($"COLLECT head#{round} {reason}");
                try { _host.SaveNow(true); } catch { }
                rk = reason.Split(':')[0];
            }
            // —— 阶段 B:断点续采旧尾部(仅当上次未跑完且确有断点)——
            //    ★阶段 A 门槛:头部已明确失败(stalled/blocked/notready)时不进阶段 B ——
            //    接口正在挣扎,硬续只会白耗请求,阶段 A 的失败原因直接走下方分流/收口;
            //    下次点采集阶段 A 秒级试探,接口恢复后自然进入阶段 B 补尾部。
            //    轮数上限 200 轮 ≈ 72 万条覆盖几十万量级;极端超出的账号按文档口径停在轮次上限
            //    (数据/断点已逐轮落盘)。★此处刻意不加"零新增防呆":硬续轮翻过已采区
            //    (去重后零新增)但游标在前进,正是把断点走到列表尽头(has_more=false →
            //    complete → 清除断点标志)的自愈路径,拦掉会让标志永远清不掉、每次采集重翻;
            //    游标真卡死由 JS 层 stallCount(3 次同首条/游标不进 → stalled)收口。
            if (rk is "complete" or "incremental" or "safety"
                && _lastCollectIncomplete && deepCursor > 0 && !ct.IsCancellationRequested)
            {
                var tailCursor = deepCursor;
                for (var r = 0; r < 200 && !ct.IsCancellationRequested; r++)
                {
                    collector.Round = r + 2;   // 第 1 轮 = 头部,尾部从第 2 轮起(进度文案)
                    reason = await collector.StartDirectAsync(uid, tailCursor, knownIds, ct, trackCursor: true, hardResume: true);
                    AppLog.Write($"COLLECT tail#{r} {reason}");
                    try { _host.SaveNow(true); } catch { }
                    var rk2 = reason.Split(':')[0];
                    if (rk2 != "safety" || ct.IsCancellationRequested) break;
                    // ★此处刻意不加"零新增防呆":硬续轮翻过已采区(去重后零新增)但游标在前进,
                    //   正是把断点走到列表尽头(has_more=false → complete → 清除断点标志)的
                    //   自愈路径,拦掉会让标志永远清不掉、每次采集重翻;游标真卡死由 JS 层
                    //   stallCount(3 次同首条/游标不进 → stalled)收口,200 轮上限兜底。
                    lastRoundStored = collector.Count;
                    tailCursor = collector.MaxCursor;
                }
            }
            var reasonKey = reason.Split(':')[0];

            // 6. 翻页中失败(0 页黑洞/blocked)→ favorite 探测分流:波动自愈已由 JS 退避处理,
            //    到这里还不通就是限流;采集中途挂起不弹窗(下次点采集预检再弹),无数据普通报错
            if (reasonKey is "notready" or "blocked" && !ct.IsCancellationRequested)
            {
                var fetchedPages = 0;
                var colon = reason.IndexOf(':');
                if (colon > 0) int.TryParse(reason[(colon + 1)..], out fetchedPages);
                if (fetchedPages == 0)
                {
                    await HandleInterfaceDownAsync(uid, collector.Count, ct, allowPopup: false);
                    return;
                }
                // 中途失败(>0 页):数据已落库,断点续采标志由下方统一处理
            }

            // 7. 收尾:结束原因 → UI 反馈。
            //    真正的"采完"只有:complete(接口 has_more=false/游标不再前进,明说没有更多)、
            //    incremental(增量碰到已采边界)。
            //    ★stalled(游标连续停滞 = 疑似限流卡页)不是采完 —— 曾把它归入 ok,导致:
            //    断点标志不置位 → 下次只能增量从头翻,而增量穿不过"整页已采"的断层,
            //    表现为"卡在几千条、再点采集永远无新增"(须清空全量重采才能越过)。
            //    现归入"未完成":下次点采集从 MaxCursor 断点硬续,越过已采区继续往下。
            //    ★safety(轮次/页数上限用尽)同样不是采完:走到收尾时 reason 仍是 safety,
            //    说明上限耗尽时接口还在给新页(更旧的尾部没采到)—— 若当完成,断点标志被清,
            //    上限之外的内容从此够不到(增量只能翻到已采边界即停)。归入未完成 + 诚实提示。
            var ok = reasonKey is "complete" or "incremental";
            _lastCollectIncomplete = !ok;   // 未跑完(失败/停止)→ 下次点采集从断点续采
            if (ok) _autoRecoverCount = 0;   // 采集正常完成,重置自愈计数
            _host.SaveNow(_lastCollectIncomplete);
            await _host.PushStateAsync();
            // 不自动刷新列表(避免采集频繁结束触发全量重绘卡顿):由用户点左侧「刷新列表」手动刷新,
            // collectDone 只负责进度条复位与结果提示
            if (reasonKey == "busy")
                _host.DispatchUi("window.__dsh_toast && window.__dsh_toast(" + MainWindow.JsonText("已有采集在进行") + ",true)");
            else if (reasonKey == "stalled")
            {
                // 专用提示:别让用户误以为"采完了"(历史事故的教训就是 UI 把 stalled 显示成完成)。
                // 顺序:先 collectDone 复位进度条/按钮(其内部 toast"采集已停止"会被后一条覆盖),
                // 再发专用提示 → 最终可见的是"可从断点续采"文案。
                sentDone = true;
                _host.DispatchUi($"window.__dsh_collectDone && window.__dsh_collectDone({MainWindow.JsonText(collector.Count.ToString())},false)");
                _host.DispatchUi("window.__dsh_toast && window.__dsh_toast(" + MainWindow.JsonText("接口疑似波动(游标停滞),进度已保存;可稍后再点「采集」,将从断点自动续采") + ",true)");
            }
            else if (reasonKey == "safety")
            {
                // 轮次上限用尽时接口仍在给新页 = 更旧的尾部没采到 → 诚实告知"未采完",
                // 断点已保留,下次点采集自动从断点继续(不再冒充"采集完成"误导用户)。
                sentDone = true;
                _host.DispatchUi($"window.__dsh_collectDone && window.__dsh_collectDone({MainWindow.JsonText(collector.Count.ToString())},false)");
                _host.DispatchUi("window.__dsh_toast && window.__dsh_toast(" + MainWindow.JsonText("已达单次采集上限,更早的内容还没采完;进度已保存,稍后再点「采集」将继续补齐") + ",true)");
            }
            else if (reasonKey is "blocked" or "notready"
                     && Interlocked.CompareExchange(ref _riskRecoverHandling, 0, 0) == 1)
            {
                // 该失败已由 OnCollectRisk(异步探测分流)接管并完成 UI 收尾,这里只标记已收尾,
                // 防 finally 补发或重复 collectDone/toast(同一 blocked 事件的两个出口)。
                sentDone = true;
            }
            else
            {
                sentDone = true;
                _host.DispatchUi($"window.__dsh_collectDone && window.__dsh_collectDone({MainWindow.JsonText(collector.Count.ToString())},{(ok ? "true" : "false")})");
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            AppLog.Write("COLLECT ERR " + ex);
            try
            {
                _lastCollectIncomplete = true;   // 异常中断 → 下次断点续采(保住已采数据)
                _host.SaveNow(true);
            }
            catch { }
            sentDone = true;
            _host.DispatchUi($"window.__dsh_collectDone && window.__dsh_collectDone({MainWindow.JsonText((_host.Collector?.Count ?? 0).ToString())},false)");
        }
        finally
        {
            _collecting = false;
            _collectCts = null;
            // 统一收口:UI 还在"采集中"且本轮没发过 collectDone、也没挂起等待自动续采 → 补发。
            // 覆盖:未登录弹窗后 return、探测 Blocked return、取消停止、HandleInterfaceDown 的弹验证窗
            // 分支(它故意不发 collectDone 保持进度条显示,但有 _pendingCollectResume 挂起)等所有路径。
            if (uiCollecting && !sentDone && !_pendingCollectResume && !_host.IsShuttingDown
                && Interlocked.CompareExchange(ref _riskRecoverHandling, 0, 0) == 0)   // 风控恢复流程接管中则不再补发
            {
                AppLog.Write("COLLECT done via finally-fallback");
                _host.DispatchUi($"window.__dsh_collectDone && window.__dsh_collectDone({MainWindow.JsonText((_host.Collector?.Count ?? 0).ToString())},false)");
            }
        }
    }

    /// <summary>验证窗被用户关闭(未完成滑块):状态机回挂起,等下次点「采集」再弹。UI 已由 verifyLock(false) 复位。</summary>
    public void NotifyVerifyAbandoned() => _riskState.OnVerifyAbandoned();

    /// <summary>
    /// 收藏接口不可用时的统一分流:
    /// 已有数据 = 限流(网络抖动已被调用方的重试排除)。
    ///   allowPopup=true(用户主动点「采集」的预检阶段)→ reload 再确认,仍不通则弹验证窗,
    ///     以收藏接口恢复为完成信号,通过后自动断点续采;
    ///   allowPopup=false(采集中途/风控波动)→ 挂起不弹窗:停止采集并提示稍后再点,
    ///     下次预检时再弹(弹窗加载抖音页本身会刺激接口,采集中途应避免)。
    /// 无数据 = 网络/环境问题 → 报错退出(弹验证窗无意义,页面里没有滑块可滑)。
    /// </summary>
    private async Task HandleInterfaceDownAsync(string uid, int collectedCount, CancellationToken ct, bool allowPopup)
    {
        AppLog.Write($"COLLECT interface down (stored={collectedCount} allowPopup={allowPopup})");
        if (collectedCount > 0)
        {
            // 限流:先 reload 重建 SDK(旧页面拦截器持过期状态也会黑洞),再确认一次
            await _host.ReloadDouyinPageAsync();
            if (ct.IsCancellationRequested) return;
            var favOk = await DouyinProbe.CheckFavoriteApiAsync(_host.DouyinCoreInternal, uid);
            if (favOk)
            {
                AppLog.Write("COLLECT recovered after reload");
                _riskState.OnRecovered();   // 接口已恢复,解除挂起/验证状态
                _host.DispatchUi("window.__dsh_toast && window.__dsh_toast(" + MainWindow.JsonText("已恢复页面状态,自动继续采集…") + ",false)");
                await ResumeAsync();
                return;
            }
            if (allowPopup)
            {
                // 用户主动点「采集」后的预检:弹验证窗(轮询 favorite 恢复;传 sec_uid 作为完成信号)
                _riskState.OnRiskConfirmed(requireManual: true);   // RiskHeld→Verifying(或保持 Normal→Verifying)
                _pendingCollectResume = true;   // 验证通过后自动从断点续采
                _autoRecoverCount = 0;
                _host.DispatchUi("window.__dsh_collectStatus && window.__dsh_collectStatus(" + MainWindow.JsonText("接口被限,请在验证窗口完成滑块,或等其自动恢复") + ")");
                _host.DispatchUi("window.__dsh_toast && window.__dsh_toast(" + MainWindow.JsonText("接口被限,请在弹出的页面完成滑块验证") + ",true)");
                _host.OpenAuthWindow(DouyinAuthWindow.AuthMode.Verify, uid);
            }
            else
            {
                // 采集中途:挂起,不弹窗;提示稍后再点采集(下次预检阶段再弹滑块)
                _riskState.OnRiskConfirmed(requireManual: false);   // → RiskHeld
                _host.DispatchUi("window.__dsh_toast && window.__dsh_toast(" + MainWindow.JsonText("采集被风控暂停,请稍等片刻后再点「采集」,届时会自动弹出滑块验证") + ",true)");
                _host.DispatchUi($"window.__dsh_collectDone && window.__dsh_collectDone({MainWindow.JsonText(collectedCount.ToString())},false)");
            }
        }
        else
        {
            // 无数据:网络不通或环境未就绪,普通报错
            _lastCollectIncomplete = true;
            _host.SaveNow(true);
            _host.DispatchUi("window.__dsh_toast && window.__dsh_toast(" + MainWindow.JsonText("接口持续无响应(网络或临时限制),请稍后重新采集") + ",true)");
            _host.DispatchUi($"window.__dsh_collectDone && window.__dsh_collectDone({MainWindow.JsonText(collectedCount.ToString())},false)");
        }
    }

    /// <summary>
    /// 账号探测状态机(采集前,只管登录态/sec_uid):
    /// 第一轮原地退避重试(瞬时波动);第二轮重载隐藏页重建 securitySDK 再试。
    /// </summary>
    private async Task<(ApiHealth health, string uid)> ProbeAccountAsync(CancellationToken ct, Action? markUiCollecting = null)
    {
        _host.DispatchUi("window.__dsh_collectStatus && window.__dsh_collectStatus(" + MainWindow.JsonText("正在获取账号信息…") + ")");
        markUiCollecting?.Invoke();

        // 第一轮:原地退避重试(2s/2s)
        for (var i = 0; i < 3 && !ct.IsCancellationRequested; i++)
        {
            var (h, u) = await DouyinProbe.CheckHealthAsync(_host.DouyinCoreInternal);
            AppLog.Write($"PROBE r1#{i + 1} {h}");
            if (h != ApiHealth.NotReady) return (h, u);
            if (i < 2) await Task.Delay(2000, ct);
        }

        // 第二轮:重载隐藏页(重建 SDK 拦截器状态),等 2 秒初始化后重试
        _host.DispatchUi("window.__dsh_collectStatus && window.__dsh_collectStatus(" + MainWindow.JsonText("正在刷新页面状态…") + ")");
        await _host.ReloadDouyinPageAsync();
        for (var i = 0; i < 4 && !ct.IsCancellationRequested; i++)
        {
            var (h, u) = await DouyinProbe.CheckHealthAsync(_host.DouyinCoreInternal);
            AppLog.Write($"PROBE r2#{i + 1} {h}");
            if (h != ApiHealth.NotReady) return (h, u);
            await Task.Delay(2000, ct);
        }

        return (ApiHealth.NotReady, "");
    }
}
