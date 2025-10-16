// capture.js

import fs from 'fs/promises';
import path from 'path';
import chokidar from 'chokidar';
import { sanitizeForFile, pick } from './utils.js';
import * as storage from './storage.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function checkHarDir(dir) {
    try { const stat = await fs.stat(dir); return stat.isDirectory(); }
    catch { return false; }
}

export async function startWatching(cfg, runName) {
    const { harDir } = cfg.charles;
    const watcher = chokidar.watch(path.join(harDir, '**/*.har'), {
        ignoreInitial: false,
        awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 150 },
    });

    // агрегированная статистика за сессию
    const stats = {
        harProcessed: 0,
        jsonSaved: 0,
        filteredOut: 0,
        errors: 0,
        inFlight: 0,
        startedAt: Date.now(),
    };
    // прикрепим к watcher, чтобы manager.js мог прочитать при остановке
    watcher.__stats = stats;

    const handle = async (file) => {
        stats.inFlight++;
        try {
            const res = await processHar(file, cfg, runName); // {saved, filtered}
            stats.harProcessed++;
            stats.jsonSaved += (res?.saved || 0);
            stats.filteredOut += (res?.filtered || 0);
        } catch (err) {
            stats.errors++;
            // мягкий лог — не шумим стеком
            console.log(`⚠ Ошибка обработки HAR (${path.basename(file)}): ${err?.message || err}`);
        } finally {
            stats.inFlight--;
        }
    };

    watcher.on('add', handle);
    watcher.on('change', handle);
    return watcher;
}


export async function stopWatching(watcher, { graceful = true, waitMs = 5000 } = {}) {
    if (!watcher) return;

    if (graceful && watcher.__stats) {
        const deadline = Date.now() + waitMs;
        while (watcher.__stats.inFlight > 0 && Date.now() < deadline) {
            await sleep(100);
        }
    }
    await watcher.close();
}


// NEW: разовый импорт всех HAR
export async function importAllHar(cfg, runName) {
    const { harDir } = cfg.charles;
    const files = await listRec(harDir);
    const harFiles = files.filter(f => f.toLowerCase().endsWith('.har'));
    // сортируем хронологически (от старых к новым)
    const withTimes = await Promise.all(harFiles.map(async f => {
        try { const st = await fs.stat(f); return { f, t: st.mtimeMs }; }
        catch { return { f, t: 0 }; }
    }));
    withTimes.sort((a,b)=> a.t - b.t);

    const stats = { harProcessed: 0, jsonSaved: 0, filteredOut: 0, alreadyExist: 0, errors: 0 };
    for (const { f } of withTimes) {
        try {
            const res = await processHar(f, cfg, runName);
            stats.harProcessed++;
            stats.jsonSaved   += (res?.saved    || 0);
            stats.filteredOut += (res?.filtered || 0);
            stats.alreadyExist+= (res?.existing || 0);
        } catch (e) {
            stats.errors++;
            console.log(`⚠ Пропуск '${f}': ${e?.message || e}`);
        }
    }
    return stats;
}

async function listRec(dir) {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const acc = [];
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) acc.push(...await listRec(p));
            else acc.push(p);
        }
        return acc;
    } catch { return []; }
}

async function processHar(harPath, cfg, runName) {
    let har;
    try {
        const buf = await fs.readFile(harPath);
        har = JSON.parse(buf.toString());
    } catch {
        // файл ещё дописывается или битый — тихо выходим
        return { saved: 0, filtered: 0 };
    }
    if (!har.log?.entries?.length) return { saved: 0, filtered: 0 };

    let saved = 0;
    let filtered = 0;
    let existing = 0;

    for (const entry of har.log.entries) {
        try {
            const { request, response, startedDateTime } = entry || {};
            if (!request || !response) { filtered++; continue; }

            let url;
            try { url = new URL(request.url); }
            catch { filtered++; continue; }

            // Фильтры
            if (cfg.charles.includeOnly?.length) {
                const ok = cfg.charles.includeOnly.some(s => url.pathname.includes(s));
                if (!ok) { filtered++; continue; }
            }
            if (cfg.charles.includeHost?.length) {
                const hostL = url.hostname.toLowerCase();
                const okHost = cfg.charles.includeHost
                    .map(h => String(h).toLowerCase())
                    .some(h => hostL.includes(h));
                if (!okHost) { filtered++; continue; }
            }
            if (cfg.charles.includeMethod?.length) {
                const m = String(request.method).toUpperCase();
                const okM = cfg.charles.includeMethod.some(x => m === String(x).toUpperCase());
                if (!okM) { filtered++; continue; }
            }

            const ct = response?.content?.mimeType || '';
            let bodyText = response?.content?.text;

            if (bodyText && response?.content?.encoding === 'base64') {
                try { bodyText = Buffer.from(bodyText, 'base64').toString('utf8'); }
                catch { /* ignore */ }
            }

            if (typeof bodyText === 'string') bodyText = stripXssi(bodyText);
            const isJson = /json|\+json/i.test(ct) || looksLikeJson(bodyText);
            if (!isJson || !bodyText) { filtered++; continue; }

            let ts = Date.parse(startedDateTime);
            if (!Number.isFinite(ts)) {
                try { const st = await fs.stat(harPath); ts = st.mtimeMs; }
                catch { ts = Date.now(); }
            }

            const fileName = (cfg.storage.fileNameTemplate || '{{method}}__{{host}}__{{path}}__{{ts}}.json')
                .replace('{{method}}', sanitizeForFile(request.method))
                .replace('{{host}}', sanitizeForFile(url.hostname))
                .replace('{{path}}', sanitizeForFile(url.pathname.replaceAll('/', '_').replace(/^_+/, '')))
                .replace('{{ts}}', String(Math.trunc(ts)));

            // если такой файл уже есть — не перезаписываем
            const outDir = path.join(cfg.storage.dataDir, runName);
            const outPath = path.join(outDir, fileName);
            try {
                await fs.access(outPath);
                existing++;
                continue; // пропускаем запись
            } catch { /* файла нет — пишем ниже */ }

            const meta = {
                run: runName,
                capturedAt: new Date(ts).toISOString(),
                request: pick(request, ['method', 'url', 'headers', 'httpVersion']),
                response: pick(response, ['status', 'statusText', 'headers', 'httpVersion', 'content']),
            };

            await storage.saveJson(cfg.storage.dataDir, runName, fileName, bodyText, meta);
            saved++;
        } catch {
            // точечно пропускаем отдельную entry
            filtered++;
        }
    }
    return { saved, filtered, existing };
}


function stripXssi(s = '') {
    if (!s) return s;
    // типичный XSSI префикс у Google/FB API
    if (s.startsWith(")]}',") || s.startsWith(")]}',\n") || s.startsWith(")]}\n")) {
        const i = s.indexOf('\n');
        return i >= 0 ? s.slice(i + 1) : '';
    }
    return s;
}

function looksLikeJson(text) {
    if (!text || typeof text !== 'string') return false;
    const s = text.trim();
    return (s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'));
}

export default { checkHarDir, startWatching, stopWatching, importAllHar };
