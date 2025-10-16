// rules.js
//
// ������ ����� ��� ������. ������������, �� ������ report.js.
// �������� ������� � BODY_RULES � META_RULES �� ���� ����������.

const BODY_RULES = [
    // ���������� "����"-������� (����� ���������/��������� �����)
    {
        code: 'missing.apiVersion',
        test: (obj) => ('apiVersion' in obj),
    },
    {
        code: 'missing.serverTime',
        test: (obj) => ('serverTime' in obj),
    },
    {
        code: 'invalid.serverTime.format',
        test: (obj) => {
            if (!('serverTime' in obj)) return true;
            return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(String(obj.serverTime));
        },
    },
    {
        code: 'missing.requestId',
        test: (obj) => ('requestId' in obj),
    },
    {
        code: 'missing.error.code',
        test: (obj) => {
            if (!('success' in obj)) return true;
            if (obj.success !== false) return true;
            return Boolean(obj?.error?.code);
        },
    },
];

// ���� ����-������ ��� � ��������� ��� ������, ��������� �� ���� �������������.
// ��������, ����� ����� ��������� ������� ������ ���������� � �� ������.
const META_RULES = [
    // ������ ������ (��������, ����� �� ������ � ������ ������):
    // {
    //   code: 'missing.x-requested-with',
    //   test: (meta) => {
    //     const hdrs = meta?.request?.headers || [];
    //     return hdrs.some(h => String(h?.name||'').toLowerCase() === 'x-requested-with');
    //   },
    // },
];

function runRules(obj, rules) {
    const issues = [];
    for (const r of rules) {
        let ok = true;
        try { ok = Boolean(r.test(obj)); } catch { ok = false; }
        if (!ok) issues.push(r.code);
    }
    return issues;
}

export function validateBody(obj) { return runRules(obj, BODY_RULES); }
export function validateMeta(obj) { return runRules(obj, META_RULES); }
