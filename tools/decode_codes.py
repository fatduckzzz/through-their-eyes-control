#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""解码 Through Their Eyes 的完成码。

问卷平台导出的 CSV 里会有一列完成码（形如 TTE-N-3A6AGN）。这个脚本把
那一列展开成可分析的字段，编码规则与 tracker.js 的 makeCode() 一一对应。

用法：
    python decode_codes.py 答卷.csv --column 完成码 -o 答卷_解码.csv
    python decode_codes.py TTE-N-3A6AGN TTE-C-5ME80Q      # 直接解几个码

校验位不通过的码会标成 valid=False。请勿仅凭这一项剔除被试——
完成码是纯前端生成的，属于依从性信号而非防作弊机制，应与问卷里的
注意力检查题合并判断。
"""

import argparse
import csv
import re
import sys

# Windows 控制台默认是 GBK/cp1252，直接 print 中文会抛 UnicodeEncodeError
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'   # 无 I L O U
CODE_RE = re.compile(r'([NCX])-([0-9A-Z]{6})\s*$')
CVD_TYPES = ['none', 'protan', 'deutan', 'tritan', 'achro', '?', '?', 'unknown']
ARMS = {'N': 'narrative', 'C': 'control', 'X': 'unknown'}

FIELDS = ['code', 'valid', 'arm', 'minutes', 'sections_seen', 'max_scroll_pct',
          'cvd_type', 'ctool_opened', 'ctool_exported', 'img_analysed',
          'reduced_motion']


def decode(code):
    """把一个完成码展开成 dict；无法解析时 valid=False。"""
    raw = str(code or '').upper().replace(' ', '')
    m = CODE_RE.search(raw)
    if not m:
        return dict.fromkeys(FIELDS[1:]) | {'code': code, 'valid': False}

    full = 0
    for ch in m.group(2):
        idx = ALPHABET.find(ch)
        if idx < 0:
            return dict.fromkeys(FIELDS[1:]) | {'code': code, 'valid': False}
        full = full * 32 + idx

    check, v = full & 31, full >> 5
    checksum = 0
    for i in range(0, 25, 5):
        checksum ^= (v >> i) & 31

    return {
        'code': code,
        'valid': checksum == check,
        'arm': ARMS.get(m.group(1), 'unknown'),
        'minutes': (v >> 18) & 127,
        'sections_seen': (v >> 13) & 31,
        'max_scroll_pct': ((v >> 8) & 31) * 4,
        'cvd_type': CVD_TYPES[(v >> 5) & 7],
        'ctool_opened': bool((v >> 4) & 1),
        'ctool_exported': bool((v >> 3) & 1),
        'img_analysed': bool((v >> 2) & 1),
        'reduced_motion': bool((v >> 1) & 1),
    }


def decode_csv(path, column, out_path):
    with open(path, newline='', encoding='utf-8-sig') as f:
        rows = list(csv.DictReader(f))

    if not rows:
        sys.exit('输入文件没有数据行。')
    if column not in rows[0]:
        sys.exit(f'找不到列 {column!r}。可用的列：{", ".join(rows[0])}')

    added = [c for c in FIELDS[1:]]
    for row in rows:
        d = decode(row[column])
        for c in added:
            row['code_' + c] = d[c]

    with open(out_path, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    ok = sum(1 for r in rows if r['code_valid'])
    print(f'{len(rows)} 行，其中 {ok} 行完成码校验通过 → {out_path}')

    by_arm = {}
    for r in rows:
        if r['code_valid']:
            by_arm.setdefault(r['code_arm'], []).append(r)
    for arm, rs in sorted(by_arm.items()):
        mins = [int(r['code_minutes']) for r in rs]
        types = {}
        for r in rs:
            types[r['code_cvd_type']] = types.get(r['code_cvd_type'], 0) + 1
        print(f'  {arm:10s} n={len(rs):3d}  有效阅读中位数={sorted(mins)[len(mins)//2]} 分钟  类型分布={types}')


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input', nargs='+', help='CSV 路径，或若干个完成码')
    ap.add_argument('--column', default='完成码', help='CSV 中完成码所在列名')
    ap.add_argument('-o', '--out', help='输出 CSV 路径')
    a = ap.parse_args()

    if len(a.input) == 1 and a.input[0].lower().endswith('.csv'):
        decode_csv(a.input[0], a.column, a.out or a.input[0].replace('.csv', '_解码.csv'))
    else:
        for code in a.input:
            d = decode(code)
            print(f"{d['code']}  " + '  '.join(f'{k}={d[k]}' for k in FIELDS[1:]))


if __name__ == '__main__':
    main()
