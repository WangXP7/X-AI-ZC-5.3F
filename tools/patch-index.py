# -*- coding: utf-8 -*-
# index.html 结构补丁：模式切换加 Pavo、Pavo 操作区、任务进度卡、素材筛选
import io
p = 'app/index.html'
src = io.open(p, encoding='utf-8', newline='').read()

def rep(old, new):
    global src
    assert old in src, 'MISSING: ' + old[:60].replace('\n', '\\n')
    src = src.replace(old, new, 1)

# 1) 模式切换：加 Pavo 标签，单段不再默认选中
rep('''        <label class="mode-opt mode-single">
          <input type="radio" name="gen-mode" value="single" checked>
          <span class="mode-title">单段生成</span>''',
    '''        <label class="mode-opt mode-pavo">
          <input type="radio" name="gen-mode" value="pavo" checked>
          <span class="mode-title">PavoAI</span>
          <span class="mode-desc">释放您的创意 · 立即将想法变成影像</span>
        </label>
        <label class="mode-opt mode-single">
          <input type="radio" name="gen-mode" value="single">
          <span class="mode-title">单段生成</span>''')

# 2) Pavo 操作区（插在单段操作区前）
rep('''      <!-- ===== 单段操作区 ===== -->''',
    '''      <!-- ===== PavoAI 操作区 ===== -->
      <fieldset id="pavo-editor" class="card editor editor-pavo">
        <legend>PavoAI</legend>
        <div class="pavo-compose">
          <textarea id="pavo-prompt" rows="4" placeholder="描述画面、人物与动作；可写“视频时长7秒”明确本镜总时长。"></textarea>
          <div class="ref-toolbar">
            <button type="button" id="btn-pavo-assets" class="btn light small">＋ 素材库</button>
            <span id="pavo-chips" class="ref-list"></span>
          </div>
          <div class="pavo-bottom">
            <select id="pavo-model" aria-label="模型"></select>
            <select id="pavo-generation-mode" aria-label="生成方式">
              <option value="auto" selected>全能模式</option>
              <option value="text">文字生成</option>
              <option value="keyframe">首尾帧生成</option>
            </select>
            <details class="pavo-settings">
              <summary id="pavo-summary" aria-expanded="false">16:9 · 12s · 720P</summary>
              <div class="pavo-pop">
                <div class="mini-label">画幅</div>
                <div class="chip-row" id="pavo-aspect-row">
                  <button type="button" data-aspect="auto">Auto</button>
                  <button type="button" data-aspect="16:9" class="on">16:9</button>
                  <button type="button" data-aspect="9:16">9:16</button>
                  <button type="button" data-aspect="1:1">1:1</button>
                  <button type="button" data-aspect="4:3">4:3</button>
                  <button type="button" data-aspect="3:4">3:4</button>
                  <button type="button" data-aspect="21:9">21:9</button>
                </div>
                <div class="mini-label">时长（秒）</div>
                <div class="chip-row" id="pavo-seconds-row"></div>
                <div class="mini-label">分辨率</div>
                <div class="chip-row"><button type="button" class="on">720P</button></div>
              </div>
            </details>
            <span id="pavo-position" class="muted"></span>
            <button type="button" id="btn-pavo-generate" class="pavo-send" title="生成视频" aria-label="生成视频">↑</button>
          </div>
        </div>
        <div id="pavo-feedback" class="feedback" hidden></div>
      </fieldset>

      <!-- ===== 单段操作区 ===== -->''')

# 3) 任务页：刷新按钮 + 进度卡
rep('''        <button type="button" id="btn-run-queue" class="btn primary">开始 / 继续队列</button>''',
    '''        <button type="button" id="btn-run-queue" class="btn primary">开始 / 继续队列</button>
        <button type="button" id="btn-refresh-status" class="btn light small">刷新状态</button>''')
rep('''        <span id="queue-state" class="muted"></span>
      </div>
      <div id="job-list" class="job-list"></div>''',
    '''        <span id="queue-state" class="muted"></span>
        <span id="watchdog-info" class="muted"></span>
      </div>
      <div class="card qprogress" id="qprogress">
        <div class="qp-top">
          <div class="qp-nums">
            <span><b id="qp-total">0</b> 总任务</span>
            <span><b id="qp-ready">0</b> 已就绪</span>
            <span><b id="qp-active">0</b> 处理中</span>
            <span><b id="qp-pending">0</b> 待提交</span>
            <span><b id="qp-issue">0</b> 需处理</span>
          </div>
          <div class="qp-overall"><div class="qp-bar"><div id="qp-bar-fill"></div></div><span id="qp-pct">0%</span></div>
          <div class="qp-current" id="qp-current">空闲</div>
        </div>
      </div>
      <div id="job-list" class="job-list"></div>''')

# 4) 素材筛选
rep('''        <button type="button" id="btn-asset-add" class="btn primary">添加素材</button>''',
    '''        <button type="button" id="btn-asset-add" class="btn primary">添加素材</button>
        <select id="asset-filter-version" class="small-select">
          <option value="effective" selected>当前有效</option>
          <option value="original">原始素材</option>
          <option value="derived">优化 / 派生</option>
          <option value="all">全部版本</option>
        </select>
        <select id="asset-filter-kind" class="small-select">
          <option value="all" selected>图片与声音</option>
          <option value="image">图片</option>
          <option value="audio">声音</option>
        </select>
        <select id="asset-filter-status" class="small-select">
          <option value="all" selected>全部校验</option>
          <option value="ok">格式检查通过</option>
          <option value="pending">待处理</option>
        </select>
        <input id="asset-filter-q" type="text" placeholder="文件名 / 编号 / 路径" class="small-select">
        <button type="button" id="btn-asset-clear-lib" class="btn light small">清空素材库</button>
        <button type="button" id="btn-asset-restore" class="btn light small" hidden>恢复已清空素材</button>''')

io.open(p, 'w', encoding='utf-8', newline='').write(src)
print('index.html structural patch applied')
