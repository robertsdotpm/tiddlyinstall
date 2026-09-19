// Fidelity check: what real Java apps rely on (docs/test-results.md, "Real-app fidelity").
// Built into app.jar at install time and run with java -jar.
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.Callable;

public class Main {
    static void check(String name, Callable<String> fn) {
        try {
            String d = fn.call();
            System.out.println("FID ok " + name + (d == null ? "" : ": " + d));
        } catch (Throwable e) {
            String m = String.valueOf(e.getMessage()).replaceAll("\\s+", " ");
            System.out.println("FID fail " + name + ": " + e.getClass().getName() + ": " + m.substring(0, Math.min(300, m.length())));
        }
    }

    public static void main(String[] args) {
        System.out.println("FID start java " + System.getProperty("java.version") + " " + System.getProperty("os.name"));
        check("java.net.http", () -> {
            HttpClient c = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(60)).build();
            HttpResponse<String> r = c.send(HttpRequest.newBuilder(URI.create("https://repo1.maven.org/maven2/")).build(),
                    HttpResponse.BodyHandlers.ofString());
            if (r.statusCode() != 200) throw new RuntimeException("HTTP " + r.statusCode());
            return "HTTPS " + r.version();
        });
        check("swing-headless", () -> {
            if (!java.awt.GraphicsEnvironment.isHeadless()) throw new RuntimeException("not headless");
            javax.swing.JLabel l = new javax.swing.JLabel("Hello");
            java.awt.Dimension d = l.getPreferredSize();
            BufferedImage img = new BufferedImage(64, 32, BufferedImage.TYPE_INT_ARGB);
            Graphics2D g = img.createGraphics();
            g.drawString("Hello", 2, 20);
            g.dispose();
            String[] fonts = java.awt.GraphicsEnvironment.getLocalGraphicsEnvironment().getAvailableFontFamilyNames();
            return "JLabel " + d.width + "x" + d.height + ", " + fonts.length + " font families";
        });
        System.out.println("FID end");
    }
}
