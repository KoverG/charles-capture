import fs from 'fs/promises';
import path from 'path';
import open from 'open';
import { sanitizeForFile } from './utils.js';

export async function buildReportForRun(cfg, runName) {
    const base = path.join(cfg.storage.dataDir, runName);
    const files = await listRec(base);

    const lines = [];
    lines.push(`Отчёт по сбору: ${runName}`);
    lines.push('=======================');
    lines.push(`Дата: ${new Date().toISOString()}`);
    lines.push(`Папка: ${path.resolve(base)}`);
    lines.push('');

    // только JSON-ответы (исключая .meta.json)
    const jsonFiles = files.filter(x => x.endsWith('.json') && !x.endsWith('.meta.json'));

    if (!jsonFiles.length) {
        // ── грейсфул: отчёт создаётся всегда ─────────────────────────────
        lines.push('(нет сохранённых JSON-файлов)');
        lines.push('');
        lines.push('Подсказка: запусти п.3 «Начать сбор из Charles (HAR-watcher)» и включи в Charles: Tools → Auto Save (HTTP Archive).');

        const outPath = await writeReport(cfg, runName, lines.join('\n'));
        return outPath;
    }

    // привычный плоский список + сводка по хостам
    const hostCount = new Map();
    for (const rel of jsonFiles) {
        lines.push(rel);
        const host = rel.split('__')[1] || 'unknown';
        hostCount.set(host, (hostCount.get(host) || 0) + 1);
    }

    lines.push('\nСводка по хостам:');
    for (const [host, cnt] of [...hostCount.entries()].sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${host}: ${cnt}`);
    }

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
