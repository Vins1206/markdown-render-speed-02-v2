[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Vins1206/markdown-render-speed-02-v2/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Vins1206/markdown-render-speed-02-v2/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markdown-render-speed-02

A dependency-free Markdown renderer in pure Node.js whose `parse(markdown)`
returns byte-identical HTML to marked 18.1.3 with default options (GFM on),
while running faster. `parse.js` implements block parsing with a container
stack and virtual-column tab tracking, plus inline parsing with a delimiter
stack. `main.ts` is the harness driver: it reads `cases.json` from the input
directory, renders each case independently, and writes `html.json`.
