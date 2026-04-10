const fs = require('fs');
const path = require('path');
const ftp = require('basic-ftp');

const INSTAGRAM_FOLDER = path.join(__dirname, 'Instagram');
const POSTED_FOLDER = path.join(INSTAGRAM_FOLDER, 'gepostet');
const WEBSITE_URL = 'https://strohhalmwerk.de';
const FTP_TEMP_PATH = '/html/instagram-temp';

async function refreshToken(accessToken) {
  const url = `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${accessToken}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.access_token) {
    console.log('Token erneuert.');
    return data.access_token;
  }
  return accessToken;
}

async function checkTokenExpiry(accessToken) {
  const url = `https://graph.instagram.com/access_token?grant_type=ig_refresh_token&access_token=${accessToken}`;
  const res = await fetch(url);
  const data = await res.json();
  const expiresIn = data.expires_in;
  if (!expiresIn) return accessToken;

  const daysLeft = expiresIn / 86400;
  console.log(`Token läuft in ${Math.round(daysLeft)} Tagen ab.`);

  if (daysLeft < 7) {
    console.log('Token läuft bald ab – erneuere automatisch...');
    return await refreshToken(accessToken);
  }
  return accessToken;
}

async function uploadToFTP(localPath, filename) {
  const client = new ftp.Client();
  try {
    await client.access({
      host: process.env.FTP_HOST,
      user: process.env.FTP_USER,
      password: process.env.FTP_PASS,
      secure: true,
      secureOptions: { rejectUnauthorized: false },
    });
    await client.ensureDir(FTP_TEMP_PATH);
    await client.uploadFrom(localPath, filename);
    console.log('Bild hochgeladen:', filename);
  } finally {
    client.close();
  }
  return `${WEBSITE_URL}/instagram-temp/${encodeURIComponent(filename)}`;
}

async function deleteFromFTP(filename) {
  const client = new ftp.Client();
  try {
    await client.access({
      host: process.env.FTP_HOST,
      user: process.env.FTP_USER,
      password: process.env.FTP_PASS,
      secure: true,
      secureOptions: { rejectUnauthorized: false },
    });
    await client.remove(`${FTP_TEMP_PATH}/${filename}`);
    console.log('Bild vom Server gelöscht:', filename);
  } catch (e) {
    console.error('Fehler beim Löschen vom FTP:', e.message);
  } finally {
    client.close();
  }
}

async function createMediaContainer(imageUrl, caption, accessToken, userId) {
  const res = await fetch(`https://graph.instagram.com/v21.0/${userId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: imageUrl, caption, access_token: accessToken }),
  });
  const data = await res.json();
  if (!data.id) throw new Error('Container-Erstellung fehlgeschlagen: ' + JSON.stringify(data));
  return data.id;
}

async function waitForContainer(containerId, accessToken) {
  for (let i = 0; i < 12; i++) {
    const res = await fetch(
      `https://graph.instagram.com/v21.0/${containerId}?fields=status_code&access_token=${accessToken}`
    );
    const data = await res.json();
    if (data.status_code === 'FINISHED') return;
    if (data.status_code === 'ERROR') throw new Error('Container-Verarbeitungsfehler');
    console.log(`Warte auf Container... (${data.status_code})`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('Container Timeout – Bild wurde nicht verarbeitet');
}

async function publishPost(containerId, accessToken, userId) {
  const res = await fetch(`https://graph.instagram.com/v21.0/${userId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: containerId, access_token: accessToken }),
  });
  const data = await res.json();
  if (!data.id) throw new Error('Veröffentlichung fehlgeschlagen: ' + JSON.stringify(data));
  return data.id;
}

async function main() {
  const { INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_USER_ID } = process.env;

  if (!INSTAGRAM_ACCESS_TOKEN || !INSTAGRAM_USER_ID) {
    throw new Error('Fehlende Umgebungsvariablen: INSTAGRAM_ACCESS_TOKEN oder INSTAGRAM_USER_ID');
  }

  const accessToken = await checkTokenExpiry(INSTAGRAM_ACCESS_TOKEN);

  if (!fs.existsSync(INSTAGRAM_FOLDER)) {
    console.log('Kein Instagram-Ordner gefunden.');
    return;
  }

  if (!fs.existsSync(POSTED_FOLDER)) {
    fs.mkdirSync(POSTED_FOLDER, { recursive: true });
  }

  const now = new Date();
  const entries = fs.readdirSync(INSTAGRAM_FOLDER).filter((e) => e !== 'gepostet');
  let posted = 0;

  for (const entry of entries) {
    // Erwartet Format: YYYY-MM-DD_HH-MM
    const match = entry.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2})$/);
    if (!match) continue;

    const postTime = new Date(`${match[1]}T${match[2].replace('-', ':')}:00`);
    if (postTime > now) {
      console.log(`⏳ ${entry}: noch nicht fällig (${postTime.toLocaleString('de-DE')})`);
      continue;
    }

    const postFolder = path.join(INSTAGRAM_FOLDER, entry);
    const files = fs.readdirSync(postFolder);
    const imageFile = files.find((f) => /\.(jpg|jpeg|png)$/i.test(f));
    const captionFile = files.find((f) => f === 'caption.txt');

    if (!imageFile) {
      console.log(`⚠️  ${entry}: kein Bild gefunden – überspringe`);
      continue;
    }

    const caption = captionFile
      ? fs.readFileSync(path.join(postFolder, captionFile), 'utf-8').trim()
      : '';
    const imagePath = path.join(postFolder, imageFile);
    const tempFilename = `${entry}_${imageFile}`;

    try {
      console.log(`📸 Poste: ${entry}`);
      const imageUrl = await uploadToFTP(imagePath, tempFilename);
      const containerId = await createMediaContainer(imageUrl, caption, accessToken, INSTAGRAM_USER_ID);
      await waitForContainer(containerId, accessToken);
      const postId = await publishPost(containerId, accessToken, INSTAGRAM_USER_ID);
      await deleteFromFTP(tempFilename);

      fs.renameSync(postFolder, path.join(POSTED_FOLDER, entry));
      console.log(`✅ Erfolgreich gepostet! Post-ID: ${postId} → verschoben nach gepostet/`);
      posted++;
    } catch (err) {
      console.error(`❌ Fehler bei ${entry}:`, err.message);
    }
  }

  console.log(`\nFertig. ${posted} Beitrag(e) veröffentlicht.`);
}

main().catch((err) => {
  console.error('Kritischer Fehler:', err.message);
  process.exit(1);
});
