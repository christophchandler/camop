const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CONVERT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Convert WebM to MP4 using ffmpeg
function convertWebmToMp4(inputPath) {
  return new Promise((resolve, reject) => {
    const outputPath = inputPath.replace(/\.webm$/, '.mp4');

    const args = [
      '-i', inputPath,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-y',
      outputPath
    ];

    const ffmpeg = spawn('ffmpeg', args);

    const timeout = setTimeout(() => {
      ffmpeg.kill('SIGKILL');
      reject(new Error('ffmpeg conversion timed out (5 min limit)'));
    }, CONVERT_TIMEOUT_MS);

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(outputPath);
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });

    ffmpeg.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`ffmpeg not found or failed to start: ${err.message}`));
    });
  });
}

// Download from B2 URL, convert, return local path
async function downloadAndConvert(url, fileName) {
  const tmpDir = path.join(os.tmpdir(), 'fieldcast-convert');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const inputPath = path.join(tmpDir, fileName);
  let outputPath = null;

  try {
    // Download file
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(inputPath, buffer);

    // Convert
    outputPath = await convertWebmToMp4(inputPath);
    return outputPath;
  } finally {
    // Always clean up input file
    try { fs.unlinkSync(inputPath); } catch {}
  }
}

module.exports = { convertWebmToMp4, downloadAndConvert };
