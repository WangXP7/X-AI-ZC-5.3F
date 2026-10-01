# 第三方组件说明

| 组件 | 版本 | 许可 | 来源 | 用途 |
|---|---|---|---|---|
| `@ffmpeg/ffmpeg` | 0.12.15 | MIT | npm 注册表（registry.npmmirror.com 镜像）| 浏览器端 FFmpeg 引擎封装（`app/vendor/ffmpeg/`）|
| `@ffmpeg/core` | 0.12.10 | 随包 GPL 说明分发（含 libx264 等组件）| npm 注册表（registry.npmmirror.com 镜像）| FFmpeg WebAssembly 核心（`app/vendor/ffmpeg-core/`）|

应用原创源码（`app/src/`、`app/index.html`、`tools/`）按 MIT 许可提供（见 LICENSE）。

`@ffmpeg/core` 的构建来源与许可文本以上游 npm 包内说明为准；再分发时保留本文件与上游许可。
FFmpeg 的多功能构建包含大量 LGPL/GPL 组件，本平台仅在浏览器本地使用，不随生成结果再分发引擎字节。
