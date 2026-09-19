# Fidelity check: what real Ruby apps rely on (docs/test-results.md, "Real-app fidelity").
# Prints one "FID <ok|fail|skip> <check>[: detail]" line per check, then "FID end".
$stdout.sync = true

def check(name)
  detail = yield
  puts "FID ok #{name}#{detail ? ": #{detail}" : ''}"
rescue Exception => e # rubocop:disable Lint/RescueException - LoadError too
  puts "FID fail #{name}: #{e.class}: #{e.message.to_s.gsub(/\s+/, ' ')[0, 300]}"
end

puts "FID start ruby #{RUBY_VERSION} #{RUBY_PLATFORM}"

check('gem-bcrypt') do
  require 'bcrypt'
  h = BCrypt::Password.create('secret', cost: 4)
  raise 'bcrypt mismatch' unless BCrypt::Password.new(h) == 'secret'
  "bcrypt #{Gem.loaded_specs['bcrypt']&.version}"
end

check('gem-json-ext') do
  require 'json'
  raise "not the C parser: #{JSON::Parser}" unless JSON::Parser.name.include?('Ext')
  raise 'round trip' unless JSON.parse(JSON.generate('a' => [1, 2])) == { 'a' => [1, 2] }
  "json #{JSON::VERSION}"
end

check('openssl-https') do
  require 'net/http'
  require 'openssl'
  res = Net::HTTP.get_response(URI('https://rubygems.org/api/v1/gems/rake.json'))
  raise "HTTP #{res.code}" unless res.code == '200'
  OpenSSL::OPENSSL_LIBRARY_VERSION
end

check('readline') do
  require 'readline'
  defined?(Readline::VERSION) ? "Readline #{Readline::VERSION}" : 'loaded'
end

check('stdlib') do
  missing = []
  %w[zlib psych yaml digest socket io/console etc fiddle stringio date bigdecimal ripper objspace
     pathname strscan securerandom tempfile monitor coverage].each do |lib|
    begin
      require lib
    rescue LoadError => e
      missing << "#{lib} (#{e.message})"
    end
  end
  raise "missing: #{missing.join(', ')}" unless missing.empty?
  Zlib::Deflate.deflate('x' * 100)
  YAML.safe_load("a: [1, 2]")
  'ok'
end

check('fiddle') do
  require 'fiddle'
  if Gem.win_platform?
    k = Fiddle.dlopen('kernel32')
    f = Fiddle::Function.new(k['GetTickCount'], [], Fiddle::TYPE_INT)
    "GetTickCount #{f.call}"
  else
    f = Fiddle::Function.new(Fiddle::Handle::DEFAULT['getpid'], [], Fiddle::TYPE_INT)
    "getpid #{f.call}"
  end
end

check('gem-command') do
  out = IO.popen([RbConfig.ruby, File.join(RbConfig::CONFIG['bindir'], 'gem'), '--version'], err: [:child, :out], &:read)
  raise out.strip unless $?.success?
  "gem #{out.strip}"
end

puts 'FID end'
