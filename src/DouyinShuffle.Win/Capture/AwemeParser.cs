using Newtonsoft.Json.Linq;

namespace DouyinShuffle.Win.Capture;

public sealed class ParseResult
{
    public List<AwemeItem> Items { get; } = new();
    public long MaxCursor { get; set; }
    public bool HasMore { get; set; }

    /// <summary>接口业务状态码(-1=无此字段;0=正常;非 0 多为风控/参数错误)。</summary>
    public int StatusCode { get; set; } = -1;

    /// <summary>接口状态消息。</summary>
    public string StatusMsg { get; set; } = "";
}

/// <summary>
/// 解析规格:只依赖 aweme_list / aweme_detail / max_cursor / has_more 结构特征,
/// 不硬编码接口路径,抖音改版时容错率高。
/// </summary>
public static class AwemeParser
{
    public static ParseResult Parse(string jsonBody)
    {
        var result = new ParseResult();
        if (string.IsNullOrWhiteSpace(jsonBody)) return result;

        JObject root;
        try { root = JObject.Parse(jsonBody); }
        catch { return result; }

        if (root["aweme_list"] is JArray list)
        {
            foreach (var t in list)
            {
                var item = FromToken(t);
                if (item.AwemeId.Length > 0)
                    result.Items.Add(item);
            }
        }

        result.MaxCursor = root["max_cursor"]?.Value<long>() ?? 0;
        result.HasMore = root["has_more"]?.Value<bool>() ?? false;
        result.StatusCode = root["status_code"]?.Value<int>() ?? -1;
        result.StatusMsg = root["status_msg"]?.Value<string>() ?? "";
        return result;
    }

    /// <summary>从单条 aweme token 提取记录(兼容 aweme_list 元素与 aweme_detail)。
    /// format:2 —— 采集只提取【元数据】,不提取任何链接(链接留给播放时实时取链)。</summary>
    public static AwemeItem FromToken(JToken t) => FromToken(t, extractLinks: false);

    /// <summary>
    /// 从单条 aweme token 提取记录。
    /// extractLinks=true(取链/详情):额外提取视频直链/图集图片/背景音乐,供播放;
    /// extractLinks=false(采集):只提取元数据,链接不持久化。
    /// </summary>
    public static AwemeItem FromToken(JToken t, bool extractLinks)
    {
        var item = new AwemeItem
        {
            AwemeId = t["aweme_id"]?.Value<string>() ?? "",
            Desc = t["desc"]?.Value<string>() ?? "",
            CreateTime = t["create_time"]?.Value<long>() ?? 0,
            AwemeType = t["aweme_type"]?.Value<int>() ?? 0
        };

        // 封面(持久化;失效的等播放取链时顺带刷新)
        var video = t["video"];
        if (video != null)
        {
            var cover = video["cover"] ?? video["origin_cover"];
            if (cover?["url_list"] is JArray covers && covers.Count > 0)
                item.CoverUrl = covers[0].Value<string>() ?? "";
        }

        // 图集帖标记(有 images 即为图集)
        if (t["images"] is JArray imgs && imgs.Count > 0)
        {
            item.Status = 2;
            if (extractLinks)
            {
                item.ImageUrls = imgs
                    .Select(img => img["url_list"]?.FirstOrDefault()?.Value<string>())
                    .Where(u => !string.IsNullOrEmpty(u))
                    .Select(u => u!)
                    .ToList();
                // 动图图集(实况)适配 v1.0.7:每张图的动态视频子链(与静态图索引对齐;无动态版 = null)。
                // 已知位置(按优先级探测):images[i].video.play_addr.url_list /
                //   images[i].live_image.url_list / images[i].video.url_list / images[i].urls(冗余数组)。
                // 若全部未命中, dump 首图的键集合到日志供排查(诊断行)。
                item.LiveImageUrls = imgs.Select(img =>
                {
                    var u1 = (img["video"]?["play_addr"]?["url_list"] as JArray)?.FirstOrDefault()?.Value<string>();
                    var u2 = (img["live_image"]?["url_list"] as JArray)?.FirstOrDefault()?.Value<string>();
                    var u3 = (img["video"]?["url_list"] as JArray)?.FirstOrDefault()?.Value<string>();
                    var u4 = (img["urls"] as JArray)?.FirstOrDefault()?["url_list"]?.FirstOrDefault()?.Value<string>();
                    return u1 ?? u2 ?? u3 ?? u4;
                }).ToList();
                var firstKeys = string.Join(",", ((JObject)imgs[0]!).Properties().Select(p => p.Name));
                // 诊断降级:只在"一张都没命中动态子链"时记 —— 命中是常态,每张图集都记会把日志刷成噪声
                // (排查"实况显示为静态"时,真正需要看的就是未命中那些的键集合)
                if (item.LiveImageUrls.All(u => u == null))
                    AppLog.Write($"LIVE-PROBE miss images={imgs.Count} keys[{imgs[0]!.Path}]={firstKeys}");
            }
        }

        if (extractLinks)
        {
            // 视频直链:H.264 硬性优先(WebView2 无 HEVC 解码器时 H.265 = 有声无画)
            if (video != null)
            {
                item.PlayUrls = ExtractPlayUrls(video);
                item.PlayUrl = item.PlayUrls.FirstOrDefault() ?? "";
            }
            // 背景音乐:图集/图文帖常见两处 —— 常规 music.play_url.url_list / music.url_list,
            // 版权音乐(PGC)在 music.matched_pgc_sound.play_url.url_list(不查这里 → 原页有声、播放器静音)。
            if (t["music"] is JObject music)
            {
                var mUrls = (music["play_url"]?["url_list"] as JArray ?? music["url_list"] as JArray)
                    ?? music["matched_pgc_sound"]?["play_url"]?["url_list"] as JArray
                    ?? music["matched_pgc_sound"]?["url_list"] as JArray;
                if (mUrls is { Count: > 0 })
                {
                    item.MusicUrl = mUrls
                        .Select(u => u.Value<string>())
                        .FirstOrDefault(u => !string.IsNullOrEmpty(u) && !u.Contains("playwm"))
                        ?? mUrls.FirstOrDefault()?.Value<string>() ?? "";
                }
            }
        }

        item.AuthorName = t["author"]?["nickname"]?.Value<string>() ?? "";
        return item;
    }

    /// <summary>
    /// 提取无水印直链,H.264 硬性优先:
    /// 1) play_addr_h264(专为 H.264 的地址)最优先;
    /// 2) bit_rate 列表里 gear_name 带 "bytevc1/h265/hevc" 的排到最后(排除编码不确定的);
    /// 3) play_addr 通用列表(排序:非 h265 域 > h265 域 > 纯音频 > 代理)。
    /// WebView2 默认无 HEVC 解码器,H.265 链接 = 有声无画,必须排到最后兜底。
    /// </summary>
    public static List<string> ExtractPlayUrls(JToken? video)
    {
        if (video == null) return new List<string>();

        var result = new List<string>();

        // ① play_addr_h264:专门的 H.264 地址(最稳)
        if (video["play_addr_h264"]?["url_list"] is JArray h264Urls)
        {
            result.AddRange(h264Urls
                .Select(u => u.Value<string>())
                .Where(u => !string.IsNullOrEmpty(u) && !u.Contains("playwm"))!);
        }

        // ② play_addr 通用列表:非 h265 域优先
        if (video["play_addr"]?["url_list"] is JArray urls)
        {
            var candidates = urls
                .Select(u => u.Value<string>())
                .Where(u => !string.IsNullOrEmpty(u) && !u.Contains("playwm"))
                .Where(u => u != null)
                .Select(u => u!)
                .Distinct();

            result.AddRange(candidates
                .OrderBy(u => u.Contains("bytevc1") || u.Contains("h265") || u.Contains("hevc") ? 1 : 0)
                .ThenBy(u => u.Contains("/aac/") || u.Contains("audio") ? 1 : 0)
                .ThenBy(u => u.Contains("www.douyin.com/aweme/v1/play/") ? 1 : 0));
        }

        return result.Distinct().ToList();
    }
}
