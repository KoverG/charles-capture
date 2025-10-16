//report.js

import fs from 'fs/promises';
import path from 'path';
import open from 'open';
import { sanitizeForFile } from './utils.js';
import { validateBody, validateMeta } from './rules.js';

// ── Хелперы для уникализации и извлечения данных устройства ─────────────────────
function stripTimeSegments(baseNameNoExt) {
    // 1) с начала: YYYY-MM-DD_HH-mm-ss__ (наш читаемый tsIso)
    baseNameNoExt = baseNameNoExt.replace(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}__/, '');
    // 2) с конца: __<epoch> (10–13 цифр), если когда-то использовался {{ts}} в конце
    baseNameNoExt = baseNameNoExt.replace(/__\d{10,13}$/, '');
    return baseNameNoExt;
}

// Ключ уникальности: имя без времени и без различия между .json и .meta.json
function uniqueKeyFromRelPath(relPath) {
    const norm = relPath.replace(/\\/g, '/');                  // кроссплатформенно
    const withoutMeta = norm.replace(/\.meta\.json$/i, '.json');
    const withoutExt = withoutMeta.replace(/\.json$/i, '');
    return stripTimeSegments(withoutExt);                      // напр. host__path__POST
}

// Поиск первого (по времени) meta.json и извлечение "android 35" из X-Requested-With
async function extractAndroidFromFirstMeta(baseDir, relFiles) {
    const metaFiles = relFiles.filter(f => /\.meta\.json$/i.test(f));
    if (!metaFiles.length) return null;

    // Берём самый ранний по mtime (или любой первый — но делаем последовательным)
    const withTimes = await Promise.all(metaFiles.map(async f => {
        try {
            const st = await fs.stat(path.join(baseDir, f));
            return { f, t: st.mtimeMs };
        } catch { return { f, t: 0 }; }
    }));
    withTimes.sort((a, b) => a.t - b.t);
    const firstRel = withTimes[0].f;
    const abs = path.join(baseDir, firstRel);

    try {
        const content = await fs.readFile(abs, 'utf8');
        const meta = JSON.parse(content);
        const hdrs = meta?.request?.headers || [];
        const h = hdrs.find(x => String(x?.name || '').toLowerCase() === 'x-requested-with');
        const val = h?.value || '';

        // Ищем шаблон "android 35" (нечувствительно к регистру), берём всю фразу
        const m = /android\s*\d+/i.exec(val);
        return m ? m[0] : null;
    } catch {
        return null;
    }
}

// Загрузить и провалидировать BODY-json (обычный .json)
async function readAndValidateBody(baseDir, relPath) {
    try {
        const abs = path.join(baseDir, relPath);
        const text = await fs.readFile(abs, 'utf8');
        const obj = JSON.parse(text);
        const issues = validateBody(obj);
        return { ok: true, issues };
    } catch {
        return { ok: false, issues: ['invalid.json'] };
    }
}

// Загрузить и провалидировать META-json (.meta.json)
async function readAndValidateMeta(baseDir, relPath) {
    try {
        const abs = path.join(baseDir, relPath);
        const text = await fs.readFile(abs, 'utf8');
        const obj = JSON.parse(text);
        const issues = validateMeta(obj);
        return { ok: true, issues };
    } catch {
        return { ok: false, issues: ['invalid.meta.json'] };
    }
}




export async function buildReportForRun(cfg, runName) {

    const base = path.join(cfg.storage.dataDir, runName);
    const files = await listRec(base);

    const lines = [];
    lines.push(`Отчёт по сбору: ${runName}`);
    lines.push('===================================');
    lines.push(`Дата: ${new Date().toISOString()}`);
    lines.push('');

// ── Только JSON (и .json, и .meta.json) ──
    const allJsonish = files.filter(x => x.endsWith('.json'));
    const jsonFiles  = files.filter(x => x.endsWith('.json') && !x.endsWith('.meta.json'));
    const metaFiles  = files.filter(x => x.endsWith('.meta.json'));

    const androidFromHeader = await extractAndroidFromFirstMeta(base, files);
    const deviceModel = cfg?.runtime?.deviceModel || '—';

    lines.push('Метаданные:');
    lines.push(`  Устройство в тесте: ${androidFromHeader || 'не найдено'} (${deviceModel})`);
    lines.push('');

// Если нет обычных .json — делаем «пустой» отчёт, но с метадатой
    if (!jsonFiles.length) {
        lines.push('(нет сохранённых JSON-файлов)');
        lines.push('');
        lines.push('Подсказка: запусти п.3 «Начать сбор из Charles (HAR-watcher)» и включи в Charles: Tools → Auto Save (HTTP Archive).');

        const outPath = await writeReport(cfg, runName, lines.join('\n'));
        return outPath;
    }


    // Карта META по ключу (ключ = имя без времени и без различий .meta/.json)
    const metaMap = new Map(); // key -> [{ rel, mtime, issuesCount }]
    for (const rel of metaFiles) {
        const abs = path.join(base, rel);
        let mtime = 0;
        try { const st = await fs.stat(abs); mtime = st.mtimeMs; } catch {}
        const key = uniqueKeyFromRelPath(rel);
        const validation = await readAndValidateMeta(base, rel);
        const issuesCount = validation.issues.length;
        if (!metaMap.has(key)) metaMap.set(key, []);
        metaMap.get(key).push({ rel, mtime, issuesCount });
    }

// Хелпер: найти meta, ближайший по времени к выбранному body (если есть)
    function nearestMetaIssues(key, targetMtime) {
        const arr = metaMap.get(key);
        if (!arr || !arr.length) return 0;
        let best = arr[0], bestDiff = Math.abs(arr[0].mtime - targetMtime);
        for (let i = 1; i < arr.length; i++) {
            const diff = Math.abs(arr[i].mtime - targetMtime);
            if (diff < bestDiff) { best = arr[i]; bestDiff = diff; }
        }
        return best.issuesCount || 0;
    }

// ── Привычный плоский список обычных JSON + сводка по хостам ───────────────────
// ── ГРУППИРОВКА ПО УНИКАЛЬНОМУ КЛЮЧУ ─────────────────────────────────────────────
// Собираем кандидатов (только body .json, без .meta), для каждого знаем mtime и «замечания»
    const entries = [];
    for (const rel of jsonFiles) {
        const abs = path.join(base, rel);
        let mtime = 0;
        try { const st = await fs.stat(abs); mtime = st.mtimeMs; } catch {}
        const key = uniqueKeyFromRelPath(rel); // групповой ключ без времени/расширений

        const validation = await readAndValidateBody(base, rel);
        const issuesCount = validation.issues.length;

        entries.push({ rel, key, mtime, issuesCount });
    }

// Группируем
    const groups = new Map(); // key -> [{rel, mtime, issuesCount}, ...]
    for (const e of entries) {
        if (!groups.has(e.key)) groups.set(e.key, []);
        groups.get(e.key).push(e);
    }

// Для каждого ключа выбираем «представителя»:
// 1) с наибольшим числом замечаний (issuesCount), 2) при равенстве — с максимальным mtime
    const chosen = [];
    for (const [key, arr] of groups.entries()) {
        arr.sort((a, b) => {
            if (b.issuesCount !== a.issuesCount) return b.issuesCount - a.issuesCount;
            return b.mtime - a.mtime;
        });
        const pick = arr[0];
        chosen.push(pick);
    }

// Печатаем только «представителей», отсортируем для удобства по имени файла
    chosen.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
    // Посчитаем OK/Error с учётом meta (только в заголовке; в списке показываем body-строку)
        let okCount = 0, errCount = 0;
    const rows = [];
    for (const item of chosen) {
          const metaExtra = nearestMetaIssues(item.key, item.mtime); // доп. отклонения из meta
          const totalIssues = (item.issuesCount || 0) + (metaExtra || 0);
          if (totalIssues > 0) errCount++; else okCount++;
            // Выводим метку как [Отклонений:N] (рус.)
            rows.push(item.rel + (totalIssues > 0 ? `  [Отклонений:${totalIssues}]` : ''));
        }

        lines.push(`Получено уникальных JSON: ${chosen.length} [OK: ${okCount} | Error: ${errCount}]`);
    for (const line of rows) lines.push(line);

    const outPath = await writeReport(cfg, runName, lines.join('\n'));
    return outPath;
}

export async function openReport(p) {
    try {
        await open(p);
    } catch {
        // ── безопасный фолбэк для headless/CI ───────────────────────────
        console.log('Не удалось автоматически открыть отчёт. Путь к файлу:', p);
    }
}

async function writeReport(cfg, runName, content) {
    const outDir = path.dirname((cfg.report?.outFile) || './reports/summary.txt');
    const safeRun = sanitizeForFile(runName) || 'RUN';

    // метка времени генерации отчёта
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;

    // имя файла теперь содержит и runName, и момент генерации
    const outPath = path.join(outDir, `${safeRun}__summary__${ts}.txt`);

    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(outPath, content, 'utf8');
    return outPath;
}


async function listRec(dir) {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const files = await Promise.all(entries.map(e => {
            const res = path.resolve(dir, e.name);
            return e.isDirectory() ? listRec(res) : Promise.resolve([path.relative(dir, res)]);
        }));
        return files.flat();
    } catch {
        return [];
    }
}
