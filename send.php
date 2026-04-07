<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

// ── Nur POST erlauben ────────────────────────────────────────────────────────
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

// ── E-Mail senden ────────────────────────────────────────────────────────────
$to      = 'info@strohhalmwerk.de';
$headers = implode("\r\n", [
    'From: info@strohhalmwerk.de',
    'Reply-To: ' . $email,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
]);

$mailSubject = '=?UTF-8?B?' . base64_encode("Kontaktformular: $subject") . '?=';

$body  = "Neue Nachricht über das Kontaktformular\n";
$body .= "========================================\n\n";
$body .= "Name:    $name\n";
$body .= "E-Mail:  $email\n";
$body .= "Betreff: $subject\n\n";
$body .= "Nachricht:\n$message\n";

$success = mail($to, $mailSubject, chunk_split(base64_encode($body)), $headers);

if ($success) {
    echo json_encode(['ok' => true]);
} else {
    http_response_code(500);
    echo json_encode(['error' => 'E-Mail konnte nicht gesendet werden']);
}
