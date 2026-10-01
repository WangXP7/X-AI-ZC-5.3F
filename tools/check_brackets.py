# 粗查 JS 括号 / 引号配对（忽略字符串内容与注释）
import sys

def check(path):
    src = open(path, encoding='utf-8').read()
    depth = 0; line = 1; in_s = None
    pairs = {')': '(', ']': '[', '}': '{'}
    stack = []
    i = 0; n = len(src)
    while i < n:
        c = src[i]
        if c == '\n':
            line += 1
        if in_s == '`':
            if c == '\\':
                i += 2; continue
            if c == '`':
                in_s = None
        elif in_s:
            if c == '\\':
                i += 2; continue
            if c == in_s:
                in_s = None
        else:
            if c in ('"', "'", '`'):
                in_s = c
            elif c == '/' and src[i:i+2] == '//':
                j = src.find('\n', i)
                i = j if j > -1 else n
            elif c == '/' and src[i:i+2] == '/*':
                j = src.find('*/', i)
                i = (j + 1) if j > -1 else n
            elif c in '([{':
                stack.append((c, line))
            elif c in ')]}':
                if not stack or stack[-1][0] != pairs[c]:
                    return f'不匹配 {c!r} 在第 {line} 行，栈顶: {stack[-1] if stack else None}'
                stack.pop()
        i += 1
    if in_s:
        return f'字符串未闭合: {in_s}（最后行 {line}）'
    if stack:
        return f'未闭合: {stack[-3:]}'
    return '括号配对正常'

for p in sys.argv[1:]:
    print(p, '->', check(p))
