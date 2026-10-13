"use strict";
const Must = require("./bojCoverageFixture.js");
const W = ["日", "月", "火", "水", "木", "金", "土"];
const label = (d, explicit = false) => `${explicit ? d.slice(0,4) + "年 " : ""}${Number(d.slice(5,7))}月${Number(d.slice(8))}日（${W[new Date(d + "T00:00:00Z").getUTCDay()]}）`;
const rows = { 2026: [
  ["01-22","01-23","02-02","03-25",true], ["03-18","03-19","03-30","05-07",false],
  ["04-27","04-28","05-12","06-19",true], ["06-15","06-16","06-24","08-05",false],
  ["07-30","07-31","08-10","09-28",true], ["09-17","09-18","10-01","11-05",false],
  ["10-29","10-30","11-10","12-23",true], ["12-17","12-18","12-28","2027-01-27",false]
], 2027: [
  ["01-21","01-22","02-01","03-24",true], ["03-17","03-18","03-29","05-07",false],
  ["04-27","04-28","05-12","06-16",true], ["06-10","06-11","06-21","07-27",false],
  ["07-21","07-22","07-30","09-28",true], ["09-21","09-22","10-01","11-04",false],
  ["10-28","10-29","11-09","12-22",true], ["12-16","12-17","12-27",null,false]
] };
function meetings() {
  const note = '<dl><dt>経済・物価情勢の展望（基本的見解）</dt><dd>：会合終了後直ちに</dd>' +
    '<dt>主な意見</dt><dd>：8時50分</dd><dt>議事要旨</dt><dd>：8時50分</dd></dl>';
  return '<meta charset="utf-8">' + Object.entries(rows).map(([year, dates]) => {
    const full = d => d.length === 5 ? year + '-' + d : d;
    return `<table><caption>表　${year}年</caption><thead><tr><th rowspan="2">金融政策決定会合<br>開催日および結果</th>` +
      '<th colspan="3">各資料の公表日</th><th rowspan="2">総裁定例記者会見</th></tr><tr>' +
      '<th>経済・物価情勢の展望<br>（基本的見解）</th><th>主な意見</th><th>議事要旨</th></tr></thead><tbody>' +
      dates.map(([start,end,opinion,minutes,outlook]) => `<tr><td>${label(full(start))}・${Number(end.slice(3))}日（${W[new Date(full(end) + 'T00:00:00Z').getUTCDay()]}）</td>` +
        `<td>${outlook ? label(full(end)) : '-'}</td><td>${label(full(opinion))}</td><td>${minutes ? label(full(minutes),minutes.length!==5) : '未定'}</td><td>${label(full(end))}</td></tr>`).join('') +
      '</tbody></table>' + note;
  }).join('');
}
function workbook(mutator = () => {}) {
  return Must.workbook(book => {
    const sheet = book.Sheets.統計データ;
    for (const key of ['A237','A238']) sheet[key] = { t:'s',v:'９．物価関連統計' };
    for (const key of ['B237','B238']) sheet[key] = { t:'s',v:'企業物価指数' };
    sheet.D237 = { t:'n',v:530/1440 }; sheet.D238 = { t:'s',v:'(月次)' };
    [...'EFGHIJKLMNOP'].forEach((col,i) => {
      const month = (6+i)%12+1, year = i<6?2026:2027, previous=month===1?12:month-1;
      sheet[col+'237']={t:'s',v:`(${previous}月分)`};
      sheet[col+'238']={t:'n',v:Date.UTC(year,month-1,10)/86400000+25569};
    }); mutator(book);
  });
}
function response(url) {
  if (url==='https://www.boj.or.jp/mopo/mpmsche_minu/index.htm')return new Response(meetings(),{headers:{'content-type':'text/html; charset=utf-8'}});
  if (url==='https://www.boj.or.jp/statistics/outline/tkohyos.xlsx')return new Response(workbook(),{headers:{'content-type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}});
  return Must.response(url);
}
module.exports=Object.freeze({meetings,workbook,response,shouldCount:51,totalCount:65});
