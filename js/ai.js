

function analyzeOptionMapData(aiData) {

    console.log("ai.jsで受け取ったデータ:", aiData);

    const summary = {
        priceLevels: aiData.labels.length,
        hasNightData: aiData.nightData.length > 0,
        hasDayData: aiData.dayData.length > 0,
        hasOptionData: aiData.optionData.length > 0
    };
    
    console.log("AIデータ概要:", summary);

    let prompt = `
   【現在値】
    ${aiData.currentPrice} 円

   【価格帯】
    価格帯データ：${aiData.labels.length} 本

   【夜間手口】
    ${aiData.nightData}

   【日中手口】
    ${aiData.dayData}

   【オプション建玉】
    ${aiData.optionData}
`;
        
    prompt += `

【分析してほしいこと】

・今日の市場全体の特徴
・現在値に近い重要価格帯
・CALL壁・PUT壁の候補
・建玉の偏りから考えられる動き
・参加者別手口から読み取れる特徴
・初心者にも分かるように説明してください。
`;

console.log(prompt);

    return "✅ ai.jsにつながりました！";
}

window.analyzeOptionMapData = analyzeOptionMapData;