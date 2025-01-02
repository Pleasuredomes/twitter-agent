import https from 'https';
import fs from 'fs';
import path from 'path';

const YT_DLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
const OUTPUT_DIR = path.join(process.cwd(), 'node_modules', '.bin');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const file = fs.createWriteStream(path.join(OUTPUT_DIR, 'yt-dlp'));

https.get(YT_DLP_URL, (response) => {
  response.pipe(file);
  file.on('finish', () => {
    file.close();
    fs.chmodSync(path.join(OUTPUT_DIR, 'yt-dlp'), '755');
    console.log('yt-dlp downloaded successfully');
  });
}).on('error', (err) => {
  fs.unlink(path.join(OUTPUT_DIR, 'yt-dlp'));
  console.error('Error downloading yt-dlp:', err.message);
}); 
