<?php
// Fidelity check: what real PHP apps rely on (docs/test-results.md, "Real-app fidelity").
// Prints one "FID <ok|fail|skip> <check>[: detail]" line per check, then "FID end".
// Written for PHP 7.0 and later.

function check($name, $fn)
{
    try {
        $d = $fn();
        echo "FID ok $name" . ($d !== null && $d !== '' ? ": $d" : '') . "\n";
    } catch (Throwable $e) {
        $m = substr(preg_replace('/\s+/', ' ', $e->getMessage()), 0, 300);
        echo "FID fail $name: " . get_class($e) . ": $m\n";
    }
}

function need($ext)
{
    if (!extension_loaded($ext)) {
        throw new RuntimeException("extension $ext is not loaded");
    }
}

set_error_handler(function ($no, $str, $file, $line) {
    throw new ErrorException($str, 0, $no, $file, $line);
});

echo "FID start php " . PHP_VERSION . " " . PHP_OS . "\n";

check('mbstring', function () {
    need('mbstring');
    if (mb_strtoupper('ärger') !== 'ÄRGER') throw new RuntimeException('mb_strtoupper');
    return mb_strlen('日本語') . ' chars';
});
check('pdo_sqlite', function () {
    need('pdo_sqlite');
    $db = new PDO('sqlite::memory:');
    $db->exec('create table t (a int)');
    $db->exec('insert into t values (42)');
    return 'sqlite ' . $db->query('select sqlite_version()')->fetchColumn();
});
check('curl-https', function () {
    need('curl');
    $c = curl_init('https://repo.packagist.org/packages.json');
    curl_setopt($c, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($c, CURLOPT_TIMEOUT, 60);
    $body = curl_exec($c);
    if ($body === false) throw new RuntimeException(curl_error($c));
    $code = curl_getinfo($c, CURLINFO_HTTP_CODE);
    if ($code != 200) throw new RuntimeException("HTTP $code");
    return curl_version()['version'] . ' ' . curl_version()['ssl_version'];
});
check('openssl-https', function () {
    need('openssl');
    $body = file_get_contents('https://repo.packagist.org/packages.json');
    if (strlen($body) < 10) throw new RuntimeException('short answer');
    return OPENSSL_VERSION_TEXT;
});
check('gd', function () {
    need('gd');
    $im = imagecreatetruecolor(8, 8);
    imagefilledrectangle($im, 0, 0, 7, 7, imagecolorallocate($im, 255, 0, 0));
    ob_start();
    imagepng($im);
    $png = ob_get_clean();
    if (substr($png, 1, 3) !== 'PNG') throw new RuntimeException('no PNG');
    $i = gd_info();
    return $i['GD Version'] . (empty($i['FreeType Support']) ? ', no FreeType' : ', FreeType')
        . (empty($i['JPEG Support']) ? ', no JPEG' : ', JPEG');
});
check('intl', function () {
    need('intl');
    $f = new NumberFormatter('de_DE', NumberFormatter::DECIMAL);
    $s = $f->format(1234.5);
    if ($s !== '1.234,5') throw new RuntimeException("de_DE gave $s");
    return 'ICU ' . INTL_ICU_VERSION;
});
check('zip', function () {
    need('zip');
    $p = tempnam(sys_get_temp_dir(), 'fid');
    $z = new ZipArchive();
    if ($z->open($p, ZipArchive::OVERWRITE) !== true) throw new RuntimeException('open');
    $z->addFromString('a.txt', 'hello');
    $z->close();
    $z->open($p);
    $got = $z->getFromName('a.txt');
    $z->close();
    unlink($p);
    if ($got !== 'hello') throw new RuntimeException('read back');
    return 'libzip ' . (defined('ZipArchive::LIBZIP_VERSION') ? ZipArchive::LIBZIP_VERSION : '?');
});
check('xml', function () {
    foreach (['xml', 'dom', 'simplexml', 'xmlreader', 'xmlwriter', 'libxml'] as $e) need($e);
    $x = simplexml_load_string('<a><b>1</b></a>');
    $d = new DOMDocument();
    $d->loadXML('<a/>');
    return 'libxml ' . LIBXML_DOTTED_VERSION;
});
check('json', function () {
    need('json');
    return json_encode(json_decode('{"a":[1,2]}', true));
});
check('common', function () {
    $missing = [];
    foreach (['ctype', 'fileinfo', 'filter', 'hash', 'iconv', 'pcre', 'session', 'sodium', 'tokenizer',
              'pdo', 'sqlite3', 'phar', 'bcmath', 'exif', 'sockets'] as $e) {
        if (!extension_loaded($e)) $missing[] = $e;
    }
    if ($missing) throw new RuntimeException('not loaded: ' . implode(', ', $missing));
    return count(get_loaded_extensions()) . ' extensions';
});
echo "FID end\n";
