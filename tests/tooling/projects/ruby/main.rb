# Checks RubyGems and bundler, for every Ruby the catalogue can install
# (1.8 upwards), so 1.8-compatible syntax only: no 1.9 hash literals.
def say(state, name, detail)
  puts "TOOL #{state} #{name}: #{detail}"
end

def check(name)
  say("ok", name, yield)
rescue SkipIt => e
  say("skip", name, e.message)
rescue Exception => e
  say("fail", name, "#{e.class}: #{e.message.to_s[0, 200]}")
end

class SkipIt < StandardError; end

def run(*args)
  out = IO.popen(args.join(" ") + " 2>&1") { |io| io.read }
  raise "exit #{$?.exitstatus}: #{out.split.join(' ')[-200, 200]}" unless $?.exitstatus == 0
  out.split.join(" ")[0, 120]
end

RB = File.join(RbConfig::CONFIG["bindir"], RbConfig::CONFIG["ruby_install_name"])

check("bundle-install") do
  require "tilt"
  "tilt #{Tilt::VERSION} from the install step"
end

check("gem-command") do
  gem_bin = File.join(RbConfig::CONFIG["bindir"], "gem")
  raise SkipIt.new("no gem beside this ruby") unless File.exist?(gem_bin)
  "gem " + run("\"#{RB}\"", "\"#{gem_bin}\"", "--version")
end

check("bundler-command") do
  b = File.join(RbConfig::CONFIG["bindir"], "bundle")
  raise SkipIt.new("bundler ships with Ruby from 2.6") unless File.exist?(b)
  "bundler " + run("\"#{RB}\"", "\"#{b}\"", "--version")
end

check("stdlib") do
  require "json"
  require "openssl"
  JSON.generate({"a" => 1})
  OpenSSL::OPENSSL_VERSION
end

puts "TOOL runtime ruby #{RUBY_VERSION}"
puts "TOOL end"
