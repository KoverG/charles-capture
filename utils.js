//utils.js

export function sanitizeForFile(s = '') {
    return String(s)
        .replace(/[\\/:*?"<>|\s]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 150);
}

export function pick(obj = {}, keys = []) {
    const o = {}; keys.forEach(k => { if (k in obj) o[k] = obj[k]; });
    return o;
}
