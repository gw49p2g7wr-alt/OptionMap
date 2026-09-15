"use strict";
const html = `<!doctype html><html><head><meta charset="UTF-8"></head><body>
<h2 id="heading_7"><span>休業日一覧</span></h2>
<h3 id="heading_10"><span>2026年</span></h3><table><tbody>
<tr><td class="a-center">2026/01/01（木）</td><td class="a-center">元日</td></tr>
<tr><td class="a-center">2026/01/02（金）</td><td class="a-center">休業日</td></tr>
<tr><td class="a-center">2026/09/22（火）</td><td class="a-center">休日※</td></tr>
<tr><td class="a-center">2026/12/31（木）</td"><td class="a-center">休業日</td></tr>
</tbody></table><h3 id="heading_13"><span>2027年</span></h3><table><tbody>
<tr><td class="a-center">2027/01/01（金）</td><td class="a-center">元日</td></tr>
</tbody></table></body></html>`;
module.exports = Object.freeze({ html, bytes: new TextEncoder().encode(html) });
