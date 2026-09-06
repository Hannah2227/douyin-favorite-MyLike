using Microsoft.Web.WebView2.Core;
using Newtonsoft.Json.Linq;

namespace DouyinShuffle.Win.Capture;

/// <summary>
/// 批量取消抖音点赞 — 单条执行服务(源自 PR #1 pppoit 贡献,经重构)。
/// 职责收敛为:在抖音引擎页上下文执行"单条取消点赞"并返回结构化结果;
/// 批量编排(节流/风控自停/停止/进度/本地删除)由宿主 MainWindow 负责
/// (那里才有 LikeCollector / LikeListStore / 验证窗口等依赖)。
/// 复用现有登录态 WebView2,页面 securitySDK 自动补签名;不修改原采集与删除逻辑。
/// </summary>
public sealed class UnlikeService
{
    private readonly CoreWebView2 _webView;

    public UnlikeService(CoreWebView2 webView)
    {
        _webView = webView;
    }

    /// <summary>
    /// 单条取消点赞:页面内裸 fetch POST digg 接口,结果结构化解码后返回。
    /// 判定口径:HTTP 2xx 且 status_code==0 才算成功;
    /// 解析不出业务状态码(空返回/非 JSON/HTML 验证页/浏览器异常/超时)归 NoResponse(疑似风控/黑洞);
    /// 能读出状态码但非 0 归 ApiRejected(明确拒绝,如内容已下架或重复取消)。
    /// </summary>
    public async Task<UnlikeOneResult> UnlikeOneAsync(string awemeId, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(awemeId))
            return new UnlikeOneResult(false, UnlikeFailKind.ApiRejected, 0, null, "无效视频 ID");

        // WebView2 的 ExecuteScriptAsync 不会等待 Promise,
        // 由页面通过 WebMessageReceived 把 fetch 结果回传(唯一 requestId 匹配,防串台)。
        var requestId = Guid.NewGuid().ToString("N");
        var tcs = new TaskCompletionSource<JObject>(TaskCreationOptions.RunContinuationsAsynchronously);

        void Handler(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                var jo = JObject.Parse(e.WebMessageAsJson);
                if (jo["type"]?.Value<string>() == "dsh_unlike_resp" &&
                    jo["id"]?.Value<string>() == requestId)
                {
                    tcs.TrySetResult(jo);
                }
            }
            catch { }
        }

        _webView.WebMessageReceived += Handler;
        try
        {
            var escapedId = Newtonsoft.Json.JsonConvert.ToString(awemeId);
            var escapedRequestId = Newtonsoft.Json.JsonConvert.ToString(requestId);

            var js = $$"""
            (function () {
              const id = {{escapedRequestId}};
              const awemeId = {{escapedId}};
              function post(obj) {
                try {
                  obj.type = 'dsh_unlike_resp';
                  obj.id = id;
                  window.chrome.webview.postMessage(obj);
                } catch (e) {}
              }
              (async function () {
                try {
                  const body = new URLSearchParams();
                  body.set('aweme_id', awemeId);
                  body.set('item_type', '0');
                  body.set('type', '0');

                  const resp = await fetch('/aweme/v1/web/commit/item/digg/?aid=6383', {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                      'accept': 'application/json, text/plain, */*',
                      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8'
                    },
                    body: body.toString()
                  });

                  const text = await resp.text();
                  let data = null;
                  try { data = JSON.parse(text); } catch (_) {}

                  post({
                    ok: resp.ok,
                    http: resp.status,
                    jsonOk: !!data,
                    status_code: data && data.status_code,
                    status_msg: data && (data.status_msg || data.msg),
                    raw: text.slice(0, 400)
                  });
                } catch (e) {
                  post({ error: String(e) });
                }
              })();
            })();
            """;

            await _webView.ExecuteScriptAsync(js);

            // 竞态修正:取消(token)与超时(10s)共享同一 Task.Delay —— 若响应与取消同时到,
            // 原实现一律判"超时",会把一次实际成功的取消误报为 NoResponse(宿主按疑似风控停批)。
            // 正确顺序:先看是否已取消 → 已取消才算"已中止";delay 先完成才是真超时;
            // tcs 已就绪则无条件采用真实结果(成功与否由下方业务判定)。
            var delay = Task.Delay(TimeSpan.FromSeconds(10), cancellationToken);
            var completed = await Task.WhenAny(tcs.Task, delay);
            if (completed == tcs.Task)
            {
                // 结果已回(哪怕此刻取消信号同时到):以真实结果为准
            }
            else if (cancellationToken.IsCancellationRequested)
                return new UnlikeOneResult(false, UnlikeFailKind.NoResponse, 0, null, "已中止");
            else
                return new UnlikeOneResult(false, UnlikeFailKind.NoResponse, 0, null, "接口请求超时(10 秒)");

            var result = await tcs.Task;
            var error = result.Value<string>("error");
            if (!string.IsNullOrWhiteSpace(error))
                return new UnlikeOneResult(false, UnlikeFailKind.NoResponse, 0, null, "浏览器请求失败: " + error);

            var http = result.Value<int?>("http") ?? 0;
            var statusCode = result.Value<int?>("status_code");
            var statusMsg = result.Value<string>("status_msg");
            var raw = result.Value<string>("raw") ?? "";
            var jsonOk = result.Value<bool?>("jsonOk") == true;

            // 必须同时满足 HTTP 2xx + status_code=0 才算成功。
            if (http >= 200 && http < 300 && statusCode == 0)
                return new UnlikeOneResult(true, UnlikeFailKind.None, http, 0, "ok");

            // 读不出业务状态码(空/非 JSON/验证页/网络异常)→ 无响应类,批量层按"疑似风控/黑洞"处理
            if (!jsonOk || !statusCode.HasValue)
                return new UnlikeOneResult(false, UnlikeFailKind.NoResponse, http, statusCode, "无业务响应(疑似验证/黑洞)");

            var detail = !string.IsNullOrWhiteSpace(statusMsg) ? statusMsg : raw;
            if (detail.Length > 120) detail = detail[..120];
            return new UnlikeOneResult(false, UnlikeFailKind.ApiRejected, http, statusCode,
                string.IsNullOrWhiteSpace(detail) ? "接口拒绝" : $"接口拒绝: {detail}");
        }
        catch (OperationCanceledException)
        {
            return new UnlikeOneResult(false, UnlikeFailKind.NoResponse, 0, null, "已中止");
        }
        catch (Exception ex)
        {
            return new UnlikeOneResult(false, UnlikeFailKind.NoResponse, 0, null, "请求异常: " + ex.Message);
        }
        finally
        {
            _webView.WebMessageReceived -= Handler;
        }
    }
}

/// <summary>单条失败分类:None=成功;ApiRejected=接口明确拒绝(可跳过继续);NoResponse=疑似风控/黑洞(需停)。</summary>
public enum UnlikeFailKind
{
    None,
    ApiRejected,
    NoResponse
}

public sealed record UnlikeOneResult(bool Success, UnlikeFailKind FailKind, int Http, int? ApiCode, string Message);

public sealed record UnlikeBatchResult(
    int Success,
    int Failed,
    IReadOnlyList<string> Failures);
