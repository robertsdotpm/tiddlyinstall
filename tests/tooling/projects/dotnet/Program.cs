// Checks NuGet restore (the dependency below is restored at install time)
// and the SDK's own tooling.
using System;

class Program
{
    static void Say(string state, string name, string detail)
    {
        Console.WriteLine("TOOL " + state + " " + name + ": " + detail);
    }

    static void Main()
    {
        try
        {
            var o = Newtonsoft.Json.JsonConvert.DeserializeObject<System.Collections.Generic.Dictionary<string, int>>("{\"a\":1}");
            Say("ok", "nuget-restore", "Newtonsoft.Json 13.0.3 restored and read a=" + o["a"]);
        }
        catch (Exception e)
        {
            Say("fail", "nuget-restore", e.GetType().Name + ": " + e.Message);
        }
        Say("ok", "sdk-build", "this assembly was built by `dotnet build` at install time");
        Say("ok", "stdlib", ".NET " + Environment.Version + ", culture " +
            System.Globalization.CultureInfo.InvariantCulture.EnglishName);
        Console.WriteLine("TOOL runtime dotnet " + Environment.Version);
        Console.WriteLine("TOOL end");
    }
}
