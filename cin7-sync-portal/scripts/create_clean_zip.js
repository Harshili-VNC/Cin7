const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const rootDir = path.resolve(__dirname, '../..');
const outputZipPath = path.join(rootDir, 'Cin7_Project.zip');

console.log('Project root:', rootDir);
console.log('Target ZIP:', outputZipPath);

if (fs.existsSync(outputZipPath)) {
  try {
    fs.unlinkSync(outputZipPath);
  } catch (e) {
    console.log('Existing file overwrite mode');
  }
}

const output = fs.createWriteStream(outputZipPath);
const archive = archiver('zip', {
  zlib: { level: 9 }
});

output.on('close', function() {
  const sizeMB = (archive.pointer() / 1024 / 1024).toFixed(2);
  console.log(`\n======================================================`);
  console.log(`🎉 ZIP ARCHIVE CREATED SUCCESSFULLY!`);
  console.log(`📁 File: ${outputZipPath}`);
  console.log(`📊 Size: ${sizeMB} MB (${archive.pointer()} bytes)`);
  console.log(`======================================================`);
});

archive.on('warning', function(err) {
  if (err.code === 'ENOENT') {
    console.warn(err);
  } else {
    throw err;
  }
});

archive.on('error', function(err) {
  throw err;
});

archive.pipe(output);

// Recursively add files ignoring node_modules, .git, and previous zip files
function addDirectory(currentDir, zipPrefix = '') {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const zipEntryPath = zipPrefix ? path.join(zipPrefix, entry.name).replace(/\\/g, '/') : entry.name;

    // Excluded folders & files
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === 'prevcin7--version' ||
        entry.name === '.system_generated' ||
        entry.name === 'dist' ||
        entry.name === 'build' ||
        entry.name === '.cache'
      ) {
        continue;
      }
      addDirectory(fullPath, zipEntryPath);
    } else if (entry.isFile()) {
      if (
        entry.name === 'Cin7-Project.zip' ||
        entry.name.endsWith('.tmp') ||
        entry.name.endsWith('.log')
      ) {
        continue;
      }
      archive.file(fullPath, { name: zipEntryPath });
    }
  }
}

addDirectory(rootDir);
archive.finalize();
