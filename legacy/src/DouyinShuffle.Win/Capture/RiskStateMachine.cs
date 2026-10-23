namespace DouyinShuffle.Win.Capture;

/// <summary>
/// 风控统一状态机(第三步重构):把散落在采集编排/播放/验证窗里的挂起、弹窗、恢复标志
/// (_riskHangup / _pendingCollectResume 等)收敛为单一状态,各场景只做两件事:
///   失败确认后 → OnRiskConfirmed(是否允许弹窗)
///   接口恢复时 → OnRecovered()
/// 状态流转:Normal ↔ RiskHeld(挂起,不刺激接口) ↔ Verifying(验证窗打开)
/// 说明:自动 reload 重建 SDK 属于宿主动作(由各入口代码执行),状态机不建模动作只建模状态。
/// </summary>
internal sealed class RiskStateMachine
{
    public enum State
    {
        /// <summary>接口正常。</summary>
        Normal,
        /// <summary>风控挂起:采集已停止,等用户下次主动操作;期间不刺激接口。</summary>
        RiskHeld,
        /// <summary>验证窗打开(用户主动操作后的预检阶段),等待滑块完成。</summary>
        Verifying
    }

    private readonly object _sync = new();
    private State _state = State.Normal;

    /// <summary>接口恢复广播(验证通过/自愈成功/冷却解除)。采集续采、播放重试统一订阅。</summary>
    public event Action? InterfaceRecovered;

    public State Current { get { lock (_sync) return _state; } }
    public bool IsVerifying => Current == State.Verifying;
    public bool IsRiskHeld => Current == State.RiskHeld;

    /// <summary>
    /// 失败确认后上报(宿主已尝试过自动恢复如 reload,仍失败)。
    /// requireManual=true(用户主动点「采集」的预检)→ 进入 Verifying 并返回 true,宿主弹验证窗;
    /// false(采集中途)→ 进入 RiskHeld 并返回 false,宿主挂起提示,不弹窗。
    /// </summary>
    public bool OnRiskConfirmed(bool requireManual)
    {
        lock (_sync)
        {
            if (_state == State.Verifying) return true;   // 已在验证中,保持弹窗
            if (requireManual && _state == State.RiskHeld) { _state = State.Verifying; return true; }
            _state = requireManual ? State.Verifying : State.RiskHeld;
            return requireManual;
        }
    }

    /// <summary>接口恢复(探测 ok / reload 成功 / 验证通过)→ Normal,并广播恢复。</summary>
    public void OnRecovered()
    {
        lock (_sync)
        {
            var prev = _state;
            _state = State.Normal;
            if (prev != State.Normal) InterfaceRecovered?.Invoke();
        }
    }

    /// <summary>验证窗被用户关闭(未完成滑块)→ 回到挂起,等下次主动操作。</summary>
    public void OnVerifyAbandoned()
    {
        lock (_sync)
        {
            if (_state == State.Verifying) _state = State.RiskHeld;
        }
    }
}
