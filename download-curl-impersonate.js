const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BIN_DIR = path.join(__dirname, 'bin');
const PLATFORM = process.platform;
const ARCH = process.arch;

const BINARIES = {
  linux: {
    x64: 'https://github.com/yifeikong/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz',
    arm64: 'https://github.com/yifeikong/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.aarch64-linux-gnu.tar.gz'
  },
  darwin: {
    x64: 'https://github.com/yifeikong/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-apple-darwin.tar.gz',
    arm64: 'https://github.com/yifeikong/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.arm64-apple-darwin.tar.gz'
  }
};

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        download(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', reject);
  });
}

async function main() {
  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  const binaryName = 'curl-impersonate-chrome';
  const binaryPath = path.join(BIN_DIR, binaryName);

  // Skip if already exists
  if (fs.existsSync(binaryPath)) {
    console.log('[postinstall] curl-impersonate already exists, skipping download');
    process.exit(0);
  }

  const platformBinaries = BINARIES[PLATFORM];
  if (!platformBinaries) {
    console.warn(`[postinstall] Platform ${PLATFORM} not supported for automatic curl-impersonate download`);
    console.warn('[postinstall] Please install curl-impersonate manually or ensure curl is available');
    process.exit(0);
  }

  const url = platformBinaries[ARCH];
  if (!url) {
    console.warn(`[postinstall] Architecture ${ARCH} not supported for automatic download`);
    process.exit(0);
  }

  const tarPath = path.join(BIN_DIR, 'curl-impersonate.tar.gz');

  try {
    console.log(`[postinstall] Downloading curl-impersonate for ${PLATFORM}-${ARCH}...`);
    await download(url, tarPath);

    console.log('[postinstall] Extracting...');
    execSync(`tar -xzf ${tarPath} -C ${BIN_DIR} --strip-components=1`, { stdio: 'inherit' });

    // Make executable
    if (fs.existsSync(binaryPath)) {
      fs.chmodSync(binaryPath, 0o755);
      console.log(`[postinstall] curl-impersonate installed at ${binaryPath}`);
    }

    // Cleanup
    fs.unlinkSync(tarPath);
  } catch (err) {
    console.error('[postinstall] Failed to download curl-impersonate:', err.message);
    console.warn('[postinstall] Falling back to system curl');
    // Don't fail the install, server.js already falls back to curl
    process.exit(0);
  }
}

main();
