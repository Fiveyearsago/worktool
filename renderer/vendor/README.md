# Markdown parser

`markdown-it.min.js` is the unmodified browser UMD distribution from the pinned npm development dependency `markdown-it@15.0.3`, copied from `dist/browser/markdown-it.umd.min.js`. Its MIT license is retained in `markdown-it.LICENSE`.

The browser and main process both load this bundled copy, without a CDN or runtime download. `tests/markdown.test.cjs` compares it byte for byte with the installed dependency. When upgrading, update the exact version in package.json and package-lock.json, replace this file and the license from that version, and run the Markdown unit and packaged desktop tests.

Upstream: https://github.com/markdown-it/markdown-it
