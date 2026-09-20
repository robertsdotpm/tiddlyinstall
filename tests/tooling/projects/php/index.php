<?php
// Checks Composer, for every PHP the catalogue can install (4.4 upwards),
// so PHP 4 syntax only: no namespaces, no closures, no short array syntax.
function say($state, $name, $detail) {
    echo "TOOL " . $state . " " . $name . ": " . $detail . "\n";
}

$auto = dirname(__FILE__) . "/vendor/autoload.php";
if (file_exists($auto)) {
    include $auto;
    if (class_exists("Psr\\Log\\NullLogger")) {
        say("ok", "composer-install", "psr/log 1.1.4 autoloaded");
    } else {
        say("fail", "composer-install", "vendor/autoload.php has no psr/log");
    }
} else if (version_compare(phpversion(), "5.3.0", "<")) {
    // Composer itself needs PHP 5.3, so the policy ships no composer.phar
    // for older PHP and the install rule never runs.
    say("skip", "composer-install", "Composer needs PHP 5.3; this is " . phpversion());
} else {
    say("fail", "composer-install", "no vendor/autoload.php: composer install did not run");
}

$phar = getenv("IB_COMPOSER_PHAR");
if ($phar && file_exists($phar)) {
    say("ok", "composer-phar", "composer.phar is beside the runtime");
} else {
    say("skip", "composer-phar", "composer.phar is only shipped for apps that install something");
}

say("ok", "stdlib", "json " . (function_exists("json_encode") ? "yes" : "no") .
    ", openssl " . (function_exists("openssl_encrypt") ? "yes" : "no") .
    ", curl " . (function_exists("curl_init") ? "yes" : "no"));

echo "TOOL runtime php " . phpversion() . "\n";
echo "TOOL end\n";
