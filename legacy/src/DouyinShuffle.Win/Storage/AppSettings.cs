using System.IO;
using Newtonsoft.Json;

namespace DouyinShuffle.Win.Storage;

/// <summary>
/// 应用级设置(settings.json,位于 DouyinShuffle 根目录,**与账号无关**)。
/// ★为什么主题不放页面 localStorage(自检发现的缺陷):localStorage 属于各账号的 WebView2
/// profile 目录,而每个账号一个 profile —— 于是切到另一个账号后深色设置凭空"回到浅色",
/// 连窗口露边底色也跟着变。外观是"这台机器上的人"的偏好,不是某个抖音号的偏好,
/// 因此主题上移到宿主:宿主持久化 + 随 state 广播下发,UI 侧只负责应用。
/// </summary>
public sealed class AppSettings
{
    /// <summary>界面主题:"light" / "dark";**空字符串 = 宿主还没记过**(首次运行)。
    /// 空值语义很重要:此时不向 UI 下发主题(让页面沿用自己 profile 里的旧设置),
    /// 等页面首次上报后采纳并落盘 —— 老用户的深色偏好存在 profile 的 localStorage 里,
    /// 不能因为宿主清单里"还没这一项"就把他刷回浅色。</summary>
    public string Theme { get; set; } = "";

    /// <summary>规范化主题名(非法值/未设置一律返回空串,由调用方按"未设置"处理)。</summary>
    public static string NormalizeStrict(string? theme)
        => string.Equals(theme, "dark", StringComparison.OrdinalIgnoreCase) ? "dark"
         : string.Equals(theme, "light", StringComparison.OrdinalIgnoreCase) ? "light"
         : "";

    /// <summary>规范化主题名(空/非法 → "light";用于页面已明确表态的场景)。</summary>
    public static string Normalize(string? theme)
        => NormalizeStrict(theme) == "dark" ? "dark" : "light";

    public static AppSettings Load(string rootDir)
    {
        try
        {
            var path = Path.Combine(rootDir, "settings.json");
            if (File.Exists(path))
            {
                var s = JsonConvert.DeserializeObject<AppSettings>(File.ReadAllText(path));
                if (s != null) { s.Theme = NormalizeStrict(s.Theme); return s; }
            }
        }
        catch { }
        return new AppSettings();
    }

    public void Save(string rootDir)
    {
        try
        {
            Directory.CreateDirectory(rootDir);
            AtomicFile.WriteAllText(Path.Combine(rootDir, "settings.json"),
                JsonConvert.SerializeObject(this, Formatting.Indented));
        }
        catch { }
    }
}
