// Fidelity check: a NuGet package restore and what real .NET apps rely on (docs/test-results.md, "Real-app fidelity").
using System;
using System.Net.Http;

static void Check(string name, Func<string> fn)
{
    try { Console.WriteLine("FID ok " + name + ": " + fn()); }
    catch (Exception e) { Console.WriteLine("FID fail " + name + ": " + e.GetType().Name + ": " + e.Message.Replace("\n", " ")); }
}

Console.WriteLine("FID start dotnet " + Environment.Version + " " + System.Runtime.InteropServices.RuntimeInformation.OSDescription);
Check("nuget-package", () =>
{
    var o = Newtonsoft.Json.JsonConvert.DeserializeObject<System.Collections.Generic.Dictionary<string, int[]>>("{\"a\":[1,2]}");
    if (o["a"][1] != 2) throw new Exception("wrong");
    return "Newtonsoft.Json " + typeof(Newtonsoft.Json.JsonConvert).Assembly.GetName().Version;
});
Check("https", () =>
{
    using var c = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
    var r = c.GetAsync("https://api.nuget.org/v3/index.json").GetAwaiter().GetResult();
    if (!r.IsSuccessStatusCode) throw new Exception("HTTP " + (int)r.StatusCode);
    return "HTTP " + r.Version;
});
Check("globalization", () =>
{
    var s = 1234.5.ToString("N1", new System.Globalization.CultureInfo("de-DE"));
    if (s != "1.234,5") throw new Exception("de-DE gave " + s + " (invariant mode?)");
    return "de-DE " + s;
});
Console.WriteLine("FID end");
