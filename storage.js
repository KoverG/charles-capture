import fs from 'fs/promises';
import path from 'path';

export async function ensureDirs(dir) {
    await fs.mkdir(dir, { recursive: true });
}

export async function saveJson(baseDir, runName, fileName, bodyText, meta) {
    const outDir = path.join(baseDir, runName);
    await fs.mkdir(outDir, { recursive: true });

    const outPath = path.join(outDir, fileName);
    await fs.writeFile(outPath, bodyText, 'utf8');

    const metaPath = outPath.replace(/\.json$/i, '.meta.json');
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

export async function removeDir(dir) {
    try { await fs.rm(dir, { recursive: true, force: true }); return true; }
    catch { return false; }
}
