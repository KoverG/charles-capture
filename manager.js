import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import capture from './capture.js';
import * as storage from './storage.js';
import * as report from './report.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cfgPath = path.join(__dirname, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

function applyEnvHosts() {
    const env = (cfg.runtime?.env || 'uat').toLowerCase();
    const groups = cfg.charles?.hostGroups || {};
    const hosts = groups[env] || cfg.charles?.includeHost || [];
    cfg.charles.includeHost = hosts;         // capture.js использует это поле
    return env;
}
let currentEnv = applyEnvHosts();
function buildRunDirName(runName, env) {
    return `${runName}__${String(env).toUpperCase()}`;
}

// если сбор уже запущен, держим фиксированное имя папки;
// иначе — вычисляем по текущему runName и окружению
let startedRunDir = null;
function hasActiveRun() { return Boolean(startedRunDir); }
function getActiveRunDirName() {
    return startedRunDir || buildRunDirName(runName, currentEnv);
}

// ── имя проверки только неинтерактивно ───────────────────────────────
function genDefaultRunName(d = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`; // без :
}
function getArg(name) {
    const pref = `--${name}=`;
    const arg = process.argv.find(x => x.startsWith(pref));
    return arg ? arg.slice(pref.length) : '';
}
// Порядок приоритета: аргумент → config.runtime.runName → дата/время
const argRun = getArg('run');
const cfgRun = cfg.runtime?.runName || '';
// Порядок приоритета: аргумент → config.runtime.runName → дата/время
let runName = argRun || cfgRun || genDefaultRunName();

// если имя не задано явно (ни аргументом, ни в конфиге) — обновляем при КАЖДОМ старте
function refreshRunNameIfAuto() {
    if (!argRun && !cfgRun) {
        runName = genDefaultRunName();
    }
}

let watcher = null;
let busy = false; // флаг: сейчас ждём ответ на под-вопрос

function printMenu() {
    const runLine = hasActiveRun()
        ? `Текущий сбор данных: ${startedRunDir}\n`
        : ''; // до запуска не показываем вообще

    console.log(`
===============================
  Менеджер сбора API из Charles
===============================
${runLine}Окружение: ${currentEnv.toUpperCase()}  (хосты: ${ (cfg.charles.includeHost||[]).join(', ') || '—' })
-------------------------------
Основное меню:
  1. Начать сбор из Charles
  2. Остановить сбор из Charles
  3. Сформировать и открыть отчёт (текущий сбор данных)
  4. Выход

Дополнительно:
  5. Выбрать окружение (STG/UAT/PROD)
  6. Проверка логирования API (HAR)
  7. Очистить данные текущего сбора из Charles
  8. Просканировать все сохранённые HAR (восстановить ответы)
  9. Очистить папку логирования API (HAR)
 10. Сервис: показать настройки и проверить конфиг
`);
}


// Единственный интерфейс readline БЕЗ output — чтобы не было echo/дублирования
const rl = readline.createInterface({ input: process.stdin });

// Универсальный вопрос: печатаем текст и ждём ОДНУ строку
async function ask(question) {
    busy = true;
    process.stdout.write(question);
    try {
        return await new Promise(res => rl.once('line', line => res(line.trim())));
    } finally {
        busy = false;
    }
}

// promptYesNo с короткими вариантами y/n, Enter = нет
function isYes(s) { return /^y(es)?$/i.test(s || ''); }
async function promptYesNo(q) { return isYes(await ask(q)); }

// Красивое завершение по Ctrl+C
process.on('SIGINT', async () => {
    if (watcher) await stop();
    rl.close();
    process.stdout.write('\n');
    process.exit(0);
});

async function connect() {
    const dir = cfg.charles.harDir;
    try {
        const stat = await fs.promises.stat(dir);
        if (!stat.isDirectory()) {
            console.log('✖ Указанный путь не является папкой:', dir);
            return;
        }

        const files = await fs.promises.readdir(dir);
        const harFiles = files.filter(f => f.toLowerCase().endsWith('.har'));

        if (harFiles.length === 0) {
            console.log(`✔ Папка найдена: ${dir}, но HAR-файлов нет.`);
            console.log('ℹ Включи логирование в Charles: Tools → Auto Save (HTTP Archive).');
        } else {
            const stats = await Promise.all(
                harFiles.map(async f => {
                    const s = await fs.promises.stat(path.join(dir, f));
                    return { f, mtime: s.mtimeMs };
                })
            );
            const latest = stats.reduce((a, b) => (a.mtime > b.mtime ? a : b));
            const lastTime = new Date(latest.mtime).toLocaleString();

            console.log(`✔ Найдено HAR-файлов: ${harFiles.length} в ${dir}`);
            console.log(`Последний файл: ${latest.f}`);
            console.log(`Обновлён: ${lastTime}`);
        }
    } catch {
        console.log('✖ Папка HAR недоступна:', dir);
    }
}

async function start() {
    if (watcher) { console.log('Уже запущено.'); return; }
    // если имя run не зафиксировано аргументом/конфигом — сгенерим новое для этой сессии
    refreshRunNameIfAuto();
    const runDir = buildRunDirName(runName, currentEnv);
    await storage.ensureDirs(path.join(cfg.storage.dataDir, runDir));
    watcher = await capture.startWatching(cfg, runDir);  // передаём runDir как имя run’а
    startedRunDir = runDir; // фиксируем, чтобы list/report/clear работали с тем же каталогом
    console.log('▶ Сбор из Charles запущен.');
}


async function stop() {
    if (!watcher) { console.log('Не запущено.'); return; }

    // собираем статистику ДО закрытия (она зафиксируется после graceful-ожидания)
    const stats = watcher.__stats || null;
    const startedAt = stats?.startedAt || Date.now();

    await capture.stopWatching(watcher, { graceful: true, waitMs: 8000 });
    watcher = null;

    // Итоги
    const durationMs = Date.now() - startedAt;
    const human = (ms) => {
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const h = Math.floor(m / 60);
        const ss = s % 60, mm = m % 60;
        return (h ? `${h}h ` : '') + (m ? `${mm}m ` : '') + `${ss}s`;
    };

    if (stats) {
        // считаем фактическое число JSON-файлов в текущей папке сбора
        let actualJson = null;
        if (startedRunDir) {
            try { actualJson = await countJsonFilesInRun(startedRunDir); } catch {}
        }
        const jsonToShow = (actualJson ?? stats.jsonSaved);
        console.log(`■ Сбор остановлен | Время: ${human(durationMs)} | HAR: ${stats.harProcessed} | JSON: ${jsonToShow} | Пропущено: ${stats.filteredOut} | Ошибок: ${stats.errors}`);
    } else {
        console.log('■ Сбор из Charles остановлен.');
    }

    // дружелюбный хинт для быстрого перезапуска
    console.log('↻ Чтобы начать новый сбор, выбери пункт 3 в меню.');
}


async function makeReport() {
    const runDir = getActiveRunDirName();
    const summaryPath = await report.buildReportForRun(cfg, runDir);
    await report.openReport(summaryPath);
}

// хелпер: удалить только файлы в каталоге (рекурсивно), папки оставить
async function deleteOnlyFilesRec(dir) {
    const files = await listRec(dir); // у тебя уже есть listRec(dir) ниже
    let deleted = 0, failed = 0;
    for (const f of files) {
        try { await fs.promises.rm(f, { force: true }); deleted++; }
        catch { failed++; }
    }
    return { deleted, failed, total: files.length };
}

async function clearCurrentRun() {
    // определяем целевую папку текущего сбора
    // если сбор активен — используем startedRunDir (зафиксированное имя);
    // иначе — вычисляем по текущим runName/env (может не существовать — это ок)
    const runDirName = (watcher && startedRunDir) ? startedRunDir : getActiveRunDirName();
    const dir = path.join(cfg.storage.dataDir, runDirName);

    // проверим наличие каталога
    let dirExists = true;
    try { await fs.promises.stat(dir); } catch { dirExists = false; }

    if (!dirExists) {
        console.log(`Данных для удаления нет (${dir}).`);
        return;
    }

    // посчитаем, сколько внутри файлов (рекурсивно)
    const files = await listRec(dir);
    const totalFiles = files.length;

    if (watcher) {
        // ── сбор активен: удаляем только файлы, папку оставляем ──────────
        if (totalFiles === 0) {
            console.log(`В папке текущего активного сбора нет файлов (${dir}).`);
            return;
        }

        const ok = await promptYesNo(
            `Сейчас идёт сбор. Удалить ТОЛЬКО файлы в папке «${runDirName}» (папка останется)?\n` +
            `Найдено файлов: ${totalFiles}\nПапка: ${dir}\n[y/N]: `
        );
        if (!ok) { console.log('Отмена.'); return; }

        const res = await deleteOnlyFilesRec(dir);
        console.log(`✓ Очистка (активный сбор): удалено файлов ${res.deleted} из ${res.total}` +
            (res.failed ? `, не удалось: ${res.failed}` : '') +
            `. Папка сохранена: ${dir}`);
    } else {
        // ── сбор не активен: удаляем всю папку ───────────────────────────
        const ok = await promptYesNo(
            `Удалить ВСЮ папку данных текущего сбора «${runDirName}»?\n` +
            `Найдено файлов: ${totalFiles}\nПапка: ${dir}\n[y/N]: `
        );
        if (!ok) { console.log('Отмена.'); return; }

        const removed = await storage.removeDir(dir);
        if (removed) {
            console.log(`✓ Очистка завершена. Удалено файлов: ${totalFiles}. Папка удалена: ${dir}`);
        } else {
            console.log('Не удалось удалить папку (возможно, нет доступа или она уже отсутствует).');
        }
    }
}


async function importAllNow() {
    if (!hasActiveRun()) {
        // отдельный свежий run для разового сканирования архива
        refreshRunNameIfAuto();
    }
    if (watcher) {
        const ok = await promptYesNo(
            '⚠ Идёт активный сбор (HAR-watcher). Просканировать все HAR сейчас?\n' +
            'Это может занять время и проверить уже обработанные файлы (перезаписи не будет).\n[y/N]: '
        );
        if (!ok) { console.log('Отмена.'); return; }
    }
    const runDir = getActiveRunDirName();
    const res = await capture.importAllHar(cfg, runDir);
    console.log(`✓ Просмотр завершён | HAR: ${res.harProcessed} | JSON добавлено: ${res.jsonSaved} | Уже были: ${res.alreadyExist} | Пропущено: ${res.filteredOut} | Ошибок: ${res.errors}`
    );
}


async function listRec(dir) {
    try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        const files = await Promise.all(entries.map(e => {
            const p = path.join(dir, e.name);
            return e.isDirectory() ? listRec(p) : [p];
        }));
        return files.flat();
    } catch {
        return [];
    }
}

async function countJsonFilesInRun(runDirName) {
    const dir = path.join(cfg.storage.dataDir, runDirName);
    const all = await listRec(dir);
    return all.filter(f =>
        f.toLowerCase().endsWith('.json') && !f.toLowerCase().endsWith('.meta.json')
    ).length;
}

async function clearHarDir() {
    const dir = cfg.charles.harDir;
    const all = await listRec(dir);
    const harFiles = all.filter(f => f.toLowerCase().endsWith('.har'));

    if (!harFiles.length) {
        console.log(`(нет .har для удаления в ${dir})`);
        return;
    }

    const preview = harFiles.slice(0, 5).map(p => path.relative(dir, p));
    console.log(`Найдено HAR-файлов: ${harFiles.length} в ${dir}`);
    console.log(preview.map(x => ' - ' + x).join('\n') + (harFiles.length > 5 ? '\n - ...' : ''));

    const ok = await promptYesNo('Удалить ВСЕ перечисленные .har? [y/N]: ');
    if (!ok) {
        console.log('Отмена.');
        return;
    }

    let deleted = 0, failed = 0;
    for (const f of harFiles) {
        try {
            await fs.promises.rm(f, { force: true });
            deleted++;
        } catch (e) {
            failed++;
            console.log(`⚠ Не удалось удалить: ${f} (${e.code || e.message})`);
        }
    }
    console.log(`Готово. Удалено: ${deleted}, не удалось: ${failed}.`);
}

async function chooseEnv() {
    const groups = cfg.charles?.hostGroups || {};
    const available = Object.keys(groups);
    if (!available.length) {
        console.log('✖ Группы окружений (charles.hostGroups) не заданы в config.json');
        return;
    }
    const ans = await ask(`Выбери окружение [${available.map(x=>x.toUpperCase()).join('/')}] (текущее: ${currentEnv.toUpperCase()}): `);
    const envKey = ans.toLowerCase();
    if (!available.includes(envKey)) {
        console.log('✖ Неизвестное окружение.');
        return;
    }

    cfg.runtime = cfg.runtime || {};
    cfg.runtime.env = envKey;
    currentEnv = applyEnvHosts();

    if (watcher) {
        console.log('⚠ Watcher уже запущен. Останови (п.2) и запусти снова (п.1), чтобы применить новые хосты.');
    }
    console.log(`✓ Окружение переключено на: ${currentEnv.toUpperCase()}`);
}

function summarizeSettings() {
    const core = {
        harDir: cfg.charles?.harDir,
        dataDir: cfg.storage?.dataDir,
        env: cfg.runtime?.env,
        hostGroupsKeys: Object.keys(cfg.charles?.hostGroups || {}),
        includeHostActive: (cfg.charles?.includeHost || []).join(', ') || '—',
        reportOutFile: cfg.report?.outFile || '—',
    };
      return { core };
}

async function validateCore() {
    const issues = [];

    // harDir должен существовать как папка (но не крит. если нет — мы просто подскажем)
    const harDir = cfg.charles?.harDir;
    if (!harDir) {
        issues.push('Не задан charles.harDir.');
    } else {
        try {
            const st = await fs.promises.stat(harDir);
            if (!st.isDirectory()) issues.push(`charles.harDir не является папкой: ${harDir}`);
        } catch {
            issues.push(`Папка с HAR недоступна: ${harDir}`);
        }
    }

    // dataDir — строка
    if (!cfg.storage?.dataDir) {
        issues.push('Не задан storage.dataDir.');
    }

    // hostGroups + env
    const groups = cfg.charles?.hostGroups || {};
    const env = (cfg.runtime?.env || '').toLowerCase();
    const knownEnvs = Object.keys(groups);
    if (!knownEnvs.length) {
        issues.push('Не заданы группы окружений charles.hostGroups.');
    } else if (!knownEnvs.includes(env)) {
        issues.push(`runtime.env="${env.toUpperCase()}" отсутствует в charles.hostGroups. Доступно: ${knownEnvs.map(x=>x.toUpperCase()).join('/')}`);
    }

    return issues;
}

async function showSettings() {
    const { core } = summarizeSettings();
    console.log('\nНастройки — ОСНОВНЫЕ:');
    console.log(`  HAR-папка:           ${core.harDir || '—'}`);
    console.log(`  Путь сохранения полученных данных: ${core.dataDir || '—'}`);
    console.log(`  Окружение:           ${String(core.env || '').toUpperCase() || '—'}`);
    console.log(`  Группы окружений:    ${core.hostGroupsKeys.length ? core.hostGroupsKeys.map(x=>x.toUpperCase()).join(', ') : '—'}`);
    console.log(`  Активные хосты:      ${core.includeHostActive}`);
    console.log(`  Файл отчёта (папка): ${core.reportOutFile}`);

    const issues = await validateCore();
    if (issues.length) {
        console.log('\n⚠ Найдены проблемы в основных настройках:');
        issues.forEach((m, i) => console.log(`  ${i+1}) ${m}`));
        console.log('Подсказка: исправь config.json и перезапусти менеджер.');
    }
    console.log('');
}


// CLI
printMenu();
rl.on('line', async (input) => {
    if (busy) return;
    try {
        switch (input.trim()) {
            // Основные
            case '1': await start(); break;
            case '2': await stop(); break;
            case '3': await makeReport(); break;
            case '4': if (watcher) await stop(); process.exit(0); break;
            // Дополнительно
            case '5': await chooseEnv(); break;
            case '6': await connect(); break;
            case '7': await clearCurrentRun(); break;
            case '8': await importAllNow(); break;
            case '9': await clearHarDir(); break;
            case '10': await showSettings(); break;
            default: console.log('Неверный выбор');
        }
    } catch (e) {
        console.error('Ошибка:', e);
    } finally {
        printMenu();
    }
});
