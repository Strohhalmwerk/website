const fs = require('fs');
const path = require('path');

const INSTAGRAM_FOLDER = path.join(__dirname, 'Instagram');
const POSTED_FOLDER = path.join(INSTAGRAM_FOLDER, 'gepostet');
const WEBSITE_URL = 'https://strohhalmwerk.de';

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
    const match = entry.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2})$/);
    if (!match) continue;

    const postTime = new Date(`${match[1]}T${match[2].replace('-', ':')}:00Z`);
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

    const imageUrl = `${WEBSITE_URL}/Instagram/${encodeURIComponent(entry)}/${encodeURIComponent(imageFile)}`;
    console.log(`📸 Poste: ${entry} → ${imageUrl}`);

    try {
      const containerId = await createMediaContainer(imageUrl, caption, accessToken, INSTAGRAM_USER_ID);
      await waitForContainer(containerId, accessToken);
      const postId = await publishPost(containerId, accessToken, INSTAGRAM_USER_ID);

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
