using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

// Shares the server's catalog and user preference; no separate tray setting.
public static class ToolkitLocale
{
    static string preferenceFile;
    static string catalogDirectory;
    static string language = "zh-CN";
    static DateTime preferenceTime = DateTime.MinValue;
    static Dictionary<string, string> current = new Dictionary<string, string>();
    static Dictionary<string, string> english = new Dictionary<string, string>();
    static readonly JavaScriptSerializer serializer = new JavaScriptSerializer();

    public static void Initialize(string dataDirectory, string catalogs)
    {
        preferenceFile = Path.Combine(dataDirectory, "ui-preferences.json");
        catalogDirectory = catalogs;
        english = ReadCatalog("en");
        current = ReadCatalog("zh-CN");
        Refresh();
    }
    static Dictionary<string, string> ReadCatalog(string code)
    {
        try { return serializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(Path.Combine(catalogDirectory, code + ".json"), Encoding.UTF8)); }
        catch { return new Dictionary<string, string>(); }
    }
    public static void Refresh()
    {
        if (string.IsNullOrEmpty(preferenceFile)) return;
        try
        {
            DateTime stamp = File.Exists(preferenceFile) ? File.GetLastWriteTimeUtc(preferenceFile) : DateTime.MinValue;
            if (stamp == preferenceTime) return;
            string next = "zh-CN";
            if (File.Exists(preferenceFile))
            {
                var preferences = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(preferenceFile, Encoding.UTF8));
                object value;
                if (preferences.TryGetValue("language", out value) && (value as string == "en" || value as string == "tr")) next = (string)value;
            }
            language = next;
            current = ReadCatalog(language);
            preferenceTime = stamp;
        }
        catch { /* Keep the last valid language while a preference is replaced. */ }
    }
    public static string Text(string key, string source)
    {
        string value;
        if (current.TryGetValue(key, out value) && !string.IsNullOrEmpty(value)) return value;
        if (language != "zh-CN" && english.TryGetValue(key, out value) && !string.IsNullOrEmpty(value)) return value;
        return source;
    }
}
