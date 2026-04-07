<?php
declare(strict_types=1);

// ── .env laden ──────────────────────────────────────────────────────────────
function loadEnv(string $path): void {
    if (!file_exists($path)) return;
    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#')) continue;
        [$key, $value] = explode('=', $line, 2);
        $_ENV[trim($key)] = trim($value);
    }
}

loadEnv(__DIR__ . '/.env');

// ── Nur POST erlauben ────────────────────────────────────────────────────────
header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

// ── Eingaben validieren ──────────────────────────────────────────────────────
$name    = strip_tags(trim($_POST['name']    ?? ''));
$email   = filter_var(trim($_POST['email']   ?? ''), FILTER_VALIDATE_EMAIL);
$subject = strip_tags(trim($_POST['subject'] ?? ''));
$message = strip_tags(trim($_POST['message'] ?? ''));

if (!$name || !$email || !$subject) {
    http_response_code(400);
    echo json_encode(['error' => 'Pflichtfelder fehlen']);
    exit;
}

// ── SMTP-Konfiguration aus .env ──────────────────────────────────────────────
$smtpHost = $_ENV['SMTP_HOST'] ?? '';
$smtpPort = (int)($_ENV['SMTP_PORT'] ?? 587);
$smtpUser = $_ENV['SMTP_USER'] ?? '';
$smtpPass = $_ENV['SMTP_PASS'] ?? '';
$mailFrom = $_ENV['SMTP_FROM'] ?? $smtpUser;
$mailTo   = $_ENV['SMTP_TO']   ?? $smtpUser;

// ── E-Mail senden via SMTP + STARTTLS ────────────────────────────────────────
function smtpSend(
    string $host, int $port,
    string $user, string $pass,
    string $from, string $to,
    string $subject, string $body,
    string $replyTo
): true|string {

    $socket = @fsockopen($host, $port, $errno, $errstr, 10);
    if (!$socket) {
        return "Verbindung zu $host:$port fehlgeschlagen: $errstr ($errno)";
    }

    $read = static function () use ($socket): string {
        $buf = '';
        while ($line = fgets($socket, 512)) {
            $buf .= $line;
            if (isset($line[3]) && $line[3] === ' ') break;
        }
        return $buf;
    };

    $cmd = static function (string $command) use ($socket, $read): string {
        fwrite($socket, $command . "\r\n");
        return $read();
    };

    $read(); // Server-Greeting

    $cmd('EHLO ' . (gethostname() ?: 'localhost'));
    $cmd('STARTTLS');

    if (!stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
        fclose($socket);
        return 'TLS-Aushandlung fehlgeschlagen';
    }

    $cmd('EHLO ' . (gethostname() ?: 'localhost'));
    $cmd('AUTH LOGIN');
    $cmd(base64_encode($user));
    $authResp = $cmd(base64_encode($pass));

    if (!str_starts_with($authResp, '235')) {
        fclose($socket);
        return 'SMTP-Authentifizierung fehlgeschlagen';
    }

    $cmd("MAIL FROM:<$from>");
    $cmd("RCPT TO:<$to>");
    $cmd('DATA');

    $encodedSubject = '=?UTF-8?B?' . base64_encode($subject) . '?=';
    $headers  = "From: $from\r\n";
    $headers .= "To: $to\r\n";
    $headers .= "Reply-To: $replyTo\r\n";
    $headers .= "Subject: $encodedSubject\r\n";
    $headers .= "MIME-Version: 1.0\r\n";
    $headers .= "Content-Type: text/plain; charset=UTF-8\r\n";
    $headers .= "Content-Transfer-Encoding: base64\r\n";

    $encodedBody = chunk_split(base64_encode($body));

    fwrite($socket, $headers . "\r\n" . $encodedBody . "\r\n.\r\n");
    $read();
    $cmd('QUIT');
    fclose($socket);

    return true;
}

$mailBody  = "Neue Nachricht über das Kontaktformular\n";
$mailBody .= "========================================\n\n";
$mailBody .= "Name:    $name\n";
$mailBody .= "E-Mail:  $email\n";
$mailBody .= "Betreff: $subject\n\n";
$mailBody .= "Nachricht:\n$message\n";

$result = smtpSend(
    $smtpHost, $smtpPort,
    $smtpUser, $smtpPass,
    $mailFrom, $mailTo,
    "Kontaktformular: $subject",
    $mailBody,
    $email
);

if ($result === true) {
    echo json_encode(['ok' => true]);
} else {
    http_response_code(500);
    echo json_encode(['error' => $result]);
}
