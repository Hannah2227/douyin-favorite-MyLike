namespace DouyinShuffle.Win.Capture;

public enum ListSource { Likes, Collections, Recommendations }

public static class ListSources
{
    public static string Key(this ListSource source) => source switch
    {
        ListSource.Collections => "collections",
        ListSource.Recommendations => "recommendations",
        _ => "likes"
    };

    public static ListSource? Parse(string key) => key switch
    {
        "likes" => ListSource.Likes,
        "collections" => ListSource.Collections,
        "recommendations" => ListSource.Recommendations,
        _ => null
    };
}
