// Armada Windows hook spooler: read one JSON value from stdin (no EOF required),
// write maildir JSON, always print {} and exit 0.
// Compile: csc /nologo /out:armada-spool.exe armada-spool.cs
using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

internal static class ArmadaSpool
{
    static int Main(string[] args)
    {
        try { Run(args); }
        catch { /* fail-open */ }
        Console.Out.WriteLine("{}");
        return 0;
    }

    static void Run(string[] args)
    {
        string ev = (args != null && args.Length >= 1 && args[0] != null) ? args[0] : "unknown";
        string spool = Environment.GetEnvironmentVariable("ARMADA_SPOOL_DIR");
        if (string.IsNullOrEmpty(spool))
        {
            spool = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".cursor", "armada", "spool");
        }
        Directory.CreateDirectory(spool);

        string raw = ReadCompleteJson();
        if (string.IsNullOrEmpty(raw)) raw = "{}";
        string rawJson = LooksLikeJson(raw) ? raw : Unparsed(raw);
        string safe = Regex.Replace(ev, @"[^A-Za-z0-9_.:-]", "");
        if (safe.Length == 0) safe = "unknown";

        DateTime epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        long ts = (long)(DateTime.UtcNow - epoch).TotalSeconds;
        string id = ts.ToString() + "." + System.Diagnostics.Process.GetCurrentProcess().Id + "."
            + new Random().Next(0, 100000).ToString("D5");
        string tmp = Path.Combine(spool, "." + id + ".tmp");
        string finalPath = Path.Combine(spool, id + ".json");
        string json = "{\"__hook\":\"" + safe + "\",\"__ts\":" + ts + ",\"__raw\":" + rawJson + "}\n";
        File.WriteAllText(tmp, json, new UTF8Encoding(false));
        if (File.Exists(finalPath)) File.Delete(finalPath);
        File.Move(tmp, finalPath);
    }

    // Brace/bracket matching on ASCII; UTF-8 payload bytes (>=128) are opaque. Stops
    // when the top-level value is complete so we never wait for Cursor to close stdin.
    static string ReadCompleteJson()
    {
        Stream stdin = Console.OpenStandardInput();
        MemoryStream ms = new MemoryStream();
        byte[] one = new byte[1];
        int depth = 0;
        bool started = false, inStr = false, esc = false;
        while (stdin.Read(one, 0, 1) == 1)
        {
            byte b = one[0];
            ms.WriteByte(b);
            if (b >= 128) continue;
            char c = (char)b;
            if (esc) { esc = false; continue; }
            if (inStr)
            {
                if (c == '\\') esc = true;
                else if (c == '"') inStr = false;
                continue;
            }
            if (c == '"') { inStr = true; continue; }
            if (c == '{' || c == '[') { depth++; started = true; }
            else if (c == '}' || c == ']')
            {
                depth--;
                if (started && depth <= 0) break;
            }
        }
        byte[] buf = ms.ToArray();
        int oddNul = 0;
        for (int i = 1; i < buf.Length; i += 2) { if (buf[i] == 0) oddNul++; }
        if (buf.Length >= 4 && (oddNul * 2) > (buf.Length / 2))
            return Encoding.Unicode.GetString(buf);
        return Encoding.UTF8.GetString(buf);
    }

    static bool LooksLikeJson(string s)
    {
        if (s == null) return false;
        s = s.Trim();
        if (s.Length < 2) return false;
        char a = s[0], z = s[s.Length - 1];
        return (a == '{' && z == '}') || (a == '[' && z == ']');
    }

    static string Unparsed(string raw)
    {
        if (raw.Length > 4000) raw = raw.Substring(0, 4000);
        StringBuilder sb = new StringBuilder();
        foreach (char ch in raw)
        {
            int n = (int)ch;
            switch (n)
            {
                case 34: sb.Append("\\\""); break;
                case 92: sb.Append("\\\\"); break;
                case 8: sb.Append("\\b"); break;
                case 12: sb.Append("\\f"); break;
                case 10: sb.Append("\\n"); break;
                case 13: sb.Append("\\r"); break;
                case 9: sb.Append("\\t"); break;
                default:
                    if (n < 32) sb.AppendFormat("\\u{0:x4}", n);
                    else sb.Append(ch);
                    break;
            }
        }
        return "{\"__unparsed\":\"" + sb.ToString() + "\"}";
    }
}
