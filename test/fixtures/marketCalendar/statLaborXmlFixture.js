"use strict";
const xml = `<?xml version="1.0" encoding="UTF-16" ?>
<e-stat><os_code id="00200531" name="総務省統計局">
<class_1 name="2026年１月分">
  <class_2 name="基本集計（2026年１月分）"><class_3><release_year>2026</release_year><release_month>3</release_month><release_day>3</release_day><release_hour>8</release_hour><release_minute>30</release_minute></class_3></class_2>
</class_1>
<class_1 name="2026年３月分">
  <class_2 name="基本集計（2026年３月分）"><class_3><release_year>2026</release_year><release_month>4</release_month><release_day>28</release_day><release_hour>8</release_hour><release_minute>30</release_minute></class_3></class_2>
  <class_2 name="基本集計（2026年１～３月期平均）"><class_3><release_year>2026</release_year><release_month>4</release_month><release_day>28</release_day><release_hour>8</release_hour><release_minute>30</release_minute></class_3></class_2>
  <class_2 name="基本集計（2025年度平均）"><class_3><release_year>2026</release_year><release_month>4</release_month><release_day>28</release_day><release_hour>8</release_hour><release_minute>30</release_minute></class_3></class_2>
  <class_2 name="詳細集計（2026年１～３月期平均）"><class_3><release_year>2026</release_year><release_month>5</release_month><release_day>15</release_day><release_hour>8</release_hour><release_minute>30</release_minute></class_3></class_2>
</class_1>
<class_1 name="2026年12月分">
  <class_2 name="基本集計（2026年12月分）"><class_3><release_year>2027</release_year><release_month>1</release_month><release_day>29</release_day><release_hour>8</release_hour><release_minute>30</release_minute></class_3></class_2>
  <class_2 name="基本集計（2026年平均）"><class_3><release_year>2027</release_year><release_month>1</release_month><release_day>29</release_day><release_hour>8</release_hour><release_minute>30</release_minute></class_3></class_2>
  <class_2 name="詳細集計（2026年平均）"><class_3><release_year>2027</release_year><release_month>2</release_month><release_day>12</release_day><release_hour>8</release_hour><release_minute>30</release_minute></class_3></class_2>
</class_1>
</os_code></e-stat>`;
function utf16le(value = xml, bom = true) { const body = Buffer.from(value, "utf16le");
    return new Uint8Array(bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body); }
module.exports = Object.freeze({ xml, utf16le });
