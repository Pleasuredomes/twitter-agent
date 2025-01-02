import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);
const OUTPUT_DIR = path.join(process.cwd(), 'node_modules', '.bin');

async function downloadYtDlp() {
  try {
    // Check if yt-dlp is already installed globally
    try {
      await execAsync('yt-dlp --version');
      console.log('yt-dlp is already installed globally');
      return;
    } catch (e) {
      console.log('yt-dlp not found globally, downloading...');
    }

    // Create output directory if it doesn't exist
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Download yt-dlp
    const downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
    const outputPath = path.join(OUTPUT_DIR, 'yt-dlp');
    
    await execAsync(`curl -L ${downloadUrl} -o ${outputPath}`);
    await execAsync(`chmod a+rx ${outputPath}`);
    
    console.log('yt-dlp downloaded and installed successfully');
  } catch (error) {
    console.error('Error installing yt-dlp:', error);
    process.exit(1);
  }
}

downloadYtDlp(); 
