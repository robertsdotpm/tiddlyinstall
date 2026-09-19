// The code templates of "I'll write it here" (docs/design.md section 1.4):
// runtime -> template -> {
//   label     what it's built with, shown on the template's card
//   files     {file name: starting text}, in the editor's order; the first
//             is the one the default launch command runs
//   launch    the launch command, when running the first file with
//             {runtime} isn't it (compiled languages, Java's classes)
//   install   the install/build command, when the policy's default for the
//             project's files isn't it ('' or absent: the policy's)
//   versions  a runtime version range the code needs, used when the form
//             says "the newest that runs" (a narrower range, or an exact
//             version, chosen in the form wins)
//   console   true: runs in a console window
//   needs     packages the template's own files (requirements.txt,
//             package.json, Gemfile) have the installer fetch
//   platforms where it can work: 'windows', 'linux', 'macos'
//   note      one or two sentences on what it needs, shown under the editor
//   title     the window title (window templates), which the tests look for
// }
//
// new.html's editor is rendered from this (js/new.js), js/form-job.js turns
// a written app into a job with it (in the page and on the build server),
// and tests/templates/ builds, installs and runs every one on the test
// machines.
//
// Every template has a self-test: with IB_TEMPLATE_SELFTEST=1 in its
// environment it starts up as usual (the window shown, the server
// answering, the tray icon set up), prints "template ok: <runtime>/<template>"
// (also to the file IB_TEMPLATE_SELFTEST_OUT names, since GUI apps have no
// console) and exits 0 within a few seconds. It's marked in each file as used
// by the site's tests and safe to delete.
//
// Plain ES2017 (the one-file page's floor). The code is in raw template
// literals (the `code` tag: String.raw without interpolation, which IE 11's
// ES5 copy lacks), so backslashes are the code's own. None of it may contain
// a backtick, a dollar sign followed by an opening brace, or a closing
// script tag (the one-file page inlines this file in a <script>).

const code = (strings) => strings.raw.join('');
const END_SCRIPT = '<' + '/script>\n';

// The cards, in order. A runtime shows the cards it has templates for.
export const TEMPLATE_KINDS = {
  script: { label: 'Script', hint: 'Runs in a console window. The simplest.' },
  cpp: { label: 'C++ script', hint: 'The same, in C++.' },
  window: { label: 'Window app', hint: 'A small desktop window with buttons and text.' },
  web: { label: 'Web page', hint: 'The look in HTML, the logic in your code. Opens in the browser.' },
  tray: { label: 'Tray app', hint: 'Runs in the background with a menu icon.' },
};

const ALL = ['windows', 'linux', 'macos'];

// The page the web templates serve. Their code answers /api/greet.
const WEB_PAGE = code`<!doctype html>
<meta charset="utf-8">
<title>My App</title>
<h1>My App</h1>
<input id="name" placeholder="Your name">
<button onclick="greet()">Greet</button>
<p id="out"></p>
<script>
  // Asks the app's code for a greeting (its /api/greet).
  async function greet() {
    const name = document.getElementById("name").value;
    const answer = await fetch("/api/greet?name=" + encodeURIComponent(name));
    document.getElementById("out").textContent = await answer.text();
  }
` + END_SCRIPT;

const WEB_NOTE = 'Starts a small web server on this computer only and opens the page in the browser. ' +
  'Its console window says where it is; closing that window stops it.';

/* ---------- Python 3 ---------- */

const PY_SELFTEST_FN = (what) => code`# Used by the site's tests to check this template works; safe to delete.
def selftest_ok():
    print("template ok: WHAT")
    if os.environ.get("IB_TEMPLATE_SELFTEST_OUT"):
        with open(os.environ["IB_TEMPLATE_SELFTEST_OUT"], "w") as f:
            f.write("template ok: WHAT\n")
`.replace(/WHAT/g, what);

const PY_TKINTER = (tk, what) => code`import os
import TKINTER as tk

window = tk.Tk()
window.title("My App")

label = tk.Label(window, text="Hello!", font=("", 18))
label.pack(padx=40, pady=20)


def clicked():
    label.config(text="You clicked the button")


tk.Button(window, text="Click me", command=clicked).pack(pady=(0, 20))

SELFTEST
if os.environ.get("IB_TEMPLATE_SELFTEST") == "1":
    window.after(1000, selftest_ok)       # once the window is up
    window.after(4000, window.destroy)

window.mainloop()
`.replace('TKINTER', tk).replace('SELFTEST\n', PY_SELFTEST_FN(what));

const python = {
  script: {
    label: '',
    files: {
      'main.py': code`import os

# Used by the site's tests to check this template works; safe to delete.
if os.environ.get("IB_TEMPLATE_SELFTEST") == "1":
    print("template ok: python/script")
    if os.environ.get("IB_TEMPLATE_SELFTEST_OUT"):
        with open(os.environ["IB_TEMPLATE_SELFTEST_OUT"], "w") as f:
            f.write("template ok: python/script\n")
    raise SystemExit(0)

name = input("What's your name? ")
print("Hello, " + name + "!")

input("Press Enter to close")
`,
    },
    console: true,
    platforms: ALL,
  },
  window: {
    label: 'Tkinter',
    files: { 'main.py': PY_TKINTER('tkinter', 'python/window') },
    console: false,
    platforms: ALL,
    title: 'My App',
    note: 'Tkinter comes with Python. On Linux it needs a desktop (X11 or XWayland).',
  },
  web: {
    label: 'built-in web server',
    files: {
      'main.py': code`import os
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/":
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                self.reply(200, "text/html; charset=utf-8", f.read())
        elif url.path == "/api/greet":
            # Your app's logic: the page asks, Python answers.
            name = parse_qs(url.query).get("name", [""])[0]
            self.reply(200, "text/plain; charset=utf-8", ("Hello, " + name + "!").encode("utf-8"))
        else:
            self.reply(404, "text/plain", b"Not found")

    def reply(self, status, kind, body):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass  # keep the console quiet


server = HTTPServer(("127.0.0.1", 0), Handler)  # port 0: any free port
url = "http://127.0.0.1:%d/" % server.server_port
print("My App is running at " + url)
print("Close this window to stop it.")
sys.stdout.flush()

# Used by the site's tests to check this template works; safe to delete.
if os.environ.get("IB_TEMPLATE_SELFTEST") == "1":
    import threading
    import urllib.request

    def selftest():
        page = urllib.request.urlopen(url, timeout=10).read().decode("utf-8")
        greeting = urllib.request.urlopen(url + "api/greet?name=test", timeout=10).read().decode("utf-8")
        if "Greet" in page and greeting == "Hello, test!":
            print("template ok: python/web")
            if os.environ.get("IB_TEMPLATE_SELFTEST_OUT"):
                with open(os.environ["IB_TEMPLATE_SELFTEST_OUT"], "w") as f:
                    f.write("template ok: python/web\n")
        sys.stdout.flush()
        os._exit(0)

    threading.Thread(target=selftest).start()
else:
    webbrowser.open(url)

server.serve_forever()
`,
      'index.html': WEB_PAGE,
    },
    console: true,
    platforms: ALL,
    note: WEB_NOTE + ' Only Python\'s own modules: nothing to install.',
  },
  tray: {
    label: 'pystray',
    files: {
      'main.py': code`import os
import time

import pystray
from PIL import Image, ImageDraw


def make_icon():
    image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    ImageDraw.Draw(image).ellipse((6, 6, 58, 58), fill="royalblue")
    return image


def say_hello(icon, item):
    icon.notify("Hello from the tray!", "My App")


icon = pystray.Icon("my-app", make_icon(), "My App", menu=pystray.Menu(
    pystray.MenuItem("Say hello", say_hello),
    pystray.MenuItem("Quit", lambda icon, item: icon.stop()),
))


def setup(icon):
    icon.visible = True
    # Used by the site's tests to check this template works; safe to delete.
    if os.environ.get("IB_TEMPLATE_SELFTEST") == "1":
        print("template ok: python/tray")
        if os.environ.get("IB_TEMPLATE_SELFTEST_OUT"):
            with open(os.environ["IB_TEMPLATE_SELFTEST_OUT"], "w") as f:
                f.write("template ok: python/tray\n")
        time.sleep(3)
        icon.stop()


icon.run(setup)
`,
      'requirements.txt': 'pystray\nPillow\n',
    },
    console: false,
    needs: ['pystray', 'Pillow'],
    platforms: ALL,
    note: 'Installs pystray and Pillow (requirements.txt) with pip. On Linux the icon needs a desktop with a system tray ' +
      '(KDE, Xfce, Cinnamon or MATE; GNOME only with an AppIndicator extension), and glibc 2.28 or later ' +
      '(RHEL 8, Ubuntu 20.04), where Pillow has ready-made builds.',
  },
};

/* ---------- Python 2 ---------- */

const python2 = {
  script: {
    label: '',
    files: {
      'main.py': code`import os

# Used by the site's tests to check this template works; safe to delete.
if os.environ.get("IB_TEMPLATE_SELFTEST") == "1":
    print "template ok: python2/script"
    if os.environ.get("IB_TEMPLATE_SELFTEST_OUT"):
        with open(os.environ["IB_TEMPLATE_SELFTEST_OUT"], "w") as f:
            f.write("template ok: python2/script\n")
    raise SystemExit(0)

name = raw_input("What's your name? ")
print "Hello, " + name + "!"

raw_input("Press Enter to close")
`,
    },
    console: true,
    platforms: ALL,
    note: 'The catalogue has Python 2 for Windows only.',
  },
  window: {
    label: 'Tkinter',
    files: {
      'main.py': PY_TKINTER('Tkinter', 'python2/window')
        // Python 2: print is a statement, and a window app may have no stdout.
        .replace('    print("template ok: python2/window")\n', '    try:\n        print "template ok: python2/window"\n    except IOError:\n        pass\n'),
    },
    console: false,
    platforms: ['windows'],
    title: 'My App',
    note: 'Tkinter comes with Python 2 for Windows. The catalogue has Python 2 for Windows only.',
  },
};

/* ---------- Node.js ---------- */

const JS_SELFTEST_FN = (what) => code`// Used by the site's tests to check this template works; safe to delete.
function selftestOk() {
  console.log("template ok: WHAT");
  if (process.env.IB_TEMPLATE_SELFTEST_OUT) {
    require("fs").writeFileSync(process.env.IB_TEMPLATE_SELFTEST_OUT, "template ok: WHAT\n");
  }
}
`.replace(/WHAT/g, what);

const node = {
  script: {
    label: '',
    files: {
      'main.js': code`"use strict";
const readline = require("readline");

function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("What's your name? ", (name) => {
    console.log("Hello, " + name + "!");
    rl.question("Press Enter to close", () => rl.close());
  });
}

` + JS_SELFTEST_FN('node/script') + code`
if (process.env.IB_TEMPLATE_SELFTEST === "1") selftestOk();
else main();
`,
    },
    console: true,
    platforms: ALL,
  },
  web: {
    label: 'built-in web server',
    files: {
      'main.js': code`"use strict";
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const querystring = require("querystring");

const server = http.createServer((request, response) => {
  const where = request.url.split("?")[0];
  const query = request.url.split("?")[1] || "";
  if (where === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fs.readFileSync(path.join(__dirname, "index.html")));
  } else if (where === "/api/greet") {
    // Your app's logic: the page asks, Node.js answers.
    const name = querystring.parse(query).name || "";
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Hello, " + name + "!");
  } else {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not found");
  }
});

// Opens the page in the default browser.
function openBrowser(url) {
  const how = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  childProcess.spawn(how[0], how[1], { stdio: "ignore", detached: true })
    .on("error", () => console.log("Open " + url + " in your browser."))
    .unref();
}

` + JS_SELFTEST_FN('node/web') + code`
function selftest(url) {
  const get = (address, then) => http.get(address, (response) => {
    let body = "";
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => then(body));
  });
  get(url, (page) => get(url + "api/greet?name=test", (greeting) => {
    if (page.indexOf("Greet") >= 0 && greeting === "Hello, test!") selftestOk();
    process.exit(0);
  }));
}

server.listen(0, "127.0.0.1", () => {   // port 0: any free port
  const url = "http://127.0.0.1:" + server.address().port + "/";
  console.log("My App is running at " + url);
  console.log("Close this window to stop it.");
  if (process.env.IB_TEMPLATE_SELFTEST === "1") selftest(url);
  else openBrowser(url);
});
`,
      'index.html': WEB_PAGE,
    },
    console: true,
    platforms: ALL,
    note: WEB_NOTE + ' Only Node.js\'s own modules: nothing to install.',
  },
  tray: {
    label: 'Electron',
    files: {
      'main.js': code`"use strict";
const path = require("path");
const { app, Menu, Notification, Tray, nativeImage } = require("electron");

// Electron's own files (settings, caches) in the app's data folder, which
// the uninstaller removes, rather than in the user's profile.
app.setPath("userData", path.join(__dirname, "data", "electron"));

// A 16x16 blue dot. Your own: nativeImage.createFromPath(path.join(__dirname, "icon.png")).
const ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVR42mNgoAVwzHz4HxsmWyNRBhGrGachFBlAqmYMQ0YNoIIBA58OqJKUqZKZyAEAK8+geFQaQpYAAAAASUVORK5CYII=";

let tray = null;   // kept here, so it isn't cleaned away

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();   // macOS: no Dock icon, only the menu bar one
  tray = new Tray(nativeImage.createFromDataURL(ICON));
  tray.setToolTip("My App");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Say hello", click: () => new Notification({ title: "My App", body: "Hello from the tray!" }).show() },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));

  // Used by the site's tests to check this template works; safe to delete.
  if (process.env.IB_TEMPLATE_SELFTEST === "1") {
    console.log("template ok: node/tray");
    if (process.env.IB_TEMPLATE_SELFTEST_OUT) {
      require("fs").writeFileSync(process.env.IB_TEMPLATE_SELFTEST_OUT, "template ok: node/tray\n");
    }
    setTimeout(() => app.quit(), 3000);
  }
});

// A tray app keeps running with no windows open.
app.on("window-all-closed", () => {});
`,
      'package.json': code`{
  "name": "my-app",
  "version": "1.0.0",
  "private": true,
  "main": "main.js",
  "dependencies": {
    "electron": "^44.0.0"
  }
}
`,
    },
    launch: '{runtime} {app_dir}/node_modules/electron/cli.js {app_dir}',
    // Electron 44 runs where Node.js 23 and later do (Windows 10, current
    // Linux, macOS 12): older systems get a clear "no release" instead.
    versions: '>=23',
    console: false,
    needs: ['electron'],
    platforms: ALL,
    note: 'Installs Electron (package.json, about 100 MB) with npm. Electron 44 needs Windows 10, macOS 12 or a current Linux ' +
      'desktop: it uses the desktop\'s own libraries (GTK 3, NSS), which servers and minimal installs leave out, and the icon ' +
      'needs a system tray (GNOME only with an AppIndicator extension).',
  },
};

/* ---------- Ruby ---------- */

const ruby = {
  script: {
    label: '',
    files: {
      'main.rb': code`# Used by the site's tests to check this template works; safe to delete.
if ENV["IB_TEMPLATE_SELFTEST"] == "1"
  puts "template ok: ruby/script"
  File.write(ENV["IB_TEMPLATE_SELFTEST_OUT"], "template ok: ruby/script\n") if ENV["IB_TEMPLATE_SELFTEST_OUT"]
  exit 0
end

print "What's your name? "
name = gets.chomp
puts "Hello, #{name}!"

print "Press Enter to close"
gets
`,
    },
    console: true,
    platforms: ALL,
  },
  window: {
    label: 'glimmer-dsl-libui',
    files: {
      'main.rb': code`require "glimmer-dsl-libui"

include Glimmer

app = window("My App", 300, 120) {
  margined true

  vertical_box {
    @label = label("Hello!")

    button("Click me") {
      on_clicked { @label.text = "You clicked the button" }
    }
  }
}

# Used by the site's tests to check this template works; safe to delete.
if ENV["IB_TEMPLATE_SELFTEST"] == "1"
  Glimmer::LibUI.timer(1, repeat: false) do
    puts "template ok: ruby/window"
    File.write(ENV["IB_TEMPLATE_SELFTEST_OUT"], "template ok: ruby/window\n") if ENV["IB_TEMPLATE_SELFTEST_OUT"]
  end
  Glimmer::LibUI.timer(4, repeat: false) { ::LibUI.quit }
end

app.show
`,
      'Gemfile': code`source "https://rubygems.org"

gem "glimmer-dsl-libui"
`,
    },
    console: false,
    needs: ['glimmer-dsl-libui'],
    platforms: ALL,
    title: 'My App',
    note: 'Installs glimmer-dsl-libui (Gemfile) with Bundler; it brings its own libui. On Linux it needs GTK 3, which desktops have.',
  },
};

/* ---------- PHP ---------- */

const php = {
  script: {
    label: '',
    files: {
      'main.php': code`<?php
// Used by the site's tests to check this template works; safe to delete.
if (getenv("IB_TEMPLATE_SELFTEST") === "1") {
    echo "template ok: php/script\n";
    if (getenv("IB_TEMPLATE_SELFTEST_OUT")) {
        file_put_contents(getenv("IB_TEMPLATE_SELFTEST_OUT"), "template ok: php/script\n");
    }
    exit(0);
}

echo "What's your name? ";
$name = trim(fgets(STDIN));
echo "Hello, $name!\n";

echo "Press Enter to close";
fgets(STDIN);
`,
    },
    console: true,
    platforms: ALL,
  },
  web: {
    label: 'PHP\'s built-in server',
    files: {
      'main.php': code`<?php
// Starts PHP's built-in web server for the pages in public/ and opens the
// first in the browser. Needs PHP 7.4 or later.

// Any free port on this computer.
$probe = stream_socket_server("tcp://127.0.0.1:0");
$address = stream_socket_get_name($probe, false);
fclose($probe);
$url = "http://$address/";

// php -S, with this script's php.ini, its log to nowhere.
$command = array(PHP_BINARY);
if (php_ini_loaded_file()) {
    array_push($command, "-c", php_ini_loaded_file());
}
array_push($command, "-S", $address, "-t", __DIR__ . DIRECTORY_SEPARATOR . "public");
$nowhere = PHP_OS_FAMILY === "Windows" ? "NUL" : "/dev/null";
$server = proc_open($command, array(1 => array("file", $nowhere, "w"), 2 => array("file", $nowhere, "w")), $pipes);
for ($i = 0; $i < 50 && !@fsockopen("127.0.0.1", parse_url($url, PHP_URL_PORT)); $i++) {
    usleep(100000);   // until it answers
}

echo "My App is running at $url\n";
echo "Close this window to stop it.\n";

// Used by the site's tests to check this template works; safe to delete.
if (getenv("IB_TEMPLATE_SELFTEST") === "1") {
    $page = @file_get_contents($url . "?name=test");
    proc_terminate($server);
    if ($page !== false && strpos($page, "Hello, test!") !== false) {
        echo "template ok: php/web\n";
        if (getenv("IB_TEMPLATE_SELFTEST_OUT")) {
            file_put_contents(getenv("IB_TEMPLATE_SELFTEST_OUT"), "template ok: php/web\n");
        }
    }
    exit(0);
}

if (PHP_OS_FAMILY === "Windows") {
    pclose(popen("start \"\" \"$url\"", "r"));
} else {
    exec((PHP_OS_FAMILY === "Darwin" ? "open " : "xdg-open ") . escapeshellarg($url) . " >/dev/null 2>&1 &");
}
proc_close($server);   // waits until the server stops
`,
      'public/index.php': code`<?php $name = isset($_GET["name"]) ? $_GET["name"] : ""; ?>
<!doctype html>
<meta charset="utf-8">
<title>My App</title>
<h1>My App</h1>
<form>
  <input name="name" placeholder="Your name" value="<?= htmlspecialchars($name) ?>">
  <button>Greet</button>
</form>
<?php if ($name !== "") { ?>
  <p>Hello, <?= htmlspecialchars($name) ?>!</p>
<?php } ?>
`,
    },
    console: true,
    platforms: ALL,
    note: WEB_NOTE + ' PHP pages go in public/.',
  },
};

/* ---------- Java ---------- */

const JAVA_SELFTEST_FN = (what) => code`
    // Used by the site's tests to check this template works; safe to delete.
    static void selftestOk() throws IOException {
        System.out.println("template ok: WHAT");
        String file = System.getenv("IB_TEMPLATE_SELFTEST_OUT");
        if (file != null && file.length() > 0) {
            Writer out = new FileWriter(file);
            out.write("template ok: WHAT\n");
            out.close();
        }
    }
`.replace(/WHAT/g, what);

// javac through the policy (java's install rule for Main.java), then the
// classes run from the app's folder. Java 6 syntax: Windows XP gets Java 8.
const JAVA_LAUNCH = '{runtime} -cp {app_dir} Main';

const java = {
  script: {
    label: '',
    files: {
      'Main.java': code`import java.io.BufferedReader;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.Writer;

public class Main {
    public static void main(String[] args) throws IOException {
        if ("1".equals(System.getenv("IB_TEMPLATE_SELFTEST"))) {
            selftestOk();
            return;
        }
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
        System.out.print("What's your name? ");
        System.out.flush();
        String name = in.readLine();
        System.out.println("Hello, " + name + "!");

        System.out.print("Press Enter to close");
        System.out.flush();
        in.readLine();
    }
` + JAVA_SELFTEST_FN('java/script') + '}\n',
    },
    launch: JAVA_LAUNCH,
    console: true,
    platforms: ALL,
    note: 'Compiled with the JDK\'s javac when the app is installed.',
  },
  window: {
    label: 'Swing',
    files: {
      'Main.java': code`import java.awt.BorderLayout;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.io.FileWriter;
import java.io.IOException;
import java.io.Writer;
import javax.swing.BorderFactory;
import javax.swing.JButton;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.SwingConstants;
import javax.swing.SwingUtilities;
import javax.swing.Timer;

public class Main {
    public static void main(String[] args) {
        SwingUtilities.invokeLater(new Runnable() {
            public void run() {
                showWindow();
            }
        });
    }

    static void showWindow() {
        JFrame window = new JFrame("My App");
        window.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);

        final JLabel label = new JLabel("Hello!", SwingConstants.CENTER);
        label.setFont(label.getFont().deriveFont(18f));
        label.setBorder(BorderFactory.createEmptyBorder(20, 40, 20, 40));
        window.add(label, BorderLayout.CENTER);

        JButton button = new JButton("Click me");
        button.addActionListener(new ActionListener() {
            public void actionPerformed(ActionEvent e) {
                label.setText("You clicked the button");
            }
        });
        JPanel buttons = new JPanel();
        buttons.add(button);
        window.add(buttons, BorderLayout.SOUTH);

        window.pack();
        window.setLocationRelativeTo(null);
        window.setVisible(true);

        // Used by the site's tests to check this template works; safe to delete.
        if ("1".equals(System.getenv("IB_TEMPLATE_SELFTEST"))) {
            after(1000, new ActionListener() {   // once the window is up
                public void actionPerformed(ActionEvent e) {
                    try {
                        selftestOk();
                    } catch (IOException x) {
                        x.printStackTrace();
                    }
                }
            });
            after(4000, new ActionListener() {
                public void actionPerformed(ActionEvent e) {
                    System.exit(0);
                }
            });
        }
    }

    static void after(int ms, ActionListener then) {
        Timer timer = new Timer(ms, then);
        timer.setRepeats(false);
        timer.start();
    }
` + JAVA_SELFTEST_FN('java/window') + '}\n',
    },
    launch: JAVA_LAUNCH,
    console: false,
    platforms: ALL,
    title: 'My App',
    note: 'Swing comes with Java. On Linux it needs a desktop (X11 or XWayland).',
  },
};

/* ---------- .NET ---------- */

// The SDK's own .NET version, so the project builds with whichever SDK the
// installer brings (older SDKs have no newer target framework).
const CSPROJ = (kind, tfm, extra) => code`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>KIND</OutputType>
    <!-- The .NET version of the SDK the installer brings. -->
    <TargetFramework>TFM</TargetFramework>EXTRA
  </PropertyGroup>
</Project>
`.replace('KIND', kind).replace('TFM', tfm).replace('EXTRA', extra);

const CS_SELFTEST_FN = (what) => code`
    // Used by the site's tests to check this template works; safe to delete.
    static void SelftestOk()
    {
        Console.WriteLine("template ok: WHAT");
        string file = Environment.GetEnvironmentVariable("IB_TEMPLATE_SELFTEST_OUT");
        if (!string.IsNullOrEmpty(file)) File.WriteAllText(file, "template ok: WHAT\n");
    }
`.replace(/WHAT/g, what);

const dotnet = {
  script: {
    label: 'C#',
    files: {
      'Program.cs': code`using System;
using System.IO;

class Program
{
    static void Main()
    {
        if (Environment.GetEnvironmentVariable("IB_TEMPLATE_SELFTEST") == "1")
        {
            SelftestOk();
            return;
        }
        Console.Write("What's your name? ");
        string name = Console.ReadLine();
        Console.WriteLine("Hello, " + name + "!");

        Console.Write("Press Enter to close");
        Console.ReadLine();
    }
` + CS_SELFTEST_FN('dotnet/script') + '}\n',
      'App.csproj': CSPROJ('Exe', 'net$(BundledNETCoreAppTargetFrameworkVersion)', ''),
    },
    // `dotnet build -o bin` (the policy's) makes bin/App.dll, named after App.csproj.
    launch: '{runtime} {app_dir}/bin/App.dll',
    console: true,
    platforms: ALL,
    note: 'Built with the .NET SDK when the app is installed.',
  },
  window: {
    label: 'Windows Forms',
    files: {
      'Program.cs': code`using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

static class Program
{
    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        var window = new Form { Text = "My App", Width = 320, Height = 180, StartPosition = FormStartPosition.CenterScreen };
        var label = new Label { Text = "Hello!", Font = new Font(FontFamily.GenericSansSerif, 16), Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter };
        var button = new Button { Text = "Click me", Dock = DockStyle.Bottom, Height = 40 };
        button.Click += (sender, e) => label.Text = "You clicked the button";
        window.Controls.Add(label);
        window.Controls.Add(button);

        // Used by the site's tests to check this template works; safe to delete.
        if (Environment.GetEnvironmentVariable("IB_TEMPLATE_SELFTEST") == "1")
        {
            window.Shown += (sender, e) =>
            {
                SelftestOk();
                var timer = new Timer { Interval = 3000 };
                timer.Tick += (s, t) => window.Close();
                timer.Start();
            };
        }

        Application.Run(window);
    }
` + CS_SELFTEST_FN('dotnet/window') + '}\n',
      'App.csproj': CSPROJ('WinExe', 'net$(BundledNETCoreAppTargetFrameworkVersion)-windows', '\n    <UseWindowsForms>true</UseWindowsForms>'),
    },
    launch: '{runtime} {app_dir}/bin/App.dll',
    console: false,
    platforms: ['windows'],
    title: 'My App',
    note: 'Windows Forms is Windows only, so this template builds for Windows only.',
  },
};

/* ---------- R ---------- */

const R_SELFTEST = (what, indent) => code`# Used by the site's tests to check this template works; safe to delete.
selftest_ok <- function() {
  cat("template ok: WHAT\n")
  out <- Sys.getenv("IB_TEMPLATE_SELFTEST_OUT")
  if (out != "") writeLines("template ok: WHAT", out)
}
`.replace(/WHAT/g, what);

const r = {
  script: {
    label: '',
    files: {
      'main.R': R_SELFTEST('r/script') + code`if (Sys.getenv("IB_TEMPLATE_SELFTEST") == "1") {
  selftest_ok()
  quit(status = 0)
}

input <- file("stdin")
open(input)

cat("What's your name? ")
name <- readLines(input, n = 1)
cat("Hello, ", name, "!\n", sep = "")

cat("Press Enter to close")
invisible(readLines(input, n = 1))
`,
    },
    console: true,
    platforms: ALL,
  },
  window: {
    label: 'tcltk',
    files: {
      'main.R': code`library(tcltk)

window <- tktoplevel()
tkwm.title(window, "My App")

label <- tklabel(window, text = "Hello!", font = "Helvetica 18")
tkpack(label, padx = 40, pady = 20)

button <- tkbutton(window, text = "Click me",
                   command = function() tkconfigure(label, text = "You clicked the button"))
tkpack(button, pady = c(0, 20))

` + R_SELFTEST('r/window') + code`if (Sys.getenv("IB_TEMPLATE_SELFTEST") == "1") {
  tcl("after", 1000, selftest_ok)                          # once the window is up
  tcl("after", 4000, function() tkdestroy(window))
}

# Rscript would stop at the end of the file: wait until the window is closed.
tkwait.window(window)
`,
    },
    console: false,
    platforms: ['windows', 'linux'],
    title: 'My App',
    note: 'tcltk comes with R for Windows. On Linux, R\'s tcltk uses the system\'s Tk (the libtk8.6 package); ' +
      'on macOS it needs XQuartz, so this template doesn\'t build for macOS.',
  },
};

/* ---------- Go ---------- */

const GO_MOD = 'module app\n\ngo 1.20\n';
const GO_SELFTEST_FN = (what) => code`
// Used by the site's tests to check this template works; safe to delete.
func selftestOk() {
	fmt.Println("template ok: WHAT")
	if file := os.Getenv("IB_TEMPLATE_SELFTEST_OUT"); file != "" {
		ioutil.WriteFile(file, []byte("template ok: WHAT\n"), 0644)
	}
}
`.replace(/WHAT/g, what);

// Go 1.10 syntax and library (Windows XP and Vista get Go 1.10): no
// generics, io/ioutil rather than os.ReadFile.
const go = {
  script: {
    label: '',
    files: {
      'main.go': code`package main

import (
	"bufio"
	"fmt"
	"io/ioutil"
	"os"
	"strings"
)

func main() {
	if os.Getenv("IB_TEMPLATE_SELFTEST") == "1" {
		selftestOk()
		return
	}
	in := bufio.NewReader(os.Stdin)
	fmt.Print("What's your name? ")
	name, _ := in.ReadString('\n')
	fmt.Printf("Hello, %s!\n", strings.TrimSpace(name))

	fmt.Print("Press Enter to close")
	in.ReadString('\n')
}
` + GO_SELFTEST_FN('go/script'),
      'go.mod': GO_MOD,
    },
    launch: '{app_dir}/{project}{exe}',
    console: true,
    platforms: ALL,
    note: 'Built with the Go toolchain when the app is installed.',
  },
  web: {
    label: 'net/http',
    files: {
      'main.go': code`package main

import (
	"fmt"
	"io/ioutil"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(appFolder(), "index.html"))
	})
	http.HandleFunc("/api/greet", func(w http.ResponseWriter, r *http.Request) {
		// Your app's logic: the page asks, Go answers.
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintf(w, "Hello, %s!", r.URL.Query().Get("name"))
	})

	listener, err := net.Listen("tcp", "127.0.0.1:0") // port 0: any free port
	if err != nil {
		fmt.Println("Can't start the web server:", err)
		os.Exit(1)
	}
	url := "http://" + listener.Addr().String() + "/"
	fmt.Println("My App is running at " + url)
	fmt.Println("Close this window to stop it.")
	if os.Getenv("IB_TEMPLATE_SELFTEST") == "1" {
		go selftest(url)
	} else {
		openBrowser(url)
	}
	http.Serve(listener, nil)
}

// The folder the program is in, where index.html is.
func appFolder() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

// Opens the page in the default browser.
func openBrowser(url string) {
	var err error
	switch runtime.GOOS {
	case "windows":
		err = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		err = exec.Command("open", url).Start()
	default:
		err = exec.Command("xdg-open", url).Start()
	}
	if err != nil {
		fmt.Println("Open " + url + " in your browser.")
	}
}

func get(url string) string {
	response, err := http.Get(url)
	if err != nil {
		return ""
	}
	defer response.Body.Close()
	body, _ := ioutil.ReadAll(response.Body)
	return string(body)
}

func selftest(url string) {
	if strings.Contains(get(url), "Greet") && get(url+"api/greet?name=test") == "Hello, test!" {
		selftestOk()
	}
	os.Exit(0)
}
` + GO_SELFTEST_FN('go/web'),
      'go.mod': GO_MOD,
      'index.html': WEB_PAGE,
    },
    launch: '{app_dir}/{project}{exe}',
    console: true,
    platforms: ALL,
    note: WEB_NOTE + ' Only Go\'s own packages: nothing to download.',
  },
};

/* ---------- Rust ---------- */

// The package is "app", so the program is target/release/app.
const CARGO_TOML = '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n';
// `cargo build --locked` needs a lock file; this is the one for no dependencies.
const CARGO_LOCK = '# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 3\n\n[[package]]\nname = "app"\nversion = "0.1.0"\n';
const RUST_SELFTEST_FN = (what) => code`
// Used by the site's tests to check this template works; safe to delete.
fn selftest_ok() {
    println!("template ok: WHAT");
    if let Ok(file) = std::env::var("IB_TEMPLATE_SELFTEST_OUT") {
        std::fs::write(file, "template ok: WHAT\n").ok();
    }
}
`.replace(/WHAT/g, what);

const rust = {
  script: {
    label: '',
    files: {
      'src/main.rs': code`use std::io::{self, BufRead, Write};

fn main() {
    if std::env::var("IB_TEMPLATE_SELFTEST").as_deref() == Ok("1") {
        selftest_ok();
        return;
    }
    let stdin = io::stdin();
    let mut name = String::new();
    print!("What's your name? ");
    io::stdout().flush().unwrap();
    stdin.lock().read_line(&mut name).unwrap();
    println!("Hello, {}!", name.trim());

    print!("Press Enter to close");
    io::stdout().flush().unwrap();
    stdin.lock().read_line(&mut String::new()).unwrap();
}
` + RUST_SELFTEST_FN('rust/script'),
      'Cargo.toml': CARGO_TOML,
      'Cargo.lock': CARGO_LOCK,
    },
    launch: '{app_dir}/target/release/app{exe}',
    console: true,
    platforms: ALL,
    note: 'Built with cargo when the app is installed. On Linux, Rust links with the system\'s C compiler, ' +
      'which the installer asks to install if it\'s missing.',
  },
  web: {
    label: 'std::net',
    files: {
      'src/main.rs': code`use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::thread;

// The page, built into the program.
const PAGE: &str = include_str!("../index.html");

fn main() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("can't start the web server"); // port 0: any free port
    let url = format!("http://{}/", listener.local_addr().unwrap());
    println!("My App is running at {}", url);
    println!("Close this window to stop it.");
    if std::env::var("IB_TEMPLATE_SELFTEST").as_deref() == Ok("1") {
        let address = url.clone();
        thread::spawn(move || selftest(&address));
    } else {
        open_browser(&url);
    }
    for stream in listener.incoming().flatten() {
        answer(stream);
    }
}

// One request: the page, or the app's logic at /api/greet.
fn answer(mut stream: TcpStream) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut request = String::new();
    reader.read_line(&mut request).ok();
    let mut header = String::new();
    while reader.read_line(&mut header).unwrap_or(0) > 2 {
        header.clear();
    }
    let path = request.split_whitespace().nth(1).unwrap_or("/");
    let (status, kind, body) = if path == "/" {
        ("200 OK", "text/html", PAGE.to_string())
    } else if let Some(name) = path.strip_prefix("/api/greet?name=") {
        // Your app's logic: the page asks, Rust answers.
        ("200 OK", "text/plain", format!("Hello, {}!", decode(name)))
    } else {
        ("404 Not Found", "text/plain", "Not found".to_string())
    };
    let head = format!("HTTP/1.1 {}\r\nContent-Type: {}; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                       status, kind, body.len());
    stream.write_all(head.as_bytes()).ok();
    stream.write_all(body.as_bytes()).ok();
}

// "S%C3%A9bastien+Doe" -> "Sébastien Doe"
fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(b) => {
                        out.push(b);
                        i += 2;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// Opens the page in the default browser.
fn open_browser(url: &str) {
    let started = if cfg!(windows) {
        Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn()
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(url).spawn()
    } else {
        Command::new("xdg-open").arg(url).spawn()
    };
    if started.is_err() {
        println!("Open {} in your browser.", url);
    }
}

fn get(url: &str) -> String {
    let rest = url.trim_start_matches("http://");
    let (host, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    let mut stream = match TcpStream::connect(host) {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    write!(stream, "GET {} HTTP/1.0\r\nHost: {}\r\n\r\n", path, host).ok();
    let mut reply = String::new();
    stream.read_to_string(&mut reply).ok();
    reply.split("\r\n\r\n").nth(1).unwrap_or("").to_string()
}

fn selftest(url: &str) {
    if get(url).contains("Greet") && get(&format!("{}api/greet?name=test", url)) == "Hello, test!" {
        selftest_ok();
    }
    std::process::exit(0);
}
` + RUST_SELFTEST_FN('rust/web'),
      'index.html': WEB_PAGE,
      'Cargo.toml': CARGO_TOML,
      'Cargo.lock': CARGO_LOCK,
    },
    launch: '{app_dir}/target/release/app{exe}',
    console: true,
    platforms: ALL,
    note: WEB_NOTE + ' Only Rust\'s standard library: no crates to download.',
  },
};

/* ---------- Zig ---------- */

const zig = {
  script: {
    label: '',
    files: {
      'main.zig': code`// Zig 0.16: its standard library changes a lot between versions, and this
// is written for 0.16's (std.Io). The installer picks a 0.16 release.
const std = @import("std");

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    var out_buffer: [1024]u8 = undefined;
    var stdout = std.Io.File.stdout().writer(io, &out_buffer);
    const out = &stdout.interface;

    // Used by the site's tests to check this template works; safe to delete.
    if (init.environ_map.get("IB_TEMPLATE_SELFTEST")) |value| {
        if (std.mem.eql(u8, value, "1")) {
            try out.writeAll("template ok: zig/script\n");
            try out.flush();
            if (init.environ_map.get("IB_TEMPLATE_SELFTEST_OUT")) |file| {
                try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = file, .data = "template ok: zig/script\n" });
            }
            return;
        }
    }

    var in_buffer: [1024]u8 = undefined;
    var stdin = std.Io.File.stdin().reader(io, &in_buffer);
    const in = &stdin.interface;

    try out.writeAll("What's your name? ");
    try out.flush();
    const line = (try in.takeDelimiter('\n')) orelse "";
    const name = std.mem.trimEnd(u8, line, "\r");
    try out.print("Hello, {s}!\n", .{name});

    try out.writeAll("Press Enter to close");
    try out.flush();
    _ = try in.takeDelimiter('\n');
}
`,
    },
    launch: '{app_dir}/{project}{exe}',
    versions: '>=0.16,<0.17',
    console: true,
    platforms: ALL,
    note: 'Built with Zig 0.16 when the app is installed (the catalogue has it for Windows 10 and 11, current Linux and macOS 13+). ' +
      'Zig\'s standard library changes between versions, so the installer asks for 0.16.',
  },
};

/* ---------- Nim ---------- */

const NIM_SELFTEST_FN = (what) => code`
# Used by the site's tests to check this template works; safe to delete.
proc selftestOk() =
  echo "template ok: WHAT"
  let file = getEnv("IB_TEMPLATE_SELFTEST_OUT")
  if file != "":
    writeFile(file, "template ok: WHAT\n")
`.replace(/WHAT/g, what);

const nim = {
  script: {
    label: '',
    files: {
      'main.nim': code`import os, strutils
` + NIM_SELFTEST_FN('nim/script') + code`
if getEnv("IB_TEMPLATE_SELFTEST") == "1":
  selftestOk()
  quit(0)

stdout.write "What's your name? "
stdout.flushFile()
let name = stdin.readLine().strip()
echo "Hello, ", name, "!"

stdout.write "Press Enter to close"
stdout.flushFile()
discard stdin.readLine()
`,
    },
    launch: '{app_dir}/{project}{exe}',
    console: true,
    platforms: ALL,
    note: 'Built with the Nim compiler (and a C compiler) when the app is installed.',
  },
  web: {
    label: 'asynchttpserver',
    files: {
      'main.nim': code`import asyncdispatch, asynchttpserver, browsers, cgi, httpclient, net, os, strutils

const page = staticRead("index.html")   # the page, built into the program

proc answer(request: Request) {.async, gcsafe.} =
  if request.url.path == "/":
    await request.respond(Http200, page, newHttpHeaders({"Content-Type": "text/html; charset=utf-8"}))
  elif request.url.path == "/api/greet":
    # Your app's logic: the page asks, Nim answers.
    var name = ""
    for key, value in decodeData(request.url.query):
      if key == "name": name = value
    await request.respond(Http200, "Hello, " & name & "!", newHttpHeaders({"Content-Type": "text/plain; charset=utf-8"}))
  else:
    await request.respond(Http404, "Not found")

# Any free port on this computer.
proc freePort(): Port =
  let probe = newSocket()
  probe.bindAddr(Port(0), "127.0.0.1")
  result = probe.getLocalAddr()[1]
  probe.close()
` + NIM_SELFTEST_FN('nim/web') + code`
proc selftest(url: string) {.async.} =
  let client = newAsyncHttpClient()
  let body = await client.getContent(url)
  let greeting = await client.getContent(url & "api/greet?name=test")
  if "Greet" in body and greeting == "Hello, test!":
    selftestOk()
  quit(0)

let port = freePort()
let url = "http://127.0.0.1:" & $port & "/"
echo "My App is running at ", url
echo "Close this window to stop it."
asyncCheck newAsyncHttpServer().serve(port, answer, "127.0.0.1")
if getEnv("IB_TEMPLATE_SELFTEST") == "1":
  asyncCheck selftest(url)
else:
  openDefaultBrowser(url)
runForever()
`,
      'index.html': WEB_PAGE,
    },
    launch: '{app_dir}/{project}{exe}',
    console: true,
    platforms: ALL,
    note: WEB_NOTE + ' Only Nim\'s standard library: no packages to download.',
  },
};

/* ---------- C and C++ ---------- */

const cc = {
  script: {
    label: 'C',
    files: {
      'main.c': code`#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Used by the site's tests to check this template works; safe to delete. */
static int selftest(void)
{
    const char *on = getenv("IB_TEMPLATE_SELFTEST");
    const char *file = getenv("IB_TEMPLATE_SELFTEST_OUT");
    FILE *out;
    if (!on || strcmp(on, "1") != 0) return 0;
    puts("template ok: cc/script");
    if (file && *file && (out = fopen(file, "w")) != NULL) {
        fputs("template ok: cc/script\n", out);
        fclose(out);
    }
    return 1;
}

int main(void)
{
    char name[100];
    if (selftest()) return 0;

    printf("What's your name? ");
    fflush(stdout);
    if (!fgets(name, sizeof name, stdin)) name[0] = '\0';
    name[strcspn(name, "\r\n")] = '\0';
    printf("Hello, %s!\n", name);

    printf("Press Enter to close");
    fflush(stdout);
    getchar();
    return 0;
}
`,
    },
    launch: '{app_dir}/{project}{exe}',
    console: true,
    platforms: ALL,
    note: 'Compiled when the app is installed: GCC (MinGW-w64) on Windows, zig cc on Linux and macOS.',
  },
  cpp: {
    label: 'C++',
    files: {
      'main.cpp': code`#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>

// Used by the site's tests to check this template works; safe to delete.
static bool selftest()
{
    const char *on = std::getenv("IB_TEMPLATE_SELFTEST");
    const char *file = std::getenv("IB_TEMPLATE_SELFTEST_OUT");
    if (!on || std::string(on) != "1") return false;
    std::cout << "template ok: cc/cpp" << std::endl;
    if (file && *file) std::ofstream(file) << "template ok: cc/cpp\n";
    return true;
}

int main()
{
    if (selftest()) return 0;

    std::string name;
    std::cout << "What's your name? " << std::flush;
    std::getline(std::cin, name);
    std::cout << "Hello, " << name << "!" << std::endl;

    std::cout << "Press Enter to close" << std::flush;
    std::getline(std::cin, name);
    return 0;
}
`,
    },
    launch: '{app_dir}/{project}{exe}',
    console: true,
    platforms: ALL,
    note: 'Compiled when the app is installed: g++ (MinGW-w64) on Windows, zig c++ on Linux and macOS.',
  },
};

export const TEMPLATES = { python, python2, node, ruby, php, java, dotnet, r, go, rust, zig, nim, cc };

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// The template, or null.
export function templateFor(runtime, template) {
  return own(TEMPLATES, runtime) && own(TEMPLATES[runtime], template) ? TEMPLATES[runtime][template] : null;
}

// The form field (a <textarea>) holding one of a template's files: the first
// file is code_<runtime>_<template>, the others add their name
// (code_python_web_index_html).
export function fieldName(runtime, template, file, index) {
  return 'code_' + runtime + '_' + template + (index ? '_' + file.replace(/[^A-Za-z0-9]+/g, '_') : '');
}

// {field name: file name} for a template, in its files' order.
export function templateFields(runtime, template) {
  const t = templateFor(runtime, template);
  if (!t) return null;
  const out = {};
  Object.keys(t.files).forEach((f, i) => { out[fieldName(runtime, template, f, i)] = f; });
  return out;
}

// The launch command a written app starts with: the template's, or the
// runtime running its first file.
export function templateLaunch(runtime, template) {
  const t = templateFor(runtime, template);
  if (!t) return '';
  return t.launch || '{runtime} {app_dir}/' + Object.keys(t.files)[0];
}

const PLATFORM_LABELS = { windows: 'Windows', linux: 'Linux', macos: 'macOS' };

// A sentence when a template can't work on some of `platforms`, or ''.
export function platformProblem(runtime, template, platforms) {
  const t = templateFor(runtime, template);
  if (!t || !t.platforms) return '';
  const bad = platforms.filter((p) => t.platforms.indexOf(p) < 0);
  if (!bad.length) return '';
  const names = bad.map((p) => PLATFORM_LABELS[p] || p);
  return 'This template doesn\'t work on ' + names.join(' or ') + '. Untick ' + names.join(' and ') + ' under "Build for".';
}
