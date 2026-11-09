"use strict";

const rawQriHtml = `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>日経225オプション</title></head>
<body>
<dl>
  <dt>最終更新時刻</dt><dd>2026/11/10 08:30</dd>
  <dt>取引日</dt><dd>2026/11/10</dd>
  <dt>取引最終日</dt><dd>2026/11/13</dd>
</dl>
<div id="futuresContractTab">
  <ul>
    <li class="active"><a href="/jpx/nkopm/?gengetsu=202611">11月限</a></li>
    <li><a href="/jpx/nkopm/1?gengetsu=202612">12月限</a></li>
  </ul>
</div>
<table>
  <tr class="row-num">
    <td>call-price</td><td>1,234</td><td></td><td></td><td></td><td></td><td></td><td></td>
    <td>45,000</td><td></td><td></td><td></td><td></td><td></td><td></td><td>2,345</td><td>put-price</td>
  </tr>
</table>
</body>
</html>`;

module.exports = Object.freeze({ rawQriHtml,
  rawQriBytes: Buffer.from(rawQriHtml, "utf8") });
