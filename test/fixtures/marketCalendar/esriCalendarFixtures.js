"use strict";
const machinery = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
<table><thead><tr><th>景気動向指数速報</th><th>景気動向指数改訂状況</th><th>機械受注統計調査</th><th>消費動向調査</th></tr></thead><tbody>
<tr><td>令和8年 9月 7日<br>(7月分)</td><td>令和8年 8月25日<br>(6月分)</td><td>令和8年 9月16日<br>(7月分)</td><td>令和8年 9月 1日<br>(8月分)</td></tr>
<tr><td>10月 7日<br>(8月分)</td><td>9月29日<br>(7月分)</td><td>10月15日<br>(8月分)</td><td>10月 5日<br>(9月分)</td></tr>
<tr><td>11月 9日<br>(9月分)</td><td>10月26日<br>(8月分)</td><td>11月19日<br>(9月分)</td><td>10月29日<br>(10月分)</td></tr>
<tr><td>12月 7日<br>(10月分)</td><td>11月26日<br>(9月分)</td><td>12月16日<br>(10月分)</td><td>12月 2日<br>(11月分)</td></tr>
</tbody></table><p>機械受注統計調査は8:50公表の予定です。</p></body></html>`;
const sna = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
<h2><span id="a">四半期別GDP速報</span></h2><table><thead><tr><th>期間</th><th>公表予定日</th><th>公表時刻</th></tr></thead><tbody>
<tr><td class="txtCenter">2026年7-9月期（1次速報）</td><td>2026（令和8）年11月16日（月）</td><td class="txtCenter">8時50分</td></tr>
<tr><td class="txtCenter">2026年7-9月期（2次速報）</td><td>2026（令和8）年12月8日（火）</td><td class="txtCenter">8時50分</td></tr>
<tr><td class="txtCenter">2026年10-12月期（1次速報）</td><td>2027（令和9）年2月15日（月）</td><td class="txtCenter">8時50分</td></tr>
<tr><td class="txtCenter">2026年10-12月期（2次速報）</td><td>2027（令和9）年3月9日（火）</td><td class="txtCenter">8時50分</td></tr>
</tbody></table><h2>国民経済計算年次推計</h2><table><tr><td>2025年度</td><td>2026年12月中旬以降</td><td>-</td></tr></table></body></html>`;
module.exports = Object.freeze({ machinery, sna });
