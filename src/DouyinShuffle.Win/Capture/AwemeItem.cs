using Newtonsoft.Json;

namespace DouyinShuffle.Win.Capture;

/// <summary>
/// 单条点赞视频记录(对应抖音 web 响应 aweme_list 中的一条)。
/// 持久化策略(format:2):只存【元数据】(id/文案/作者/时间/封面/类型)。
/// 【链接类字段全部 [JsonIgnore]】——播放时严格新链实时取链,取链结果只存在内存,
/// 不写回磁盘(链接有时效,持久化无意义;同时让 .dylist 与播放列表天然一致)。
/// </summary>
public sealed class AwemeItem
{
    /// <summary>唯一 ID,作为主键去重,并拼出永久分享链接。</summary>
    public string AwemeId { get; set; } = "";

    /// <summary>视频文案。</summary>
    public string Desc { get; set; } = "";

    /// <summary>封面图地址(持久化;失效的等播放取链时顺带刷新)。</summary>
    public string CoverUrl { get; set; } = "";

    /// <summary>作者昵称。</summary>
    public string AuthorName { get; set; } = "";

    /// <summary>发布时间(unix 秒)。</summary>
    public long CreateTime { get; set; }

    /// <summary>aweme_type:0 为普通视频,图集等为其他值。</summary>
    public int AwemeType { get; set; }

    /// <summary>0 正常 / 1 失效 / 2 图集。</summary>
    public int Status { get; set; }

    // ---------- 以下为运行时字段(播放取链填充,不持久化) ----------

    /// <summary>无水印 CDN 直链(有时效)。运行时取链填充。</summary>
    [JsonIgnore]
    public string PlayUrl { get; set; } = "";

    /// <summary>全部直链变体(H.264 优先),播放时逐条尝试。运行时取链填充。</summary>
    [JsonIgnore]
    public List<string> PlayUrls { get; set; } = new();

    /// <summary>图集帖的图片列表(轮播用)。运行时取链填充。</summary>
    [JsonIgnore]
    public List<string> ImageUrls { get; set; } = new();

    /// <summary>动图图集(实况)每张图的动态视频子链(与 ImageUrls 索引对齐;null=该张为纯图)。
    /// 运行时取链填充,不持久化。v1.0.7 实况适配。</summary>
    [JsonIgnore]
    public List<string?> LiveImageUrls { get; set; } = new();

    /// <summary>背景音乐直链(图集帖等)。运行时取链填充。</summary>
    [JsonIgnore]
    public string MusicUrl { get; set; } = "";

    /// <summary>采集时间(unix 秒)。运行时记录,不持久化。</summary>
    [JsonIgnore]
    public long CollectedAt { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeSeconds();

    /// <summary>永久分享链接(任何时候可打开)。</summary>
    public string ShareUrl => $"https://www.douyin.com/video/{AwemeId}";
}

/// <summary>实时取链结果(视频直链 / 图集图片 / 实况动态子链 / 背景音乐 / 封面)。</summary>
public sealed class FreshMedia
{
    public List<string> PlayUrls { get; set; } = new();
    public List<string> ImageUrls { get; set; } = new();

    /// <summary>动图图集(实况)每张图的动态视频子链(索引对齐 ImageUrls;null=纯图)。</summary>
    public List<string?> LiveImageUrls { get; set; } = new();

    public string MusicUrl { get; set; } = "";
    public string CoverUrl { get; set; } = "";

    public bool HasAny => PlayUrls.Count > 0 || ImageUrls.Count > 0 || MusicUrl.Length > 0;
}
