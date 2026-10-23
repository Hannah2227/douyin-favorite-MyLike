using System.Net.Http;

namespace DouyinShuffle.Win.Player;

/// <summary>
/// 直链有效性探测器:用 HTTP Range 请求探测 CDN 直链是否可播(不下载内容)。
/// 200/206 = 有效;403/404/超时 = 失效。仅供后台预检,不打扰页面。
/// </summary>
public static class LinkProber
{
    private static readonly HttpClient Client = Create();

    private static HttpClient Create()
    {
        var h = new HttpClient { Timeout = TimeSpan.FromSeconds(6) };
        h.DefaultRequestHeaders.UserAgent.ParseAdd(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0");
        h.DefaultRequestHeaders.Referrer = new Uri("https://www.douyin.com/");
        return h;
    }

    /// <summary>探测单个直链是否可播。</summary>
    public static async Task<bool> IsAliveAsync(string url)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.TryAddWithoutValidation("Range", "bytes=0-1");
            using var resp = await Client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
            return (int)resp.StatusCode is 200 or 206;
        }
        catch { return false; }
    }
}
