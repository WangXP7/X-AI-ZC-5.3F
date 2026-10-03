# -*- coding: utf-8 -*-
# index.html 文本补丁：标语、提示词标签、默认参数、自动关联按钮（第 27 章）
import io
p = 'app/index.html'
src = io.open(p, encoding='utf-8', newline='').read()
n0 = len(src)

def rep(old, new):
    global src
    assert old in src, 'MISSING: ' + old[:60]
    src = src.replace(old, new, 1)

rep('<div class="art-line">让X-AI把你的故事美梦成真！</div>',
    '<div class="slogan-line">让X-AI和你创造</div>\n      <div class="slogan-line">属于你的故事</div>')
rep('<label for="s-prompt">画面与动作 <span id="s-prompt-count" class="count">0 / 12000</span></label>',
    '<label for="s-prompt">画面与动作描述【提示词Prompt】 <span id="s-prompt-count" class="count">0 / 12000</span></label>')
rep('<option value="text" selected>文字生成</option>', '<option value="text">文字生成</option>')
rep('<option value="reference">参考生成</option>', '<option value="reference" selected>图像 / 声音参考生成</option>')
rep('<input id="s-seconds" type="number" min="4" max="12" step="1" value="8">', '<input id="s-seconds" type="number" min="4" max="12" step="1" value="12">')
rep('<option value="9:16" selected>9:16 竖屏</option>', '<option value="9:16">9:16 竖屏</option>')
rep('<option value="16:9">16:9 横屏</option>', '<option value="16:9" selected>16:9 横屏</option>')
rep('<input id="b-seconds" type="number" min="4" max="12" step="1" value="8">', '<input id="b-seconds" type="number" min="4" max="12" step="1" value="12">')
rep('''              <select id="b-aspect">
                <option value="9:16" selected>9:16</option>
                <option value="16:9">16:9</option>''',
    '''              <select id="b-aspect">
                <option value="9:16">9:16</option>
                <option value="16:9" selected>16:9</option>''')
rep('<button type="button" id="btn-pick-assets" class="btn light small">从素材库选择</button>\n              <button type="button" id="btn-add-files"',
    '<button type="button" id="btn-pick-assets" class="btn light small">从素材库选择</button>\n              <button type="button" id="btn-auto-associate" class="btn light small">自动关联素材库</button>\n              <button type="button" id="btn-add-files"')
io.open(p, 'w', encoding='utf-8', newline='').write(src)
print('edits-1 applied, size', n0, '->', len(src))
