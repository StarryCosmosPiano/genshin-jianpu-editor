# 第三方开源声明 / Third-Party Notices

本文件用于集中说明原琴简谱编辑器直接继承、移植或随源码分发的主要第三方内容。
完整的 JavaScript / Rust 依赖及其版本分别记录在 `package-lock.json` 和
`src-tauri/Cargo.lock` 中。

This file lists the principal third-party projects inherited, ported, or
distributed with Genshin Jianpu Editor. Complete JavaScript and Rust dependency
versions are recorded in `package-lock.json` and `src-tauri/Cargo.lock`.

## jpeditor

- 来源 / Source: <https://github.com/lodebar2026/jpeditor>
- 原作者 / Original author: `lodebar2026`
- 许可证 / License: MIT
- 说明 / Notes: 本项目是在 jpeditor 基础上的二次开发，保留原仓库 Git 历史及
  `LICENSE` 中的原版权声明。This project is derived from jpeditor and retains
  its Git history and original copyright notice.

## abc2xml

- 作者 / Author: Willem G. Vree
- 原始版权 / Original copyright: Copyright (C) 2012–2018 Willem G. Vree
- 项目主页 / Homepage: <https://wim.vree.org/>
- 许可证 / License: GNU Lesser General Public License (LGPL), as stated in
  the original source
- 位置 / Location: `src/abc/`
- 说明 / Notes: `abc2xml.py` 的 TypeScript 移植，用于 ABC → MusicXML。
  TypeScript port of `abc2xml.py` for ABC-to-MusicXML conversion.

## Bravura

- 项目 / Project: Bravura music font
- 来源 / Source: <https://github.com/steinbergmedia/bravura>
- 许可证 / License: SIL Open Font License 1.1
- 位置 / Location: `public/redist/Bravura*` and
  `public/redist/bravura_metadata.json`

Bravura 字体和元数据不属于项目 MIT 许可证的覆盖范围。
The Bravura font and metadata are not covered by the project's MIT license.

## PaddleOCR models

- 来源 / Source: <https://github.com/PaddlePaddle/PaddleOCR>
- 许可证 / License: Apache License 2.0
- 位置 / Location: `public/redist/ocr/`
- 说明 / Notes: PP-OCR detection and recognition models converted to ONNX
  for local browser and desktop inference.

## PDF.js

- 来源 / Source: <https://github.com/mozilla/pdf.js>
- 许可证 / License: Apache License 2.0
- 说明 / Notes: `pdfjs-dist` and its image-decoder WebAssembly assets are
  used for PDF input.

## coi-serviceworker

- 来源 / Source: <https://github.com/gzuidhof/coi-serviceworker>
- 许可证 / License: MIT
- 位置 / Location: `public/coi-serviceworker.js`

## SoundFont files

本仓库和发行包不包含原神游戏音频或任何第三方 SF2 文件。程序仅提供读取用户自备
SoundFont 的能力。

This repository and its release packages do not include Genshin Impact audio
or any third-party SF2 file. The application only provides support for loading
user-supplied SoundFonts.
