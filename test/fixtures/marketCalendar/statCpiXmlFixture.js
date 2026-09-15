"use strict";
const xml = `<?xml version="1.0" encoding="UTF-16" ?>
<e-stat><os_code id="00200573" name="総務省統計局">
<class_1 name="全国">
  <class_2 name="2026年8月分"><class_3><release_year>2026</release_year><release_month>9</release_month><release_day>18</release_day><release_hour>8</release_hour><release_minute>30</release_minute></class_3></class_2>
  <class_2 name="2026年平均"><class_3><release_year>2027</release_year><release_month>1</release_month><release_day>22</release_day><release_hour>8</release_hour><release_minute>30</release_minute></class_3></class_2>
  <class_2 name="2025年度平均"><class_3><release_year>2026</release_year><release_month>4</release_month><release_day>24</release_day><release_hour>8</release_hour><release_minute>30</release_minute></class_3></class_2>
  <class_2 name="2025年基準による指数　遡及結果及び接続指数"><class_3><release_year>2026</release_year><release_month>8</release_month><release_day>7</release_day><release_hour>16</release_hour><release_minute>0</release_minute></class_3></class_2>
  <class_2 name="特別集計"><class_3><release_year>2026</release_year><release_month>9</release_month><release_day>1</release_day><release_hour>14</release_hour><release_minute>0</release_minute></class_3></class_2>
</class_1>
<class_1 name="東京都区部（中旬速報値）">
  <class_2 name="2026年8月分"><class_3><release_year>2026</release_year><release_month>8</release_month><release_day>28</release_day><release_hour>8</release_hour><release_minute>30</release_minute></class_3></class_2>
</class_1>
</os_code></e-stat>`;
function utf16le(value = xml, bom = true) { const body = Buffer.from(value, "utf16le");
    return new Uint8Array(bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body); }
module.exports = Object.freeze({ xml, utf16le });
