<?php
// Fidelity check: Composer installed this project's packages (docs/test-results.md, "Real-app fidelity").
echo "FID start php " . PHP_VERSION . "\n";
$auto = __DIR__ . '/vendor/autoload.php';
if (!is_file($auto)) {
    echo "FID fail composer-install: no vendor/autoload.php\n";
} else {
    require $auto;
    $ok = interface_exists('Psr\Log\LoggerInterface') && function_exists('ctype_alpha');
    echo $ok ? "FID ok composer-install: psr/log and symfony/polyfill-ctype load\n" : "FID fail composer-install: classes missing\n";
    $lock = json_decode(file_get_contents(__DIR__ . '/composer.lock'), true);
    foreach ($lock['packages'] as $p) echo "FID info package {$p['name']} {$p['version']}\n";
}
echo "FID end\n";
