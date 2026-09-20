// Checks the JDK's own tools, for every Java the catalogue can install
// (6 upwards), so Java 6 source level: no diamonds, no try-with-resources,
// no lambdas.
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;

public class Main {
    static void say(String state, String name, String detail) {
        System.out.println("TOOL " + state + " " + name + ": " + detail);
    }

    static String run(String[] args) throws Exception {
        ProcessBuilder pb = new ProcessBuilder(args);
        pb.redirectErrorStream(true);
        Process p = pb.start();
        BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()));
        StringBuffer sb = new StringBuffer();
        String line;
        while ((line = r.readLine()) != null) sb.append(line).append(" ");
        int rc = p.waitFor();
        String out = sb.toString().trim();
        if (rc != 0) throw new Exception("exit " + rc + ": " + out);
        return out.length() > 120 ? out.substring(0, 120) : out;
    }

    static String tool(String name) {
        String home = System.getProperty("java.home");
        File f = new File(new File(home, "bin"), name + ".exe");
        if (!f.exists()) f = new File(new File(home, "bin"), name);
        // A JRE inside a JDK: look one folder up as well.
        if (!f.exists()) {
            File up = new File(home).getParentFile();
            if (up != null) {
                f = new File(new File(up, "bin"), name + ".exe");
                if (!f.exists()) f = new File(new File(up, "bin"), name);
            }
        }
        return f.exists() ? f.getAbsolutePath() : null;
    }

    static void check(String name, String toolName, String[] args, boolean optional) {
        String path = tool(toolName);
        if (path == null) {
            say(optional ? "skip" : "fail", name,
                optional ? toolName + " came with a later JDK" : toolName + " is not in this build (a JRE, not a JDK?)");
            return;
        }
        String[] argv = new String[args.length + 1];
        argv[0] = path;
        System.arraycopy(args, 0, argv, 1, args.length);
        try {
            say("ok", name, run(argv));
        } catch (Exception e) {
            say("fail", name, e.getClass().getName() + ": " + e.getMessage());
        }
    }

    static String ownJar() {
        try {
            return new File(Main.class.getProtectionDomain().getCodeSource().getLocation().toURI()).getAbsolutePath();
        } catch (Exception e) {
            return null;
        }
    }

    public static void main(String[] a) throws Exception {
        // This class was compiled by javac and packed by jar at install time,
        // so running at all is the first check.
        say("ok", "javac-jar", "this jar was built by javac and jar at install time");
        check("javac", "javac", new String[] { "-version" }, false);
        String jar = ownJar();
        if (jar == null) {
            say("fail", "jar", "could not find this program's own jar");
        } else {
            check("jar", "jar", new String[] { "-tf", jar }, false);
        }
        check("jlink", "jlink", new String[] { "--version" }, true);
        check("jshell", "jshell", new String[] { "--version" }, true);
        say("ok", "stdlib", "java " + System.getProperty("java.version") + ", vendor " +
            System.getProperty("java.vendor"));
        System.out.println("TOOL runtime java " + System.getProperty("java.version"));
        System.out.println("TOOL end");
    }
}
