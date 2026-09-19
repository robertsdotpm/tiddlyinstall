// Beacon collector for the Safari 5.1.7 check: logs each request line to a
// file and answers a 1x1 GIF. ibcollect PORT OUTFILE MINUTES
using System; using System.IO; using System.Net; using System.Net.Sockets; using System.Text; using System.Threading;
class C {
  static void Main(string[] a) {
    int port = int.Parse(a[0]); string outp = a[1]; DateTime end = DateTime.Now.AddMinutes(int.Parse(a[2]));
    TcpListener l = new TcpListener(IPAddress.Loopback, port); l.Start();
    byte[] gif = Convert.FromBase64String("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
    while (DateTime.Now < end) {
      if (!l.Pending()) { Thread.Sleep(100); continue; }
      try {
        using (TcpClient c = l.AcceptTcpClient()) {
          c.ReceiveTimeout = 5000;
          NetworkStream s = c.GetStream(); StreamReader r = new StreamReader(s, Encoding.ASCII);
          string line = r.ReadLine(), h;
          while ((h = r.ReadLine()) != null && h.Length > 0) { }
          if (line != null) File.AppendAllText(outp, line + "\r\n");
          byte[] hb = Encoding.ASCII.GetBytes("HTTP/1.0 200 OK\r\nContent-Type: image/gif\r\nCache-Control: no-store\r\nContent-Length: " + gif.Length + "\r\nConnection: close\r\n\r\n");
          s.Write(hb, 0, hb.Length); s.Write(gif, 0, gif.Length);
        }
      } catch (Exception e) { File.AppendAllText(outp, "ERR " + e.Message + "\r\n"); }
    }
    l.Stop();
  }
}
